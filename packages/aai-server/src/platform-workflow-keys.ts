// Copyright 2026 the AAI authors. MIT license.
/**
 * The correlation-key index, on the platform's own database.
 *
 * This is what makes a DEPLOYED run findable by the caller who started it. The
 * index's other two backends are a `Map` and a table in the agent's own
 * `DATABASE_URL`; the platform provisions no tenant database, so before this a
 * deployed agent's index was the `Map` — inside a sandbox that self-exits after
 * `AGENT_IDLE_EXIT_MS`. The RUN survived (the journal is durable since
 * `platform-workflow-journal.ts`), the only pointer to it did not, so the next
 * call found nothing and the agent started a second run for a caller it had
 * already served. Silent by construction: an empty index and a caller with no
 * prior run are the same answer.
 *
 * ## Tenancy is in the KEY, so there is no check to forget
 *
 * The slug leads the primary key, is the first parameter of both statements
 * below, and comes from the per-sandbox bearer rather than from the request. A
 * guessed run id therefore reaches nothing, and a lookup cannot be pointed at
 * another agent's rows: there is no query here without `slug = $1`. Same design
 * as `platform-session-state.ts` and `platform-workflow-journal.ts`.
 *
 * ## Two statements, mirroring `aai-runtime/workflow-keys.ts`, deliberately
 *
 * That module holds the self-hosted store, and the three backends agreeing is
 * what lets the memory one be a valid double for the other two
 * (`workflow-keys-conformance.ts` there is the shared case list). Three of its
 * choices are load-bearing and reproduced here with their reasons:
 *
 * - **`on conflict … do nothing`, keyed on the RUN.** A run id is unique by
 *   construction, so a second `record` naming one is a retried call after a lost
 *   connection rather than a new fact — it must be a no-op, not an error the tool
 *   call surfaces and not a second row. Both drifts the conformance table found
 *   were this clause missing from the memory store: a retry LISTED the run twice
 *   and PROMOTED it past a newer one.
 * - **`order by created_at desc, run_id desc`.** "Newest first" is the interface's
 *   promise, and the tiebreak is what makes it true for two runs recorded in the
 *   same millisecond — a run id is a ULID, so it sorts by generation time. The
 *   lookup index carries the same two columns, so an index scan answers correctly
 *   even for a query that never asked; the clause earns its place on any plan that
 *   has to SORT, which is what `aai-runtime`'s own suite forces by disabling index
 *   scans.
 * - **`limit $4` as a bind parameter**, bounded at the ROUTE
 *   (`MAX_WORKFLOW_KEY_LOOKUP_LIMIT` in `workflow-keys-handler.ts`) and not
 *   re-checked here: one policy, at the boundary the untrusted value crosses,
 *   rather than a second copy that can disagree with it.
 *
 * ## `created_at` is the ENGINE's clock, and this module never invents one
 *
 * It arrives on the request as epoch milliseconds, the way `wakeSleeps`'s `now`
 * does, because the ordering the index promises is "the order they were started"
 * and the engine is what started them. A `now()` here would be a second clock in
 * the one value the ordering rests on — and would disagree with
 * `workflow_runs.created_at`, which the journal already takes from the engine.
 *
 * ## No refusal, unlike `createRun`
 *
 * The journal's `createRun` authors a `PlatformWorkflowRunTakenError` off a
 * `returning` because its interface REJECTS a duplicate run id. This interface
 * does the opposite — `record` is idempotent and first-write-wins — so there is
 * nothing to detect and no error to map: `do nothing` really is the answer, and a
 * `returning` here would only tempt a caller into reading a refusal the other two
 * backends do not make.
 *
 * @internal
 */

import type { SqlExec } from "./secret-store.ts";

/**
 * Where the index lives. Spelled once.
 *
 * Its own name rather than a shared constant with `aai-runtime`'s
 * `WORKFLOW_KEYS_TABLE`: that one is the SELF-HOSTED table in an app's own schema
 * (`aai_workflow_run_keys`, created lazily by the store itself), where this is the
 * platform's, created by a migration and slug-scoped. Two tables, two names, one
 * contract.
 */
const KEYS = "aai_platform.workflow_run_keys";

/**
 * Note that `runId` was started for `key`, or leave the recorded row alone.
 *
 * Answers nothing. `void` and not a boolean, because the interface above promises
 * only that the run is indexed afterwards — and "did this call insert it or was it
 * already there" is a distinction the memory and self-hosted stores do not make
 * either.
 */
export async function recordKey(
  sql: SqlExec,
  slug: string,
  // A record rather than four positionals, for the reason `createRun`'s is one:
  // four adjacent strings in a call are four chances to transpose two of them, and
  // the compiler cannot see it.
  entry: { runId: string; workflow: string; key: string; createdAt: number },
): Promise<null> {
  await sql(
    `insert into ${KEYS} (slug, run_id, workflow, key, created_at)
     values ($1, $2, $3, $4, $5)
     on conflict (slug, run_id) do nothing`,
    [slug, entry.runId, entry.workflow, entry.key, entry.createdAt],
  );
  // `null` rather than `undefined`: the route answers JSON, and `{ result:
  // undefined }` serializes to `{}` — an envelope `platformResult` reads as a
  // contract change rather than as a successful write.
  return null;
}

/** Run ids this agent started for `key`, newest first, at most `limit`. */
export async function lookupKey(
  sql: SqlExec,
  slug: string,
  workflow: string,
  key: string,
  limit: number,
): Promise<string[]> {
  const rows = await sql(
    `select run_id from ${KEYS}
      where slug = $1 and workflow = $2 and key = $3
      order by created_at desc, run_id desc
      limit $4`,
    [slug, workflow, key, limit],
  );
  // Coerced through a filter rather than `String(row.run_id)`: the column is
  // `text not null`, so a non-string here would mean the query changed shape, and
  // inventing `"undefined"` for it would put a run id nothing can read into a
  // caller's `find`.
  return rows.flatMap((row) => (typeof row.run_id === "string" ? [row.run_id] : []));
}
