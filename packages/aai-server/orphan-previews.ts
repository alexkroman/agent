// Copyright 2026 the AAI authors. MIT license.
/**
 * Reclaim the studio previews nothing references any more — a studio project
 * whose workspace is gone, or whose preview slug moved, leaves a deployed
 * `*-preview` agent behind with its own database, role and Vault secrets.
 *
 * **This ran in pg_cron until per-app databases moved to the Management API, and
 * that is why it moved out.** The job body deprovisioned in SQL, which needs
 * `drop database` — a statement pg_cron cannot run, because it wraps every body
 * in a transaction (`25001`). The bridge was `dblink`: a second connection, so
 * the drop lands outside the caller's transaction. It worked, and the migration
 * that installed it (`20260817000000_dblink_admin.sql`) argued against a
 * server-side timer on the grounds that detection and reclamation should live in
 * one place that survives a replica dying.
 *
 * That trade stopped being the same one when deprovisioning moved to the
 * Management API, and it is moot now: there are no per-app databases to drop at
 * all, so a preview leaves behind a row and its Vault secret and nothing else. The
 * three reasons the SQL sweep was the weaker implementation are kept because they
 * are why this calls the delete route rather than reimplementing it:
 *
 * - **Primary cluster only.** pg_cron runs in the platform database, so an app
 *   placed on another placement cluster had no local database to drop and the
 *   statement silently no-op'd. It reclaimed nothing on any sharded fleet.
 * - **It leaked, out loud.** With no admin DSN resolvable it deleted the row and
 *   the secrets and raised a warning naming the database it was abandoning —
 *   tenant data with its only credential gone. That failure is the reason a
 *   legacy `app-db:<slug>` secret is not swept by anything either; see
 *   `bundle-store.ts`.
 * - **It re-implemented the delete route.** Row, secrets, database, in SQL,
 *   beside `deleteAgentResources`, which does the same things and takes the slug
 *   lock while doing them.
 *
 * So this calls THAT — one delete path, the same one `DELETE /:slug` and the
 * studio's project delete use. The cost is the one the migration named: a reap
 * needs a live replica. The wake sweep already made the fleet depend on that for
 * a comparable background job, and a fleet with no live replica is not creating
 * previews either.
 *
 * **Candidates are SELECTED, not deleted, and the row goes LAST.** The SQL
 * version deleted the rows in the statement that returned them, so a body that
 * died mid-loop left every remaining slug's database orphaned with nothing
 * naming it. Here the row is what `deleteAgentResources` removes at the end of a
 * successful reap, so a crash anywhere before that leaves the candidate visible
 * to the next pass. A slug reaped twice is harmless: the drops are `if exists`
 * and the row is already gone.
 *
 * The constants live here rather than in `constants.ts` because that file is at
 * its line cap and none of these is a term in the connection budget it exists to
 * hold.
 */

import { errorMessage } from "@alexkroman1/aai";
import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/internal";
import { createIntervalSweep } from "./_interval-sweep.ts";
import type { HonoEnv } from "./context.ts";
import { deleteAgentResources } from "./delete.ts";
import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("orphan-previews");

/**
 * The slice of `AdminDb` this sweep needs: ONE reserved connection and its
 * release, because a try-lock needs connection affinity.
 *
 * Declared here rather than taking `AdminDb` whole so a fake can be written
 * plainly — that type's `query` is generic, and satisfying it in a test means
 * laundering the rows through a cast (`workflow-wake.test.ts` reaches for
 * `as never` to do it). The real `AdminDb` satisfies this structurally, since a
 * generic function is assignable to one of its instantiations.
 */
export type LeaderDb = { reserve(): Promise<{ query: SqlExec; release(): void }> };

/**
 * Advisory-lock namespace for this sweep — distinct from the wake sweep's and
 * from the slug lock's for the reason `WORKFLOW_WAKE_NAMESPACE` gives: sharing
 * one makes two unrelated operations serialize, and here it would read as "the
 * reap never runs while anything is deploying".
 */
export const ORPHAN_PREVIEW_NAMESPACE = 0x41_41_49_03;

/** One global operation, so the second key slot is a constant. */
const ORPHAN_PREVIEW_LOCK_KEY = 1;

/** Hourly, the cadence the pg_cron job had. */
const ORPHAN_PREVIEW_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a preview may sit unreferenced before it is reaped. An hour, as the
 * SQL version used: a workspace is written before its preview is deployed, so
 * the window only has to cover a deploy that is still in flight.
 */
const ORPHAN_PREVIEW_AGE = "1 hour";

/**
 * Reaps per pass. A bound because each one takes the slug lock and issues a
 * control-plane call, and a backlog is better worked down over several hours
 * than in one pass that holds a lock for minutes.
 */
const ORPHAN_PREVIEW_MAX_PER_TICK = 20;

const TRY_LOCK_SQL = "select pg_try_advisory_xact_lock($1::int, $2::int) as locked";

/**
 * Aged `*-preview` agents no workspace points at.
 *
 * Bind parameters, which the pg_cron version could not use: a cron command is a
 * stored string, so the suffix and both Vault prefixes had to be interpolated
 * into it behind a literal-safety assertion. Here they are values.
 */
const CANDIDATES_SQL = `select a.slug from aai_platform.agents a
where a.slug like $1
  and a.updated_at < now() - interval '${ORPHAN_PREVIEW_AGE}'
  and not exists (
    select 1 from aai_platform.studio_workspaces w where w.preview_slug = a.slug
  )
order by a.updated_at
limit $2`;

/** What `deleteAgentResources` needs, and nothing more. */
type ReapEnv = Pick<HonoEnv["Bindings"], "secrets" | "slugLock" | "store">;

export type OrphanPreviewSweep = {
  /** One pass. `swept: false` means another replica holds the leader lock. */
  sweepOnce(): Promise<{ swept: boolean; reaped: string[]; failed: string[] }>;
  /** Start the interval; the returned function stops it. */
  start(intervalMs?: number): () => void;
};

export function createOrphanPreviewSweep(opts: {
  /** Leader election needs connection affinity, so it runs on a reserved one. */
  adminDb: LeaderDb;
  env: ReapEnv;
  maxPerTick?: number;
  /** Test seam — production reaps through `deleteAgentResources`. */
  reap?: (slug: string) => Promise<void>;
}): OrphanPreviewSweep {
  const maxPerTick = opts.maxPerTick ?? ORPHAN_PREVIEW_MAX_PER_TICK;
  const reap = opts.reap ?? ((slug: string) => deleteAgentResources(opts.env, slug));

  /**
   * The candidate read, under the leader lock.
   *
   * The lock covers the READ only. Reaping after the commit is deliberate: each
   * reap takes the slug lock and calls the control plane, and holding a reserved
   * admin connection across that is exactly what `platform-lock.ts` warns about.
   * Two replicas can therefore both see one candidate on interleaved ticks —
   * harmless, since the second reap finds `if exists` drops and a deleted row.
   */
  async function candidates(): Promise<string[] | undefined> {
    const reserved = await opts.adminDb.reserve();
    try {
      await reserved.query("begin");
      try {
        const lock = await reserved.query(TRY_LOCK_SQL, [
          ORPHAN_PREVIEW_NAMESPACE,
          ORPHAN_PREVIEW_LOCK_KEY,
        ]);
        if (lock[0]?.locked !== true) return undefined;
        const rows = await reserved.query(CANDIDATES_SQL, [`%${PREVIEW_SLUG_SUFFIX}`, maxPerTick]);
        return rows.map((row) => String(row.slug));
      } finally {
        // Commit or rollback both release the lock; commit is the honest one for
        // a read-only transaction and is safe after an aborted statement.
        await reserved.query("commit").catch(() => undefined);
      }
    } finally {
      reserved.release();
    }
  }

  async function sweepOnce(): Promise<{ swept: boolean; reaped: string[]; failed: string[] }> {
    const due = await candidates();
    if (due === undefined) return { swept: false, reaped: [], failed: [] };
    const reaped: string[] = [];
    const failed: string[] = [];
    for (const slug of due) {
      // Serially, and one failure never stops the rest: a cluster that will not
      // answer must not park every other orphan behind it. The next pass sees
      // the failures again, because their rows are still there.
      try {
        await reap(slug);
        reaped.push(slug);
      } catch (err) {
        failed.push(slug);
        log.warn("reap failed", { slug, error: errorMessage(err) });
      }
    }
    if (due.length > 0) {
      log.info("reaped orphaned previews", { candidates: due.length, reaped: reaped.length });
    }
    return { swept: true, reaped, failed };
  }

  // Serialized rather than overlapped, and unref'd — see `_interval-sweep.ts`.
  // A pass that outruns its interval would queue reaps behind each other and
  // re-read the same candidates.
  const ticker = createIntervalSweep(sweepOnce);

  return {
    sweepOnce,
    start: (intervalMs = ORPHAN_PREVIEW_INTERVAL_MS) => ticker.start(intervalMs),
  };
}

/**
 * Wire the sweep into a composition, or say why it is not wired — both branches
 * speak, for the reason `startWorkflowWakeSweep` gives: a reclamation job that
 * silently never runs is indistinguishable from one with nothing to do.
 */
export function startOrphanPreviewSweep(opts: {
  adminDb?: LeaderDb | undefined;
  intervalMs?: number;
  store: ReapEnv["store"];
  /**
   * Both optional at the composition, and both REQUIRED to reap: the secrets are
   * what a reap deletes, and the lock is what stops a reap racing a deploy of the
   * same slug. A composition missing either has no platform database, and
   * therefore no `aai_platform.agents` to read candidates from.
   */
  secrets?: ReapEnv["secrets"] | undefined;
  slugLock?: ReapEnv["slugLock"] | undefined;
}): () => void {
  const intervalMs = opts.intervalMs ?? ORPHAN_PREVIEW_INTERVAL_MS;
  const { adminDb, secrets, slugLock } = opts;
  if (!(adminDb && secrets && slugLock) || intervalMs <= 0) {
    log.debug("Orphan-preview sweep not started", {
      reason: adminDb && secrets && slugLock ? "interval is 0" : "no platform database",
    });
    return () => undefined;
  }
  log.info(`reaping unreferenced ${PREVIEW_SLUG_SUFFIX} agents every ${intervalMs}ms`);
  return createOrphanPreviewSweep({
    adminDb,
    env: { store: opts.store, secrets, slugLock },
  }).start(intervalMs);
}
