// Copyright 2026 the AAI authors. MIT license.
/**
 * The SQL each pg_cron sweep runs — the bodies, and nothing about when.
 *
 * Split from `pg-cron.ts` at the seam that file's own doc already draws: the
 * schema owns the statement, {@link platformCronJobs} owns the schedule. The
 * two halves change for different reasons and are read for different questions
 * — "what does the blob GC delete" is a hundred lines of plpgsql and an
 * argument about mark-and-sweep safety, while "how often does it run" is one
 * field in a list — and keeping them together took `pg-cron.ts` past the
 * 500-line source cap.
 *
 * **`pg-cron.ts` stays the import surface.** Nothing outside it imports from
 * here: it holds the only references to every constant below, and re-exports
 * {@link PlatformCronStorage} because that type is half of
 * `platformCronJobs`'s signature. A caller that needs a body needs the job it
 * belongs to.
 *
 * Everything that made these bodies safe to interpolate is here with them —
 * {@link assertSqlLiteralSafe} and its three call sites, and `guarded` — since
 * a guard separated from the string it guards is a guard somebody edits around.
 *
 * @internal
 */

import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/internal";
import { SLUG_LOCK_NAMESPACE } from "./platform-lock.ts";
import { SESSION_STATE_RETENTION } from "./platform-session-state.ts";
import { UPLOAD_RECORD_RETENTION } from "./platform-uploads.ts";
import { AGENT_ENV_SECRET_PREFIX, PLATFORM_STORAGE_KEY_SECRET } from "./secret-store.ts";

/**
 * Refuse a constant that cannot be interpolated into these sweep bodies.
 *
 * Two ways an innocuous constant change would break the SQL silently: a `'`
 * would close the literal it sits in, and `%` / `_` / `\` are LIKE wildcards.
 * The last one is not hypothetical here: the orphan reap's predicate is a LIKE,
 * so a `_` appearing in `PREVIEW_SLUG_SUFFIX` would silently widen it to match
 * any character in that position — and the slugs it would then reap are other
 * people's agents.
 */
function assertSqlLiteralSafe(value: string, name: string): string {
  if (/['%_\\]/.test(value)) {
    throw new Error(
      `${name} = ${JSON.stringify(value)} cannot be interpolated into the pg_cron sweeps: ` +
        "a quote would close the literal, and % / _ / \\ are LIKE wildcards.",
    );
  }
  return value;
}

// The Vault NAME the blob-GC body looks its Storage key up by.
assertSqlLiteralSafe(PLATFORM_STORAGE_KEY_SECRET, "PLATFORM_STORAGE_KEY_SECRET");
// The suffix the orphan reap's LIKE pattern ends with, and the Vault prefix it
// deletes by. Both are interpolated, because a cron command is a stored string
// and has no bind parameters.
assertSqlLiteralSafe(PREVIEW_SLUG_SUFFIX, "PREVIEW_SLUG_SUFFIX");
assertSqlLiteralSafe(AGENT_ENV_SECRET_PREFIX, "AGENT_ENV_SECRET_PREFIX");

/**
 * Wrap a sweep in a table-existence guard, for the tables migrations do not
 * own (see module doc). plpgsql only plans a statement when its branch is
 * reached, so this makes a missing table a no-op instead of an hourly error.
 */
function guarded(table: string, body: string): string {
  return `do $$
begin
  if to_regclass('${table}') is not null then
    ${body};
  end if;
end $$`;
}

/**
 * Expired rate-limit windows. A live scope reuses its row in place
 * (studio-rate-limit.ts), so an expired row is only read again to be
 * overwritten — deleting it is equivalent and keeps the table proportional
 * to recently active scopes.
 */
export const SWEEP_RATE_LIMITS =
  "delete from aai_platform.studio_rate_limits where reset_at <= now()";

/**
 * Archived preview-deploy jobs (aai-studio-server/studio-preview-queue.ts).
 * `pgmq.archive` moves a job that could not be run — unreadable payload,
 * crash loop, no resolvable credential — out of the queue and into
 * `pgmq.a_<queue>`, deliberately keeping it for inspection rather than
 * dropping it. Without a sweep that table only grows; a week is long enough
 * to notice a pattern in it and act.
 */
export const SWEEP_PREVIEW_ARCHIVE = guarded(
  "pgmq.a_aai_studio_preview",
  "delete from pgmq.a_aai_studio_preview where archived_at < now() - interval '7 days'",
);

/**
 * Session slots and events nobody has touched in the retention window.
 *
 * ONE statement for the whole fleet. The per-app version was scheduled into each
 * app's own database at provisioning time, so its cost scaled with the number of
 * tenants; this does not scale with anything.
 *
 * The window is IMPORTED from `platform-session-state.ts` rather than written here:
 * a cron command is text, so a literal would be a second copy of the retention
 * policy with nothing holding the two together. It is two days for the reason that
 * module gives: the cost of keeping a row is a few KB, and the cost of
 * dropping one early is a caller who reconnects to an agent that has forgotten
 * them.
 */
export const SWEEP_SESSION_STATE =
  `delete from aai_platform.session_slots where updated_at < now() - interval '${SESSION_STATE_RETENTION}'; ` +
  `delete from aai_platform.session_events where created_at < now() - interval '${SESSION_STATE_RETENTION}'`;

/**
 * How long a preview may sit unreferenced before it is reaped.
 *
 * An hour. A workspace row is written BEFORE its preview is deployed, so the
 * window only has to cover a deploy still in flight — not a user's idle time.
 */
const ORPHAN_PREVIEW_AGE = "1 hour";

/**
 * Reaps per pass, and the bound is about LOCK HOLD TIME rather than throughput.
 *
 * A plpgsql body is ONE transaction, so every `pg_try_advisory_xact_lock` it
 * takes is held until the body commits. Twenty is short; two thousand would mean
 * a deploy of any reaped slug queueing behind the whole pass. A backlog is
 * better worked down over several hours than in one pass that blocks deploys.
 */
const ORPHAN_PREVIEW_MAX_PER_TICK = 20;

/**
 * Studio previews nothing references any more.
 *
 * ## Why this is SQL again
 *
 * It was a cron body, moved into the server, and is back. The two reasons it
 * left are both gone: deprovisioning a per-app database needed `DROP DATABASE`,
 * which pg_cron cannot run inside its transaction (`25001`) and which needed a
 * `dblink` bridge; and once that moved to the Supabase Management API, a SQL
 * sweep was a second implementation of a step SQL could not perform. There are
 * no per-app databases, so a reap is now a Vault row and an agents row — both
 * plain SQL on this database — and `deleteAgentResources` is a slug lock around
 * one store call.
 *
 * What that leaves is a genuine duplication of the delete PATH, and it is
 * guarded rather than argued away: `pg-cron-delete-parity.test.ts` reads
 * `bundle-store.ts`'s `deleteAgent` and fails if it grows a step this body does
 * not have. Without that guard this is the "leaked, out loud" shape the sweep's
 * own history warns about — a second deleter that silently stops matching.
 *
 * ## It takes the SAME lock a deploy takes
 *
 * `pg_try_advisory_xact_lock(SLUG_LOCK_NAMESPACE, hashtext(slug))`. The two
 * advisory-lock forms share one lock space and differ only in when they release
 * (verified on PG 17.6: a `try_xact` returns false while another connection
 * holds the session-scoped `pg_advisory_lock` on the same pair), so this really
 * does exclude against `withSlugLock` — it is not a parallel lock that merely
 * looks like one. A slug whose lock is held is SKIPPED, not waited for: the next
 * pass is an hour away and a reap has no deadline, while blocking would hold the
 * transaction open behind someone else's deploy.
 *
 * ## The ROW goes LAST, deliberately
 *
 * The original SQL version deleted rows in the statement that returned them, so
 * a body dying mid-loop left the remaining slugs' resources orphaned with
 * nothing naming them. Here the agents row is the last delete for each slug, so
 * a crash anywhere before it leaves the candidate visible to the next pass. A
 * slug reaped twice is harmless — both deletes are by key.
 *
 * ## Cross-replica invalidation is unaffected
 *
 * A resident sandbox is dropped by `watchAgentInvalidation`, which rides the
 * agents table's Realtime `postgres_changes` stream. That decodes the WAL, and a
 * delete from pg_cron writes the WAL exactly as one from the app does — so the
 * signal does not care which connection issued it. (This is the one property
 * that would have made the move wrong, which is why it is stated rather than
 * assumed.)
 */
export const SWEEP_ORPHAN_PREVIEWS = `do $$
declare
  candidate text;
  reaped int := 0;
begin
  for candidate in
    select a.slug from aai_platform.agents a
    where a.slug like '%${PREVIEW_SLUG_SUFFIX}'
      and a.updated_at < now() - interval '${ORPHAN_PREVIEW_AGE}'
      and not exists (
        select 1 from aai_platform.studio_workspaces w where w.preview_slug = a.slug
      )
    order by a.updated_at
    limit ${ORPHAN_PREVIEW_MAX_PER_TICK}
  loop
    if pg_try_advisory_xact_lock(${SLUG_LOCK_NAMESPACE}, hashtext(candidate)::int) then
      delete from vault.secrets where name = '${AGENT_ENV_SECRET_PREFIX}' || candidate;
      delete from aai_platform.agents where slug = candidate;
      reaped := reaped + 1;
    end if;
  end loop;
  raise notice 'aai-sweep-orphan-previews: reaped % preview(s)', reaped;
end $$`;

/**
 * Upload records nobody will read again.
 *
 * One statement over one table, and the window is IMPORTED from
 * `platform-uploads.ts` for the reason the session-state sweep's is: a cron command
 * is text, so a literal here would be a second copy of the retention policy with
 * nothing holding the two together.
 *
 * **Seven days rather than session state's two**, because an upload is an INPUT to
 * runs that may sleep — `podcast-digest` parks for days between digests — so
 * expiring one at two days would break the workflow the retention exists to
 * support.
 *
 * It reclaims the ROW and not the bytes. Those are the bucket's, swept by
 * `aai-sweep-blob-gc` against its own rule, and the two are deliberately not
 * chained: a row deleted here is one nothing can name an object by, which is the
 * same state an upload that was never recorded is in.
 */
export const SWEEP_UPLOAD_RECORDS = `delete from aai_platform.workflow_uploads where created_at < now() - interval '${UPLOAD_RECORD_RETENTION}'`;

/**
 * The durable-workflow journal of runs that finished long ago.
 *
 * Nothing had ever deleted one. `platform-workflow-journal.ts`'s `setStatus` says
 * so in its own comment — "nothing here sweeps them the way `forgetOldTerminalRuns`
 * does in memory" — and the cost lands somewhere non-obvious: `findStalledRuns`
 * (`workflow-queue-reconcile.ts`) scans `workflow_runs` fleet-wide on EVERY
 * replica's idle tick, with no leader election, at
 * `WORKFLOW_QUEUE_INTERVAL_MS`. So a table that only grows makes the branch
 * advertised as the free one cost more every day, and it grows by exactly the rows
 * that predicate can never select.
 *
 * The BODY is a migration's
 * (`20260901020000_workflow_reconcile_cost.sql`) — one CTE that deletes a run's
 * steps, attempts, sleeps and hooks together with the run, because those tables
 * reference `agents` rather than `workflow_runs` and there is no cascade to lean
 * on. Only the SCHEDULE is here, which is the split every other sweep in this file
 * has: the schema owns the statement, `platformCronJobs` owns when it runs. It is
 * also the only split that works — pg_cron is single-database, so a
 * `select cron.schedule(...)` in a migration fails the two scenario suites that
 * apply the migration set to a throwaway database.
 *
 * **Retention is measured from the run's START**, because `created_at` is the only
 * timestamp the row carries: a run that ran for longer than the window is
 * collected sooner after finishing than a short one. Giving a run a `finished_at`
 * is the change that fixes that properly and belongs with the journal store; at
 * the function's 30-day default a workflow run spanning a month is already the
 * exception.
 *
 * Daily, and the arguments are left DEFAULTED so the window and the batch size stay
 * one number each, in the function that uses them, rather than a literal here that
 * drifts from it — the same reason `SWEEP_UPLOAD_RECORDS` imports its interval.
 */
export const SWEEP_WORKFLOW_RUNS = "select aai_platform.sweep_terminal_workflow_runs()";

/**
 * Expired studio session registrations — the same hygiene as above for the
 * studio broker's own registry (aai-studio-server/studio-session-registry.ts),
 * whose rows carry guest credentials and so should not linger past their
 * lease any longer than the sweep interval.
 */
export const SWEEP_STUDIO_SESSIONS =
  "delete from aai_platform.studio_sessions where expires_at <= now()";

/**
 * pg_cron's own run log. It records a row per job execution and Supabase
 * prunes NOTHING, so the sweeps' bookkeeping outgrows everything they sweep —
 * this is the standard way a Supabase project's largest table turns out to be
 * cron history. A week is long enough to answer "did the sweep run, and did it
 * fail" and short enough to stay small.
 */
export const SWEEP_CRON_HISTORY =
  "delete from cron.job_run_details where end_time < now() - interval '7 days'";

/**
 * Unreferenced deploy blobs.
 *
 * Blobs are content-addressed and immutable, and no referrer may delete one
 * (two agents with an identical file share a key), so nothing has ever deleted
 * them — every deploy that changes a byte writes a new ~8 MB worker bundle
 * that stays forever, including for agents since deleted and previews the
 * hourly sweep reaped. Mark-and-sweep is safe precisely BECAUSE the keys are
 * hashes: the live set is every `worker_hash` plus every value of
 * `client_files`, and a blob outside it is unreferenced by construction.
 *
 * Four things make this safe to run unattended, and each is load-bearing:
 *
 *   * **It refuses to run against an empty agents table.** Reading zero
 *     referenced hashes and deleting everything not in that set is the
 *     catastrophic failure mode, and it is one bad read away — a truncated
 *     table, a wrong database, a migration mid-flight. A platform with agents
 *     always has rows; one without has nothing worth reclaiming.
 *   * **A generous grace window.** A day is far past the retirement drain
 *     (10 min) and the signed-URL TTL (5 min), so an object cannot be swept
 *     while a spawn is still reaching for it. The cost of being slow here is
 *     storage; the cost of being fast is a failed deploy.
 *   * **Bounded per run.** 500 deletes an hour reclaims steadily without
 *     turning one sweep into a stampede against the Storage API.
 *   * **The delete goes through the Storage API, never `storage.objects`.**
 *     Deleting the row leaves the S3 object behind AND removes the only record
 *     that it exists — strictly worse than doing nothing. `pg_net` is how a
 *     SQL job calls an API, and it is fire-and-forget: a failed delete simply
 *     leaves the object for the next run to find, so the sweep is
 *     self-healing without any retry bookkeeping.
 *
 * Everything is guarded so a project without `pg_net`, without Vault, or
 * without the stored key no-ops rather than erroring hourly.
 */
export function sweepBlobGc(storage: { url: string; bucket: string }): string {
  const base = storage.url.replace(/\/+$/, "");
  return `do $$
declare
  target record;
  storage_key text;
  live_agents bigint;
begin
  if to_regnamespace('net') is null or to_regclass('storage.objects') is null then
    return;
  end if;
  if to_regclass('vault.secrets') is null then
    return;
  end if;
  select decrypted_secret into storage_key from vault.decrypted_secrets
    where name = '${PLATFORM_STORAGE_KEY_SECRET}';
  if storage_key is null then
    return;
  end if;
  -- The empty-table guard. Never derive "unreferenced" from a set that may
  -- simply have failed to load.
  select count(*) into live_agents from aai_platform.agents;
  if live_agents = 0 then
    return;
  end if;
  for target in
    with referenced as (
      select worker_hash as hash from aai_platform.agents
      union
      select f.value from aai_platform.agents a, jsonb_each_text(a.client_files) f
    )
    select o.name
    from storage.objects o
    where o.bucket_id = '${storage.bucket}'
      and o.name like 'blobs/%'
      and o.created_at < now() - interval '1 day'
      and not exists (
        select 1 from referenced r where r.hash = substring(o.name from 7)
      )
    limit 500
  loop
    perform net.http_delete(
      url := '${base}/storage/v1/object/${storage.bucket}/' || target.name,
      headers := jsonb_build_object(
        'apikey', storage_key,
        'Authorization', 'Bearer ' || storage_key
      )
    );
  end loop;
end $$`;
}

/** Where deploy blobs live, when this deployment has object storage at all. */
export type PlatformCronStorage = {
  /** Supabase project URL (`https://<ref>.supabase.co`). */
  url: string;
  /** The deploy-artifact bucket. */
  bucket: string;
};
