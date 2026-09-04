// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal on a Postgres this deployment was GIVEN.
 *
 * `createMemoryJournal` is the reference implementation of the contract and the
 * honest trade for `aai dev`; this is the one that makes a run outlive its
 * process. A self-hosted `createRuntimeServer` with a `DATABASE_URL`, or `aai dev`
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
 * - **`claimAttempt`** and **`releaseAttempt`** — a LEASE, one row per
 *   `(run_id, key)` holding a holder→instant map, and the answer is how many
 *   holders are outstanding rather than how many tries a step has had. One
 *   statement each, so two concurrent deliveries cannot read the same number
 *   and let a step exceed its ceiling: the claim prunes every holder older than
 *   `leaseMs` in the same `insert … on conflict do update`, and the release is
 *   `holders - $3`, which removes exactly the named holder rather than
 *   decrementing a shared counter. `_workflow-journal-attempts.ts` owns the SQL
 *   and the argument — including why the counter this replaced could not be
 *   made correct, a walk that died holding a charge having stood forever.
 * - **`appendStep`**, **`claimSleep`** and **`claimHook`** — FIRST WRITE WINS,
 *   as ONE statement each. The stored row stays authoritative, so the loser of a
 *   race adopts the winner's value rather than its own, and a replay finds the
 *   same deadline rather than pushing it further out. Each was `on conflict do
 *   nothing` and then a separate read-back, which is two round trips AND a race:
 *   see {@link firstWriteWins} for what the second statement could not see and
 *   why the shape is a `union all` rather than an `on conflict do update`.
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
import { firstWriteWins } from "./_journal-claim.ts";
import { claimAttemptLease, releaseAttemptLease } from "./_workflow-journal-attempts.ts";
import {
  encodedOrNull,
  type RunRow,
  type SleepRow,
  type StepRow,
  toRunRecord,
  toSleepRecord,
  toStepEntry,
} from "./_workflow-journal-postgres-rows.ts";
import { resumableRuns } from "./_workflow-journal-resumable.ts";
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
  ResumableRun,
  RunRecord,
  RunStatus,
  SleepEntry,
  SleepRecord,
  StepEntry,
} from "./workflow-journal-types.ts";
import { isTerminalStatus, JournalConflictError } from "./workflow-journal-types.ts";
import { decodeStorageJson } from "./workflow-typed-json.ts";

/** Every column a {@link StepEntry} is rebuilt from — ONE list, so the two reads below cannot drift. */
const SELECT_STEP = `select key, name, status, output::text as output, error, attempts, started_at, finished_at from ${WORKFLOW_STEP_TABLE}`;

/** The same, for a {@link RunRecord} and the two reads that rebuild one. */
const SELECT_RUN = `select run_id, workflow, status, created_at, input::text as input, output::text as output, error, code_version from ${WORKFLOW_RUN_TABLE}`;

/**
 * Build a journal over `db`.
 *
 * @internal
 */
export function createPostgresJournal(options: { db: Db }): JournalStore {
  const { db } = options;

  return {
    async createRun(record: RunRecord): Promise<void> {
      // A plain insert: the primary key is what refuses a collision, so two
      // starts racing on one id cannot both win.
      await db.query(
        `insert into ${WORKFLOW_RUN_TABLE}
           (run_id, workflow, status, created_at, input, code_version)
         values ($1, $2, $3, $4, $5::text::jsonb, $6)`,
        [
          record.runId,
          record.workflow,
          record.status,
          record.createdAt,
          encodedOrNull(record.input),
          // `null`, never `undefined`: postgres.js refuses an undefined
          // parameter outright — see `encodedOrNull`'s doc for the run this
          // stalled the first time.
          record.codeVersion ?? null,
        ],
      );
    },

    async getRun(runId: string): Promise<RunRecord | undefined> {
      const rows = await db.query<RunRow>(`${SELECT_RUN} where run_id = $1`, [runId]);
      const row = rows[0];
      return row ? toRunRecord(row) : undefined;
    },

    async listRuns(workflow: string, limit: number): Promise<RunRecord[]> {
      const rows = await db.query<RunRow>(
        `${SELECT_RUN} where workflow = $1 order by created_at desc, run_id desc limit $2`,
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
      //
      // **The hook release rides the SAME statement, and it is not an
      // optimisation.** A token is held for exactly as long as its run might
      // still be answered; the memory backend gives it back the moment the run
      // goes terminal and these two did not, so a DERIVED token — which is what
      // the SDK tells authors to use — served exactly one run ever.
      // `recap-workflow` derives `retention:<sessionId>`, so a second recap in
      // one session hit `claimHook`'s conflict, which is not a suspend, so the
      // saga compensated and deleted that transcript too.
      //
      // As a CTE rather than a second query because the two must not diverge: a
      // crash between them leaves a terminal run holding its tokens forever, and
      // nothing sweeps them here the way `forgetOldTerminalRuns` does in memory.
      const rows = await db.query<{ run_id: string }>(
        `with moved as (
           update ${WORKFLOW_RUN_TABLE}
           set status = $2,
               output = case when $4::boolean then $5::text::jsonb else output end,
               error = coalesce($6, error)
           where run_id = $1 and ($3::text[] is null or status = any($3::text[]))
           returning run_id
         ), released as (
           delete from ${WORKFLOW_HOOK_TABLE} h
            using moved m
            where h.run_id = m.run_id and $7::boolean
         )
         select run_id from moved`,
        [
          runId,
          next,
          expect === undefined ? null : [...expect],
          patch !== undefined && "output" in patch,
          patch !== undefined && "output" in patch ? encodedOrNull(patch.output) : null,
          patch?.error?.message ?? null,
          // Only a TERMINAL move releases. A run going `running` still owns its
          // tokens — that is the whole point of a hook.
          isTerminalStatus(next),
        ],
      );
      return rows.length > 0;
    },

    async readSteps(runId: string): Promise<StepEntry[]> {
      const rows = await db.query<StepRow>(
        `${SELECT_STEP} where run_id = $1 order by finished_at, key`,
        [runId],
      );
      return rows.map(toStepEntry);
    },

    async readStep(runId: string, key: string): Promise<StepEntry | undefined> {
      const [row] = await db.query<StepRow>(`${SELECT_STEP} where run_id = $1 and key = $2`, [
        runId,
        key,
      ]);
      return row ? toStepEntry(row) : undefined;
    },

    claimAttempt: (runId, key, holder, leaseMs) =>
      claimAttemptLease(db, WORKFLOW_ATTEMPT_TABLE, { runId, key, holder, leaseMs }),

    releaseAttempt: (runId, key, holder) =>
      releaseAttemptLease(db, WORKFLOW_ATTEMPT_TABLE, { runId, key, holder }),

    async readSleeps(runId: string): Promise<SleepEntry[]> {
      // `order by key`, which is what the interface promises and what makes the
      // three backends comparable. No index is added for it: the table's primary
      // key is `(run_id, key)`, so this is a range scan of one run's rows already
      // in the order asked for.
      const rows = await db.query<SleepRow & { key: string }>(
        `select key, wake_at, woken, correlation_id, kind from ${WORKFLOW_SLEEP_TABLE}
         where run_id = $1 order by key`,
        [runId],
      );
      return rows.map((row) => ({ ...toSleepRecord(row), key: row.key }));
    },

    async claimSleep(
      runId: string,
      key: string,
      wakeAt: number,
      correlationId: string | undefined,
      kind: SleepRecord["kind"] = "sleep",
    ): Promise<SleepRecord> {
      // First write wins and later calls are READS, which is what stops a replay
      // pushing the deadline further out each time. ONE statement; the retry is
      // for the rival this one cannot see — `firstWriteWins`.
      return await firstWriteWins(
        async () => {
          const rows = await db.query<SleepRow>(
            `with mine as (
               insert into ${WORKFLOW_SLEEP_TABLE}
                 (run_id, key, wake_at, correlation_id, kind)
               values ($1, $2, $3, $4, $5)
               on conflict (run_id, key) do nothing
               returning wake_at, woken, correlation_id, kind
             )
             select wake_at, woken, correlation_id, kind from mine
             union all
             select wake_at, woken, correlation_id, kind from ${WORKFLOW_SLEEP_TABLE}
              where run_id = $1 and key = $2`,
            [runId, key, wakeAt, correlationId ?? null, kind],
          );
          const row = rows[0];
          return row ? toSleepRecord(row) : undefined;
        },
        () => `workflow sleep ${key} vanished for run ${runId}`,
      );
    },

    async wakeSleeps(
      runId: string,
      correlationIds: readonly string[] | undefined,
    ): Promise<number> {
      // The same three refusals the memory backend's `wakeReaches` makes, as one
      // `where`: an elapsed or already-woken wait is not one this call stopped,
      // and a BARE wake reaches ordinary sleeps only — so cutting a SCHEDULE
      // short cannot also close an approval window.
      //
      // `correlation_id = any(...)` and NOT `coalesce(correlation_id, '')`: a
      // wait declared with no id is not a wait declared with `""`. The coalesce
      // folded the two together in both directions — an id list containing an
      // empty string woke every uncorrelated sleep on the run, and a wait really
      // declared `""` was indistinguishable from one declared nothing — while the
      // platform backend, which never folded them, gave the opposite answer.
      // SQL's `NULL = any(...)` is NULL, i.e. not true, which is the refusal
      // wanted. See `journal-conformance-waits.ts`.
      //
      // `wake_at > $2` is the ELAPSED refusal and it STAYS: an overdue run is
      // recovered by `resumableRuns` and the boot sweep, not by pretending a wake
      // stopped a wait that was already over. `wakeReaches` in
      // `workflow-journal-memory.ts` carries the two things it protects.
      const rows = await db.query<{ key: string }>(
        `update ${WORKFLOW_SLEEP_TABLE}
         set woken = true
         where run_id = $1
           and woken = false
           and wake_at > $2
           and case
                 when $3::text[] is null then kind = 'sleep'
                 else correlation_id = any($3::text[])
               end
         returning key`,
        [runId, Date.now(), correlationIds === undefined ? null : [...correlationIds]],
      );
      return rows.length;
    },

    async claimHook(runId: string, key: string, token: string): Promise<HookRecord> {
      // A token held by a DIFFERENT wait is a bug rather than a race — one signal
      // would end whichever the store found first and the other would wait
      // forever — so it is refused, with the message the memory backend uses.
      //
      // **The INSERT is the claim, in one statement.** The ownership `select`
      // used to run first, on an untransacted connection, so two waits racing on
      // one token both read no owner and the loser tripped the unique index: a
      // raw `23505` instead of this authored refusal. A BARE `on conflict do
      // nothing` (no target) absorbs the primary key and the token index alike,
      // so the row the statement reports is what decides whose claim it was.
      return await firstWriteWins(
        async () => {
          const rows = await db.query<{
            run_id: string;
            key: string;
            token: string;
            delivered: boolean;
            payload: string | null;
            closed: boolean;
          }>(
            `with claimed as (
               insert into ${WORKFLOW_HOOK_TABLE} (run_id, key, token)
               values ($1, $2, $3)
               on conflict do nothing
               returning run_id, key, token, delivered, payload::text as payload, closed
             )
             select run_id, key, token, delivered, payload, closed from claimed
             union all
             select run_id, key, token, delivered, payload::text as payload, closed
               from ${WORKFLOW_HOOK_TABLE}
              where (run_id = $1 and key = $2) or token = $3`,
            [runId, key, token],
          );
          // Empty is INDETERMINATE — a rival's uncommitted claim, invisible to
          // this statement's snapshot — and is the one answer worth re-running.
          // A visible owner is a decision, so it throws from in here.
          const owner = rows[0];
          if (!owner) return;
          const mine = rows.find((row) => row.run_id === runId && row.key === key);
          if (!mine) {
            // TYPED, and every arm owes this type for this case: a token
            // conflict is a verdict about the RUN, so `watchJournalFailure`
            // must let it fail the run rather than reading it as a store
            // outage and retrying forever. See `JournalConflictError`.
            throw new JournalConflictError(
              `workflow hook token ${JSON.stringify(token)} is already held by run ${owner.run_id}`,
            );
          }
          return {
            token: mine.token,
            delivered: mine.delivered,
            ...(mine.payload === null ? {} : { payload: decodeStorageJson(mine.payload) }),
            closed: mine.closed,
          };
        },
        () => `workflow hook ${key} vanished for run ${runId}`,
      );
    },

    async closeHook(runId: string, key: string): Promise<boolean> {
      // A COMPARE-AND-SET, and the `delivered = false` in the `where` is the
      // whole of it: a signal that landed while the engine was reading the
      // deadline must win, or this walk times out while every later replay reads
      // the payload. `existing` separates "already answered" from "gone" — a
      // terminal run releases its tokens, and there is nothing to refuse then.
      const rows = await db.query<{ closed: string | number; existing: string | number }>(
        `with shut as (
           update ${WORKFLOW_HOOK_TABLE} set closed = true
            where run_id = $1 and key = $2 and delivered = false
            returning key
         )
         select (select count(*) from shut) as closed,
                (select count(*) from ${WORKFLOW_HOOK_TABLE}
                  where run_id = $1 and key = $2) as existing`,
        [runId, key],
      );
      const row = rows[0];
      if (!row) return true;
      return Number(row.closed) > 0 || Number(row.existing) === 0;
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
        [token, encodedOrNull(payload)],
      );
      return rows[0]?.run_id;
    },

    async resumableRuns(limit: number): Promise<ResumableRun[]> {
      // Its own module — see `_workflow-journal-resumable.ts`, which carries the
      // planner measurement behind the statement's shape. It is a leaf: nothing
      // else in this store reads it, and this file is at the 500-line cap.
      return resumableRuns(db, limit);
    },

    async appendStep(runId: string, entry: StepEntry): Promise<StepEntry> {
      // Idempotent on `key`, in ONE statement, so the FIRST entry stays
      // authoritative and two executions that both ran the step agree on what it
      // returned. The retry is for the rival the statement cannot see.
      return await firstWriteWins(
        async () => {
          const rows = await db.query<StepRow>(
            `with mine as (
               insert into ${WORKFLOW_STEP_TABLE}
                 (run_id, key, name, status, output, error, attempts, started_at,
                  finished_at)
               values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9)
               on conflict (run_id, key) do nothing
               returning key, name, status, output::text as output, error, attempts,
                         started_at, finished_at
             )
             select key, name, status, output, error, attempts, started_at, finished_at
               from mine
             union all
             select key, name, status, output::text as output, error, attempts,
                    started_at, finished_at
               from ${WORKFLOW_STEP_TABLE} where run_id = $1 and key = $2`,
            [
              runId,
              entry.key,
              entry.name,
              entry.status,
              encodedOrNull(entry.output),
              entry.error?.message ?? null,
              entry.attempts,
              // `null`, never `undefined`: postgres.js refuses an undefined
              // parameter outright — see `encodedOrNull`.
              entry.startedAt ?? null,
              entry.finishedAt,
            ],
          );
          const row = rows[0];
          return row ? toStepEntry(row) : undefined;
        },
        () => `workflow step ${entry.key} vanished for run ${runId}`,
      );
    },
  };
}
