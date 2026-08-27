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
  throw new Error(`run ${runId} is already owned by another agent`);
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
 * This agent's run ids, newest first.
 *
 * What `runs.list` is scoped to. The LIMIT is the caller's, and it is required
 * rather than defaulted: a list route with an implicit ceiling is one that
 * silently truncates, and the DevKit's own list takes a page size.
 */
export async function runIdsFor(sql: SqlExec, slug: string, limit: number): Promise<string[]> {
  const rows = await sql(
    `select run_id from aai_platform.workflow_run_owner
      where slug = $1
      order by created_at desc, run_id desc
      limit $2`,
    [slug, limit],
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
