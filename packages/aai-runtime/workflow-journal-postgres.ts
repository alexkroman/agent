// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal on a Postgres this deployment was GIVEN.
 *
 * `createMemoryJournal` is the reference implementation of the contract and the
 * honest trade for `aai dev`; this is the one that makes a run outlive its
 * process. A self-hosted `createServer` with a `DATABASE_URL`, or `aai dev`
 * against one, gets it — the platform's own journal is a separate backend, for
 * the same reason session state has three.
 *
 * ## What the CONTRACT asks of a real database, and where each answer is
 *
 * The memory backend gets its atomicity by not awaiting mid-operation. Here
 * every one of those is a statement the database has to make atomic on its own,
 * and each is worth naming because getting one wrong produces a run that looks
 * healthy:
 *
 * - **`createRun`** — a plain insert. The primary key is what refuses a
 *   collision, so two starts racing on one id cannot both win.
 * - **`setStatus`** — `update … where status = any($n)`, and the ROW COUNT is
 *   the answer. That is the compare-and-set, and it is what stops a worker that
 *   had not noticed a cancel from marking the run completed.
 * - **`claimAttempt`** — `insert … on conflict do update set n = n + 1
 *   returning n`. One statement, so two concurrent deliveries cannot read the
 *   same number and let a step exceed its ceiling.
 * - **`appendStep`** — `on conflict do nothing`, then read back. The stored
 *   entry stays authoritative, so the loser of a race adopts the winner's value
 *   rather than its own.
 * - **`claimSleep`** and **`claimHook`** — the same shape, because "first write
 *   wins and later calls are reads" is what makes a replay find the same
 *   deadline rather than pushing it further out.
 *
 * ## Values are TYPED JSON, and every binding is `::text::jsonb`
 *
 * `input`, `output` and a step's `output` go through `workflow-typed-json.ts`,
 * which is what carries a `Uint8Array` or a `Date` across the boundary. A
 * backend reaching for `JSON.stringify` turns binary into an index map and
 * nothing errors — the run simply resumes with garbage.
 *
 * **The cast is `::text::jsonb` and not `::jsonb`, and the difference is a
 * silent double-encode.** postgres.js JSON-serializes a parameter bound to a
 * `jsonb` position, so handing it the codec's already-encoded TEXT stores a JSON
 * *string* whose content is the JSON — `"{\"topic\":\"otters\"}"` rather than
 * `{"topic": "otters"}`. Every read then decodes to a string, so `input` comes
 * back as text, a step's `output` as a quoted string, and a `Uint8Array`
 * envelope never revives. Naming the parameter `text` first is what makes
 * Postgres, rather than the driver, do the parse.
 *
 * Nothing above this line could see it: the memory backend holds JS values, and
 * a recording `Db` asserts the statement rather than running it. It took a real
 * server — which is what `workflow-journal.scenario.test.ts` is for.
 *
 * ## The tables come WITH the database
 *
 * {@link workflowJournalDdl} is the shape and whoever OWNS the database applies
 * it, which is the rule `session-state-postgres.ts` arrived at the hard way: a
 * backend that created its own tables on the read path paid two round trips and
 * a `42P07` notice per boot, and was wrong anyway the moment a column was added.
 * {@link applyWorkflowJournalDdl} is the best-effort boot call for the two
 * operators who own their database and had no other way to act on it — `aai dev`
 * and the scaffold's `server.mjs`.
 */

import type { Db } from "@alexkroman1/aai/internal";
import {
  WORKFLOW_ATTEMPT_TABLE,
  WORKFLOW_HOOK_TABLE,
  WORKFLOW_RUN_TABLE,
  WORKFLOW_SLEEP_TABLE,
  WORKFLOW_STEP_TABLE,
} from "./workflow-journal-schema.ts";
import type {
  HookRecord,
  JournalStore,
  RunRecord,
  RunStatus,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-types.ts";
import { decodeStorageJson, encodeStorageJson } from "./workflow-typed-json.ts";

/** A run row, as the driver hands it back. */
type RunRow = {
  run_id: string;
  workflow: string;
  status: RunStatus;
  created_at: string | number;
  input: string;
  output: string | null;
  error: string | null;
};

/** A step row. */
type StepRow = {
  key: string;
  name: string;
  status: "ok" | "failed";
  output: string | null;
  error: string | null;
  attempts: number;
  finished_at: string | number;
};

/**
 * `bigint` arrives as a STRING from the driver, and `Number` is the read.
 *
 * Not a bug waiting to happen: these are epoch milliseconds, so the values are
 * ~1.7e12 against `Number.MAX_SAFE_INTEGER`'s 9e15 — four orders of magnitude of
 * room. `bigint` rather than `integer` because a 32-bit column overflows in 1970
 * + 24 days, which is the mistake this column shape exists to avoid.
 */
const millis = (value: string | number): number => Number(value);

function toRunRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    workflow: row.workflow,
    status: row.status,
    createdAt: millis(row.created_at),
    input: decodeStorageJson(row.input),
    ...(row.output === null ? {} : { output: decodeStorageJson(row.output) }),
    ...(row.error === null ? {} : { error: { message: row.error } }),
  };
}

function toStepEntry(row: StepRow): StepEntry {
  return {
    key: row.key,
    name: row.name,
    status: row.status,
    ...(row.output === null ? {} : { output: decodeStorageJson(row.output) }),
    ...(row.error === null ? {} : { error: { message: row.error } }),
    attempts: row.attempts,
    finishedAt: millis(row.finished_at),
  };
}

/**
 * Build a journal over `db`.
 *
 * @internal
 */
export function createPostgresJournal(opts: { db: Db }): JournalStore {
  const { db } = opts;

  return {
    async createRun(record: RunRecord): Promise<void> {
      // A plain insert: the primary key is what refuses a collision, so two
      // starts racing on one id cannot both win.
      await db.query(
        `insert into ${WORKFLOW_RUN_TABLE} (run_id, workflow, status, created_at, input)
         values ($1, $2, $3, $4, $5::text::jsonb)`,
        [
          record.runId,
          record.workflow,
          record.status,
          record.createdAt,
          encodeStorageJson(record.input),
        ],
      );
    },

    async getRun(runId: string): Promise<RunRecord | undefined> {
      const rows = await db.query<RunRow>(
        `select run_id, workflow, status, created_at, input::text as input,
                output::text as output, error
         from ${WORKFLOW_RUN_TABLE} where run_id = $1`,
        [runId],
      );
      const row = rows[0];
      return row ? toRunRecord(row) : undefined;
    },

    async listRuns(workflow: string, limit: number): Promise<RunRecord[]> {
      const rows = await db.query<RunRow>(
        `select run_id, workflow, status, created_at, input::text as input,
                output::text as output, error
         from ${WORKFLOW_RUN_TABLE}
         where workflow = $1
         order by created_at desc, run_id desc
         limit $2`,
        [workflow, limit],
      );
      return rows.map(toRunRecord);
    },

    async setStatus(
      runId: string,
      next: RunStatus,
      patch?: { output?: unknown; error?: { message: string } },
      expect?: readonly RunStatus[],
    ): Promise<boolean> {
      // The COMPARE-AND-SET, and the row count is the answer. `returning run_id`
      // rather than a driver-specific affected-row count, so the check is one
      // the `Db` interface can actually express.
      const rows = await db.query<{ run_id: string }>(
        `update ${WORKFLOW_RUN_TABLE}
         set status = $2,
             output = case when $4::boolean then $5::text::jsonb else output end,
             error = coalesce($6, error)
         where run_id = $1 and ($3::text[] is null or status = any($3::text[]))
         returning run_id`,
        [
          runId,
          next,
          expect === undefined ? null : [...expect],
          patch !== undefined && "output" in patch,
          patch !== undefined && "output" in patch ? encodeStorageJson(patch.output) : null,
          patch?.error?.message ?? null,
        ],
      );
      return rows.length > 0;
    },

    async readSteps(runId: string): Promise<StepEntry[]> {
      const rows = await db.query<StepRow>(
        `select key, name, status, output::text as output, error, attempts, finished_at
         from ${WORKFLOW_STEP_TABLE} where run_id = $1 order by finished_at, key`,
        [runId],
      );
      return rows.map(toStepEntry);
    },

    async claimAttempt(runId: string, key: string): Promise<number> {
      // ONE statement, so two concurrent deliveries cannot read the same number
      // and let a step exceed its ceiling.
      const rows = await db.query<{ n: number }>(
        `insert into ${WORKFLOW_ATTEMPT_TABLE} (run_id, key, n) values ($1, $2, 1)
         on conflict (run_id, key) do update set n = ${WORKFLOW_ATTEMPT_TABLE}.n + 1
         returning n`,
        [runId, key],
      );
      const n = rows[0]?.n;
      if (n === undefined) throw new Error(`workflow attempt claim returned nothing for ${runId}`);
      return n;
    },

    async claimSleep(
      runId: string,
      key: string,
      wakeAt: number,
      correlationId: string | undefined,
      kind: SleepRecord["kind"] = "sleep",
    ): Promise<SleepRecord> {
      // First write wins and later calls are READS — `do nothing` then read back,
      // which is what stops a replay pushing the deadline further out each time.
      await db.query(
        `insert into ${WORKFLOW_SLEEP_TABLE} (run_id, key, wake_at, correlation_id, kind)
         values ($1, $2, $3, $4, $5) on conflict (run_id, key) do nothing`,
        [runId, key, wakeAt, correlationId ?? null, kind],
      );
      const rows = await db.query<{
        wake_at: string | number;
        woken: boolean;
        correlation_id: string | null;
        kind: SleepRecord["kind"];
      }>(
        `select wake_at, woken, correlation_id, kind from ${WORKFLOW_SLEEP_TABLE}
         where run_id = $1 and key = $2`,
        [runId, key],
      );
      const row = rows[0];
      if (!row) throw new Error(`workflow sleep ${key} vanished for run ${runId}`);
      return {
        wakeAt: millis(row.wake_at),
        woken: row.woken,
        correlationId: row.correlation_id ?? undefined,
        kind: row.kind,
      };
    },

    async wakeSleeps(
      runId: string,
      correlationIds: readonly string[] | undefined,
    ): Promise<number> {
      // The same three refusals the memory backend's `wakeReaches` makes, as one
      // `where`: an elapsed or already-woken wait is not one this call stopped,
      // and a BARE wake reaches ordinary sleeps only — so cutting a SCHEDULE
      // short cannot also close an approval window.
      const rows = await db.query<{ key: string }>(
        `update ${WORKFLOW_SLEEP_TABLE}
         set woken = true
         where run_id = $1
           and woken = false
           and wake_at > $2
           and case
                 when $3::text[] is null then kind = 'sleep'
                 else coalesce(correlation_id, '') = any($3::text[])
               end
         returning key`,
        [runId, Date.now(), correlationIds === undefined ? null : [...correlationIds]],
      );
      return rows.length;
    },

    async claimHook(runId: string, key: string, token: string): Promise<HookRecord> {
      // A token held by a DIFFERENT wait is a bug rather than a race — one signal
      // would end whichever the store found first and the other would wait
      // forever — so the unique index is left to refuse it, and the message names
      // the holder the way the memory backend's does.
      const existing = await db.query<{ run_id: string; key: string }>(
        `select run_id, key from ${WORKFLOW_HOOK_TABLE} where token = $1`,
        [token],
      );
      const owner = existing[0];
      if (owner && !(owner.run_id === runId && owner.key === key)) {
        throw new Error(
          `workflow hook token ${JSON.stringify(token)} is already held by run ${owner.run_id}`,
        );
      }
      await db.query(
        `insert into ${WORKFLOW_HOOK_TABLE} (run_id, key, token) values ($1, $2, $3)
         on conflict (run_id, key) do nothing`,
        [runId, key, token],
      );
      const rows = await db.query<{
        token: string;
        delivered: boolean;
        payload: string | null;
        closed: boolean;
      }>(
        `select token, delivered, payload::text as payload, closed
         from ${WORKFLOW_HOOK_TABLE} where run_id = $1 and key = $2`,
        [runId, key],
      );
      const row = rows[0];
      if (!row) throw new Error(`workflow hook ${key} vanished for run ${runId}`);
      return {
        token: row.token,
        delivered: row.delivered,
        ...(row.payload === null ? {} : { payload: decodeStorageJson(row.payload) }),
        closed: row.closed,
      };
    },

    async closeHook(runId: string, key: string): Promise<void> {
      await db.query(
        `update ${WORKFLOW_HOOK_TABLE} set closed = true where run_id = $1 and key = $2`,
        [runId, key],
      );
    },

    async deliverHook(token: string, payload: unknown): Promise<string | undefined> {
      // Already answered, or the window closed: both are the same refusal for the
      // same reason — a body is replayed and must read the same answer every
      // time, or two walks of it diverge. The `where` is what makes that atomic.
      const rows = await db.query<{ run_id: string }>(
        `update ${WORKFLOW_HOOK_TABLE}
         set delivered = true, payload = $2::text::jsonb
         where token = $1 and delivered = false and closed = false
         returning run_id`,
        [token, encodeStorageJson(payload)],
      );
      return rows[0]?.run_id;
    },

    async appendStep(runId: string, entry: StepEntry): Promise<StepEntry> {
      // Idempotent on `key`: `do nothing` then read back, so the FIRST entry
      // stays authoritative and two executions that both ran the step agree on
      // what it returned.
      await db.query(
        `insert into ${WORKFLOW_STEP_TABLE}
           (run_id, key, name, status, output, error, attempts, finished_at)
         values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8)
         on conflict (run_id, key) do nothing`,
        [
          runId,
          entry.key,
          entry.name,
          entry.status,
          entry.output === undefined ? null : encodeStorageJson(entry.output),
          entry.error?.message ?? null,
          entry.attempts,
          entry.finishedAt,
        ],
      );
      const rows = await db.query<StepRow>(
        `select key, name, status, output::text as output, error, attempts, finished_at
         from ${WORKFLOW_STEP_TABLE} where run_id = $1 and key = $2`,
        [runId, entry.key],
      );
      const row = rows[0];
      if (!row) throw new Error(`workflow step ${entry.key} vanished for run ${runId}`);
      return toStepEntry(row);
    },
  };
}
