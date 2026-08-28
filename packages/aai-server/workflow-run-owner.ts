// Copyright 2026 the AAI authors. MIT license.
/**
 * Which agent owns a durable run — the tenant boundary for platform-owned run
 * storage.
 *
 * The DevKit's schema has no tenant column. It is written for one application per
 * database, and its SQL is schema-qualified, so running it once on the platform's
 * database puts every agent's runs in one `workflow.workflow_runs`. That is the
 * price of reusing their state machine instead of reimplementing it — and it is
 * worth paying, because `events.create` alone is a thousand lines of transactional
 * dispatch over sixteen event types, including the row-locked guarded UPDATE that
 * makes concurrent step starts safe.
 *
 * So the separation lives here instead. Every tenant-facing storage call is scoped
 * through this table: a slug's runs are the run ids recorded against it, and
 * nothing else is reachable through the HTTP surface. Two properties make that
 * sound:
 *
 * - **A run is claimed at creation**, in the same request that creates it, so
 *   there is no window in which a run exists and is unowned.
 * - **Ownership is checked on the way IN, not filtered on the way out.** A read
 *   for a run this slug does not own is answered 404 before the DevKit is asked
 *   anything, so a bug in a projection query cannot leak across tenants.
 *
 * Run ids are ULIDs, so the unscoped surface is not guessable either. That is
 * defence in depth, not the boundary: this table is the boundary.
 */

import { createLogger } from "./logger.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("workflow.owner");

/**
 * A claim this table refuses.
 *
 * TYPED, because the HTTP layer has to answer 404 for it and a bare `Error`
 * reaches the shared handler as a 500 — which both leaks that the run exists and
 * breaks the never-403 rule this module's doc argues. Two causes, deliberately
 * indistinguishable to the caller: the run belongs to another agent, or it
 * belongs to nobody but already exists.
 */
export class RunClaimRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunClaimRefusedError";
  }
}

/**
 * Record that `slug` owns `runId`.
 *
 * Idempotent, because the DevKit may replay a `run_created` event: a durable run
 * that is retried at its very first step re-enters the same code path, and a
 * second claim must not fail the retry.
 *
 * A conflict on a run already owned by a DIFFERENT slug is not idempotent though —
 * it is either a ULID collision (which does not happen) or a bug that would hand
 * one tenant another's run. `on conflict do nothing` would swallow it, so the
 * insert reports what it did and {@link claimRun} decides.
 */
export async function claimRun(sql: SqlExec, runId: string, slug: string): Promise<void> {
  const rows = await sql(
    `insert into aai_platform.workflow_run_owner (run_id, slug)
     values ($1, $2)
     on conflict (run_id) do nothing
     returning slug`,
    [runId, slug],
  );
  if (rows.length > 0) return;

  // Nothing inserted: the run is already claimed. By whom decides whether this is
  // a replay or a fault.
  const existing = await ownerOf(sql, runId);
  if (existing === slug) return;
  // LOUD, and it throws. A run cannot change hands: whichever tenant created it
  // is the only one that may ever read it, and answering "fine" here would make
  // that untrue for the rest of the run's life.
  log.warn("refused to reassign a run", { runId, from: existing ?? "(none)", to: slug });
  throw new RunClaimRefusedError(`run ${runId} is already owned by another agent`);
}

/**
 * Claim a run id the CALLER chose, for a run that does not exist yet.
 *
 * The pre-create half of {@link claimRun}, and it exists because ownership rows
 * and the DevKit's journal have different lifetimes. `workflow_run_owner.slug`
 * cascades on agent delete while the `workflow.*` rows deliberately survive (see
 * `20260827010000_workflow_run_owner.sql`), so a deleted agent leaves runs that
 * EXIST and are owned by NOBODY. `claimRun` treats an absent ownership row as
 * free and would hand those to whoever names the id — which turns the migration's
 * "unreachable, not visible to anyone" into "readable by the next caller who asks",
 * unlocking the previous tenant's step arguments, step results, event journal and
 * hook tokens.
 *
 * So a caller-supplied id may be claimed only when there is no run behind it. The
 * `not exists` and the insert are ONE statement, so a run created between a check
 * and an insert cannot slip through the gap.
 *
 * A REPLAY still works: the DevKit may re-send `run_created` when a run is retried
 * at its first step, and there the run does exist — the insert is suppressed and
 * the owner lookup below finds this same slug, which returns cleanly.
 *
 * Note this reads `workflow.workflow_runs` (primary key `id`), the DevKit's own
 * table. That is a deliberate reach across into their schema: it is the only
 * record of whether a run exists, and this platform is the one that put their
 * schema and its ownership table in the same database.
 */
export async function claimNewRun(sql: SqlExec, runId: string, slug: string): Promise<void> {
  const rows = await sql(
    `insert into aai_platform.workflow_run_owner (run_id, slug)
     select $1, $2
     where not exists (select 1 from workflow.workflow_runs where id = $1)
     on conflict (run_id) do nothing
     returning slug`,
    [runId, slug],
  );
  if (rows.length > 0) return;

  const existing = await ownerOf(sql, runId);
  if (existing === slug) return;
  if (existing !== undefined) {
    log.warn("refused to reassign a run", { runId, from: existing, to: slug });
    throw new RunClaimRefusedError(`run ${runId} is already owned by another agent`);
  }
  // No owner and nothing inserted: the run already exists and its ownership row
  // is gone. An ORPHAN — see the module note above — and the one case this
  // function exists for.
  log.warn("refused to adopt an orphaned run", { runId, to: slug });
  throw new RunClaimRefusedError(`run ${runId} already exists and cannot be claimed`);
}

/** The slug that owns `runId`, or undefined when nothing does. */
export async function ownerOf(sql: SqlExec, runId: string): Promise<string | undefined> {
  const rows = await sql("select slug from aai_platform.workflow_run_owner where run_id = $1", [
    runId,
  ]);
  const slug = rows[0]?.slug;
  return typeof slug === "string" ? slug : undefined;
}

/**
 * Does `slug` own `runId`?
 *
 * The gate every scoped read goes through. An unowned run answers FALSE rather
 * than throwing: a run the platform has never seen and a run belonging to someone
 * else are the same answer to the caller, and telling them apart would say whether
 * a run id exists.
 */
export async function ownsRun(sql: SqlExec, runId: string, slug: string): Promise<boolean> {
  return (await ownerOf(sql, runId)) === slug;
}

/**
 * Which of `runIds` does `slug` own?
 *
 * The BATCH form of {@link ownsRun}, and the one every caller with more than one
 * id in hand should reach for: one round trip however many ids, against a
 * connection reserved out of a pool of `ADMIN_POOL_MAX`. Two callers had grown
 * their own — the egress check wrote this `select` inline, which put a second
 * owner on this table's schema, and `scopeFilterRuns` awaited `ownsRun` once per
 * item of a page, which is a round trip per event.
 *
 * Returns the subset that is ours, so a caller filters (`has`) or detects a
 * breach (a missing id) off the same answer. An unowned run is simply absent, for
 * the reason {@link ownsRun} answers false rather than throwing.
 */
export async function ownsRuns(
  sql: SqlExec,
  runIds: readonly string[],
  slug: string,
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await sql(
    `select run_id from aai_platform.workflow_run_owner
      where slug = $1 and run_id = any($2::text[])`,
    [slug, [...runIds]],
  );
  return new Set(rows.flatMap((r) => (typeof r.run_id === "string" ? [r.run_id] : [])));
}

/**
 * This agent's run ids, newest first.
 *
 * What `runs.list` is scoped to. The LIMIT is the caller's, and it is required
 * rather than defaulted: a list route with an implicit ceiling is one that
 * silently truncates, and the DevKit's own list takes a page size.
 *
 * `offset` is what lets `runs.list` SCAN. This table holds ownership and nothing
 * else — no `workflowName`, no `status` — so the caller's filters can only be
 * applied after each run's record is fetched, and a filtered page therefore has
 * to walk further than one batch. The ordering is total (`run_id` breaks ties on
 * `created_at`), which is what makes a walk by offset coherent rather than a
 * source of duplicates and gaps.
 */
export async function runIdsFor(
  sql: SqlExec,
  slug: string,
  limit: number,
  offset = 0,
): Promise<string[]> {
  const rows = await sql(
    `select run_id from aai_platform.workflow_run_owner
      where slug = $1
      order by created_at desc, run_id desc
      limit $2 offset $3`,
    [slug, limit, offset],
  );
  return rows.flatMap((r) => (typeof r.run_id === "string" ? [r.run_id] : []));
}

/**
 * Forget every run of one agent.
 *
 * Called by the agent-delete path. It does NOT remove the DevKit's own rows in
 * `workflow.*` — see the migration's note: reaping those needs a walk of five
 * tables in dependency order, and it belongs with the tenant-database teardown.
 * Dropping ownership first is still right, because it is what makes the rows
 * unreachable.
 */
export async function forgetRunsOf(sql: SqlExec, slug: string): Promise<number> {
  const rows = await sql(
    "delete from aai_platform.workflow_run_owner where slug = $1 returning run_id",
    [slug],
  );
  return rows.length;
}
