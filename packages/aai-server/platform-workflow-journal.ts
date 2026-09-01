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

import type { SqlExec } from "./secret-store.ts";

/** Where the journal lives. One schema-qualified name per table, spelled once. */
const RUNS = "aai_platform.workflow_runs";
const STEPS = "aai_platform.workflow_steps";
const ATTEMPTS = "aai_platform.workflow_attempts";
const SLEEPS = "aai_platform.workflow_sleeps";
const HOOKS = "aai_platform.workflow_hooks";

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
};

/** One settled step. */
export type JournalStepRow = {
  key: string;
  name: string;
  status: string;
  output: string | undefined;
  error: string | undefined;
  attempts: number;
  finishedAt: number;
};

/** One wait. */
export type JournalSleepRow = {
  wakeAt: number;
  woken: boolean;
  correlationId: string | undefined;
  kind: string;
};

/** One hook window. */
export type JournalHookRow = {
  token: string;
  delivered: boolean;
  payload: string | undefined;
  closed: boolean;
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
    finishedAt: millis(row.finished_at),
  };
}

/** Record a run at `pending`. */
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
  },
): Promise<void> {
  await sql(
    `insert into ${RUNS} (slug, run_id, workflow, status, created_at, input)
     values ($1, $2, $3, $4, $5, $6::text::jsonb)
     on conflict (slug, run_id) do nothing`,
    [slug, run.runId, run.workflow, run.status, run.createdAt, run.input ?? null],
  );
}

/** One run, or undefined when this agent has none by that id. */
export async function getRun(
  sql: SqlExec,
  slug: string,
  runId: string,
): Promise<JournalRunRow | undefined> {
  const rows = await sql(
    `select run_id, workflow, status, created_at, input::text as input,
            output::text as output, error
       from ${RUNS} where slug = $1 and run_id = $2`,
    [slug, runId],
  );
  const row = rows[0];
  return row ? toRun(row) : undefined;
}

/** This agent's runs of one workflow, newest first. */
export async function listRuns(
  sql: SqlExec,
  slug: string,
  workflow: string,
  limit: number,
): Promise<JournalRunRow[]> {
  const rows = await sql(
    `select run_id, workflow, status, created_at, input::text as input,
            output::text as output, error
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
  const rows = await sql(
    `update ${RUNS}
        set status = $3,
            output = coalesce($4::text::jsonb, output),
            error = coalesce($5, error)
      where slug = $1 and run_id = $2
        and ($6::text[] is null or status = any($6::text[]))
      returning run_id`,
    [slug, runId, status, result?.output ?? null, result?.error ?? null, expect ?? null],
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
    `select key, name, status, output::text as output, error, attempts, finished_at
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
 * Record a wait, or read the one already recorded.
 *
 * First write wins and later calls are READS — which is what stops a replay
 * pushing the deadline further out on every walk of the body.
 */
export async function claimSleep(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
  wakeAt: number,
  correlationId: string | undefined,
  kind: string,
): Promise<JournalSleepRow> {
  await sql(
    `insert into ${SLEEPS} (slug, run_id, key, wake_at, correlation_id, kind)
     values ($1, $2, $3, $4, $5, $6) on conflict (slug, run_id, key) do nothing`,
    [slug, runId, key, wakeAt, correlationId ?? null, kind],
  );
  const rows = await sql(
    `select wake_at, woken, correlation_id, kind from ${SLEEPS}
      where slug = $1 and run_id = $2 and key = $3`,
    [slug, runId, key],
  );
  const row = rows[0];
  if (!row) throw new Error(`workflow sleep ${key} vanished for run ${runId}`);
  return {
    wakeAt: millis(row.wake_at),
    woken: Boolean(row.woken),
    correlationId: text(row.correlation_id),
    kind: String(row.kind),
  };
}

/**
 * Cut short every wait this call reaches, and answer how many.
 *
 * Three refusals as one `where`, the same three the memory backend makes: an
 * ELAPSED wait is not one this call stopped, nor is an already-woken one, and a
 * BARE wake reaches ordinary sleeps only — so cutting a schedule short cannot
 * also close an approval window.
 */
export async function wakeSleeps(
  sql: SqlExec,
  slug: string,
  runId: string,
  now: number,
  correlationIds: readonly string[] | undefined,
): Promise<number> {
  const rows = await sql(
    `update ${SLEEPS}
        set woken = true
      where slug = $1 and run_id = $2
        and woken = false
        and wake_at > $3
        and case
              when $4::text[] is null then kind = 'sleep'
              else correlation_id = any($4::text[])
            end
      returning key`,
    [slug, runId, now, correlationIds ?? null],
  );
  return rows.length;
}

/**
 * Open a hook window, or read the one already open.
 *
 * A token another RUN holds is refused rather than overwritten: a token is what a
 * third party dials, so two runs sharing one means a payload delivered to the
 * wrong body. A re-claim by the same run and key is what a replay does and is the
 * ordinary path.
 */
export async function claimHook(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
  token: string,
): Promise<JournalHookRow> {
  const held = await sql(`select run_id, key from ${HOOKS} where slug = $1 and token = $2`, [
    slug,
    token,
  ]);
  const owner = held[0];
  if (owner && (String(owner.run_id) !== runId || String(owner.key) !== key)) {
    throw new Error(`workflow hook token already held by run ${String(owner.run_id)}`);
  }
  await sql(
    `insert into ${HOOKS} (slug, run_id, key, token)
     values ($1, $2, $3, $4) on conflict (slug, run_id, key) do nothing`,
    [slug, runId, key, token],
  );
  const rows = await sql(
    `select token, delivered, payload::text as payload, closed from ${HOOKS}
      where slug = $1 and run_id = $2 and key = $3`,
    [slug, runId, key],
  );
  const row = rows[0];
  if (!row) throw new Error(`workflow hook ${key} vanished for run ${runId}`);
  return {
    token: String(row.token),
    delivered: Boolean(row.delivered),
    payload: text(row.payload),
    closed: Boolean(row.closed),
  };
}

/** Close a window the run has moved past, so a late delivery is refused. */
export async function closeHook(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
): Promise<void> {
  await sql(`update ${HOOKS} set closed = true where slug = $1 and run_id = $2 and key = $3`, [
    slug,
    runId,
    key,
  ]);
}

/**
 * Deliver a payload, and answer which run to re-walk.
 *
 * Already answered, or the window closed: both are the same refusal for the same
 * reason — a body is replayed and must read the same answer every time, or two
 * walks of it diverge. The `where` is what makes that atomic.
 */
export async function deliverHook(
  sql: SqlExec,
  slug: string,
  token: string,
  payload: string | undefined,
): Promise<string | undefined> {
  const rows = await sql(
    `update ${HOOKS}
        set delivered = true, payload = $3::text::jsonb
      where slug = $1 and token = $2 and delivered = false and closed = false
      returning run_id`,
    [slug, token, payload ?? null],
  );
  const row = rows[0];
  return row ? String(row.run_id) : undefined;
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
       (slug, run_id, key, name, status, output, error, attempts, finished_at)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9)
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
      entry.finishedAt,
    ],
  );
  const rows = await sql(
    `select key, name, status, output::text as output, error, attempts, finished_at
       from ${STEPS} where slug = $1 and run_id = $2 and key = $3`,
    [slug, runId, entry.key],
  );
  const row = rows[0];
  if (!row) throw new Error(`workflow step ${entry.key} vanished for run ${runId}`);
  return toStep(row);
}
