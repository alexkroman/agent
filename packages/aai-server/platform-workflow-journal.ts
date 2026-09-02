// Copyright 2026 the AAI authors. MIT license.
/**
 * The replay engine's journal, on the platform's own database.
 *
 * This is what makes a DEPLOYED durable run durable. The engine's other two
 * backends are a `Map` and a store over the agent's own `DATABASE_URL`; the
 * platform provisions no tenant database, so before this every deployed run kept
 * its journal in a sandbox that self-exits after `AGENT_IDLE_EXIT_MS`. A step's
 * result, its attempt count and an open approval window died with it, and the run
 * simply never resumed — no error, no log line, nothing to debug from.
 *
 * ## Tenancy is in the KEY, so there is no check to forget
 *
 * The slug is the first column of every primary key and the first parameter of
 * every statement below, taken from the per-sandbox bearer and never from the
 * request. A guessed run id therefore reaches nothing: there is no query here that
 * can be pointed at another agent's rows. Same design as `platform-session-state.ts`;
 * A `workflow_run_owner` mapping table used to carry this beside the DevKit's
 * journal, whose fixed schema had no such column. Both are gone.
 *
 * ## The statements mirror `workflow-journal-schema.ts`, deliberately
 *
 * That is the self-hosted store, and the two being one contract is what lets a
 * scenario test over either be evidence about both. Four of its choices are
 * load-bearing and reproduced here with their reasons:
 *
 * - **Every jsonb binding is `::text::jsonb`.** postgres.js JSON-serializes a
 *   parameter bound to a jsonb position, so handing it the codec's already-encoded
 *   text stores a JSON *string* containing the JSON — after which a run's `input`
 *   reads back as text and a `Uint8Array` envelope never revives. It shipped once
 *   and only a real server found it.
 * - **`claimAttempt` is ONE statement.** Read-then-increment lets two concurrent
 *   deliveries read the same number and take a step past its ceiling.
 * - **`setStatus` is a compare-and-set**, answering from the row count, so a
 *   worker that had not noticed a cancel cannot report the run completed.
 * - **`appendStep` and `claimSleep` are `do nothing` then READ BACK.** The first
 *   write wins and every later one is a read, which is what stops a replay
 *   pushing a deadline further out on each walk, and what makes two executions
 *   that both ran a step agree on what it returned.
 * - **`createRun` is `do nothing` then `returning`, which is a REFUSAL.** The one
 *   place the mechanism deliberately differs from the twin: there, a duplicate run
 *   id trips the primary key and the driver's error is the refusal, which is not
 *   available here — a raw SQLSTATE crossing `withReserved` is a retryable 503,
 *   and the guest would spend a message's whole attempt budget on a condition that
 *   cannot change. The CONTRACT is the same on all three backends (`createRun`
 *   rejects a taken id); only this one authors its own error. Do not "restore" the
 *   parity by deleting the `returning` — that is the bug, and
 *   `journal-conformance-platform.scenario.test.ts` is what catches it now.
 *
 * ## `jsonb` NORMALIZES, so a value survives by MEANING and not by bytes
 *
 * `{"topic":"otters"}` is stored and read back as `{"topic": "otters"}`. That is
 * what the column being `jsonb` buys — it parses on write, which is the check the
 * process above cannot fake — and the cost is that the exact serialization the
 * codec produced is not the one that comes back.
 *
 * Harmless, because `decodeStorageJson` parses; worth writing down, because the
 * MEMORY journal does preserve bytes, so the two differ on something a spec might
 * reasonably assert. `platform-workflow-journal.scenario.test.ts` compares by
 * meaning for exactly this reason, and `platform-session-state.ts` records the
 * same property one table over.
 *
 * @internal
 */

import { HOOKS } from "./platform-workflow-journal-hooks.ts";
import type { SqlExec } from "./secret-store.ts";

// One hook WINDOW is its own module — five hundred lines is the cap and the hook
// half is a self-contained subject. Re-exported so the route above still reaches
// one journal, and so a caller cannot come to depend on which file a method is in.
export {
  claimHook,
  closeHook,
  deliverHook,
  type JournalHookRow,
  PlatformWorkflowHookTokenError,
} from "./platform-workflow-journal-hooks.ts";
// The SLEEP half likewise, and it moved for the same reason the hooks did — the
// `started_at` column took this file past the cap. Nothing here reaches that
// table (the release CTE only touches `HOOKS`), which is what made the sleeps
// the cleanest family to move.
export {
  claimSleep,
  type JournalSleepRow,
  SLEEPS,
  wakeSleeps,
} from "./platform-workflow-journal-sleeps.ts";

/**
 * Statuses nothing will change again.
 *
 * Spelled here rather than imported from the runtime's `TERMINAL_WORKFLOW_STATUSES`
 * because this module takes `status` as a plain `string` — it is the platform's
 * side of an HTTP boundary, where the value arrived over the wire and the union is
 * the runtime's to police. `platform-workflow-journal.test.ts` pins the two equal.
 */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * Where the journal lives. One schema-qualified name per table, spelled once.
 *
 * Two are exceptions and live with the operations that own them: `HOOKS`
 * (`platform-workflow-journal-hooks.ts`) and `SLEEPS`
 * (`platform-workflow-journal-sleeps.ts`), both re-exported below so a caller
 * still sees one journal. `HOOKS` is additionally imported BACK, for
 * `setStatus`'s release CTE — the one statement here that reaches another
 * family's table. `SLEEPS` is not, and the asymmetry is the tell that the sleeps
 * were the cleanest family to move: nothing here reaches them.
 */
const RUNS = "aai_platform.workflow_runs";
const STEPS = "aai_platform.workflow_steps";
const ATTEMPTS = "aai_platform.workflow_attempts";

/**
 * `bigint` arrives as a STRING from the driver, and `Number` is the read.
 *
 * Left alone every comparison against a deadline is lexicographic and every
 * arithmetic one is concatenation — both silent. Epoch milliseconds are far under
 * 2^53, so the conversion is exact for any date this will see.
 */
const millis = (value: unknown): number => Number(value);

/** A stored value, as the codec wrote it. `null` from the driver means absent. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** One run, as this store answers it. Encoded values stay encoded. */
export type JournalRunRow = {
  runId: string;
  workflow: string;
  status: string;
  createdAt: number;
  input: string | undefined;
  output: string | undefined;
  error: string | undefined;
  /**
   * The bundle the run was started against, absent off the platform and for a
   * row that predates the column — see `RunRecord.codeVersion` in
   * `@alexkroman1/aai-runtime/internal`, which is the shape this crosses the
   * wire as.
   */
  codeVersion: string | undefined;
};

/** One settled step. */
export type JournalStepRow = {
  key: string;
  name: string;
  status: string;
  output: string | undefined;
  error: string | undefined;
  attempts: number;
  /**
   * Absent for a row written before the column existed — see
   * `StepEntry.startedAt` in `@alexkroman1/aai-runtime/internal`, which is the
   * shape this row crosses the wire as.
   */
  startedAt: number | undefined;
  finishedAt: number;
};

function toRun(row: Record<string, unknown>): JournalRunRow {
  return {
    runId: String(row.run_id),
    workflow: String(row.workflow),
    status: String(row.status),
    createdAt: millis(row.created_at),
    input: text(row.input),
    output: text(row.output),
    error: text(row.error),
    codeVersion: text(row.code_version),
  };
}

function toStep(row: Record<string, unknown>): JournalStepRow {
  return {
    key: String(row.key),
    name: String(row.name),
    status: String(row.status),
    output: text(row.output),
    error: text(row.error),
    attempts: Number(row.attempts),
    // `millis` coerces, so NULL would become 0 — which reads as the epoch and
    // then as a step that took 55 years. The column is nullable by construction
    // (the rows already there have no start), so the null test comes first.
    startedAt:
      row.started_at === null || row.started_at === undefined ? undefined : millis(row.started_at),
    finishedAt: millis(row.finished_at),
  };
}

/**
 * Raised when a run id is already taken.
 *
 * `JournalStore.createRun` promises to REJECT a duplicate — the memory backend
 * throws and the self-hosted store trips its primary key — and this store's
 * `on conflict … do nothing` was the one arm that answered success. Two racing
 * starts on one id therefore both believed they had won and the loser's `input`
 * was discarded, on the platform arm only, i.e. for every deployed agent. The
 * conformance suite could not see it: its platform arm is a fake transport over
 * the memory reference, which its own header says.
 *
 * Its own class rather than a plain `Error`, for exactly the reason
 * {@link PlatformWorkflowHookTokenError} is one: every plain `Error` reaching
 * `withReserved` becomes a **503**, which tells the guest to retry a refusal that
 * cannot change — a run id that exists will go on existing — so the engine spends
 * the message's whole attempt budget on it instead of failing the run and saying
 * why. `workflow-journal-handler.ts` maps both to a **409**, the status the upload
 * record route's `claim` refusal already uses for the same shape of answer: a
 * caller-supplied identifier that is taken.
 *
 * The MESSAGE is the memory backend's, word for word, so the three backends
 * refuse a duplicate in one voice and a guest reading a log cannot tell which
 * one answered.
 */
export class PlatformWorkflowRunTakenError extends Error {
  constructor(runId: string) {
    super(`workflow run ${runId} already exists`);
    this.name = "PlatformWorkflowRunTakenError";
  }
}

/**
 * Record a run at `pending`, refusing an id that is already taken.
 *
 * **The `returning` is the refusal.** Without it, zero rows and one row are the
 * same answer, and a duplicate is silently a no-op — see
 * {@link PlatformWorkflowRunTakenError}. `do nothing` is kept in front of it
 * rather than letting a bare insert raise `23505`, for the reason `claimHook`
 * keeps it: a raw SQLSTATE is a plain `Error`, i.e. a retryable 503, and the
 * refusal has to be the authored one. It also does not WAIT on a concurrent
 * inserter — Postgres declines instead — so the loser of a real race is refused
 * now rather than after the winner commits.
 */
export async function createRun(
  sql: SqlExec,
  slug: string,
  // `input` is `| undefined` rather than merely optional so a caller can pass the
  // absent case straight through under `exactOptionalPropertyTypes`, with no
  // conditional spread at the call site for `guard-invariants` rule 2 to catch.
  run: {
    runId: string;
    workflow: string;
    status: string;
    createdAt: number;
    input?: string | undefined;
    codeVersion?: string | undefined;
  },
): Promise<void> {
  const rows = await sql(
    `insert into ${RUNS}
       (slug, run_id, workflow, status, created_at, input, code_version)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7)
     on conflict (slug, run_id) do nothing
     returning run_id`,
    [
      slug,
      run.runId,
      run.workflow,
      run.status,
      run.createdAt,
      run.input ?? null,
      run.codeVersion ?? null,
    ],
  );
  if (rows.length === 0) throw new PlatformWorkflowRunTakenError(run.runId);
}

/** One run, or undefined when this agent has none by that id. */
export async function getRun(
  sql: SqlExec,
  slug: string,
  runId: string,
): Promise<JournalRunRow | undefined> {
  const rows = await sql(
    `select run_id, workflow, status, created_at, input::text as input,
            output::text as output, error, code_version
       from ${RUNS} where slug = $1 and run_id = $2`,
    [slug, runId],
  );
  const row = rows[0];
  return row ? toRun(row) : undefined;
}

/**
 * This agent's runs of one workflow, newest first.
 *
 * `limit` reaches `LIMIT $3` unchanged, so it must already be in range when it
 * gets here: the route bounds it (`MAX_WORKFLOW_JOURNAL_LIST_LIMIT` in
 * `workflow-journal-handler.ts`, which carries the argument for the number). Not
 * re-checked here — one policy, at the boundary the untrusted value crosses,
 * rather than a second copy that can disagree with it.
 */
export async function listRuns(
  sql: SqlExec,
  slug: string,
  workflow: string,
  limit: number,
): Promise<JournalRunRow[]> {
  const rows = await sql(
    `select run_id, workflow, status, created_at, input::text as input,
            output::text as output, error, code_version
       from ${RUNS} where slug = $1 and workflow = $2
      order by created_at desc, run_id desc limit $3`,
    [slug, workflow, limit],
  );
  return rows.map(toRun);
}

/**
 * Move a run's status, refusing when it is no longer where the caller thought.
 *
 * The `expect` list IS the compare-and-set: without it a worker that had not
 * noticed a cancel would mark the run completed, and the cancel would be lost with
 * no trace. `null` for an absent list matches any status, which is what an
 * unconditional move (a cancel itself) wants.
 *
 * Answers whether a row moved. The row COUNT is the answer rather than a re-read:
 * a read would race the next writer.
 */
export async function setStatus(
  sql: SqlExec,
  slug: string,
  runId: string,
  status: string,
  result: { output?: string | undefined; error?: string | undefined } | undefined,
  expect: readonly string[] | undefined,
): Promise<boolean> {
  // **The hook release rides the SAME statement.** A token is held for exactly as
  // long as its run might still be answered; the memory backend gives it back the
  // moment the run goes terminal and this did not, so a DERIVED token — which is
  // what the SDK tells authors to use — served exactly one run ever.
  // `recap-workflow` derives `retention:<sessionId>`, so a second recap in one
  // session hit `claimHook`'s conflict, which is not a suspend, so the saga
  // compensated and deleted that transcript too.
  //
  // A CTE rather than a second query because the two must not diverge: a crash
  // between them leaves a terminal run holding its tokens forever, and nothing
  // here sweeps them the way `forgetOldTerminalRuns` does in memory.
  const rows = await sql(
    `with moved as (
       update ${RUNS}
          set status = $3,
              output = coalesce($4::text::jsonb, output),
              error = coalesce($5, error)
        where slug = $1 and run_id = $2
          and ($6::text[] is null or status = any($6::text[]))
        returning run_id
     ), released as (
       delete from ${HOOKS} h
        using moved m
        where h.slug = $1 and h.run_id = m.run_id and $7::boolean
     )
     select run_id from moved`,
    [
      slug,
      runId,
      status,
      result?.output ?? null,
      result?.error ?? null,
      expect ?? null,
      // Only a TERMINAL move releases. A run going `running` still owns its
      // tokens — that is the whole point of a hook.
      TERMINAL.has(status),
    ],
  );
  return rows.length > 0;
}

/** Every settled step of a run, in the order they finished. */
export async function readSteps(
  sql: SqlExec,
  slug: string,
  runId: string,
): Promise<JournalStepRow[]> {
  const rows = await sql(
    `select key, name, status, output::text as output, error, attempts, started_at, finished_at
       from ${STEPS} where slug = $1 and run_id = $2 order by finished_at, key`,
    [slug, runId],
  );
  return rows.map(toStep);
}

/**
 * Burn an attempt and answer the new count.
 *
 * ONE statement. Read-then-increment lets two concurrent deliveries of the same
 * run read the same number, after which a wedged step retries past its ceiling
 * forever — which is the failure the attempt ledger exists to stop.
 */
export async function claimAttempt(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
): Promise<number> {
  const rows = await sql(
    `insert into ${ATTEMPTS} (slug, run_id, key, n) values ($1, $2, $3, 1)
     on conflict (slug, run_id, key) do update set n = ${ATTEMPTS}.n + 1
     returning n`,
    [slug, runId, key],
  );
  const n = rows[0]?.n;
  if (n === undefined) throw new Error(`workflow attempt claim returned nothing for ${runId}`);
  return Number(n);
}

/**
 * Give an attempt back, because it ENDED without settling the step.
 *
 * ONE statement, and `greatest` is the floor rather than tidiness: a release
 * that lands twice may only under-charge a budget the next claim re-takes, where
 * a negative count is an unbounded budget for a step that wedges the guest. A
 * missing row is a no-op — there is nothing charged to give back.
 */
export async function releaseAttempt(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
): Promise<null> {
  await sql(
    `update ${ATTEMPTS} set n = greatest(n - 1, 0)
     where slug = $1 and run_id = $2 and key = $3`,
    [slug, runId, key],
  );
  return null;
}

/** Record a settled step, or read the one already recorded. */
export async function appendStep(
  sql: SqlExec,
  slug: string,
  runId: string,
  entry: JournalStepRow,
): Promise<JournalStepRow> {
  await sql(
    `insert into ${STEPS}
       (slug, run_id, key, name, status, output, error, attempts, started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10)
     on conflict (slug, run_id, key) do nothing`,
    [
      slug,
      runId,
      entry.key,
      entry.name,
      entry.status,
      entry.output ?? null,
      entry.error ?? null,
      entry.attempts,
      entry.startedAt ?? null,
      entry.finishedAt,
    ],
  );
  const rows = await sql(
    `select key, name, status, output::text as output, error, attempts, started_at, finished_at
       from ${STEPS} where slug = $1 and run_id = $2 and key = $3`,
    [slug, runId, entry.key],
  );
  const row = rows[0];
  if (!row) throw new Error(`workflow step ${entry.key} vanished for run ${runId}`);
  return toStep(row);
}
