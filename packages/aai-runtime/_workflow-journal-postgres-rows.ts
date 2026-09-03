// Copyright 2026 the AAI authors. MIT license.
/**
 * A `workflow_*` ROW as the driver hands it back, and how it becomes a record.
 *
 * Split out of `workflow-journal-postgres.ts` at the seam that file already had:
 * everything here is a pure decode of one row, where everything left there is a
 * STATEMENT. The split is what took that module back under the 500-line cap, and
 * it is the right cut rather than a convenient one — a reader asking "what does
 * `bigint` arrive as" or "why is an absent input `undefined`" is asking about
 * this file, and a reader asking "is the claim one statement" is asking about
 * that one.
 *
 * Nothing here interpolates a table name, so there is no module-initialization
 * order to get wrong at this boundary — the trap `session-state-postgres.ts`
 * records, where a SQL template read a constant declared below it.
 */

import type { RunRecord, RunStatus, SleepRecord, StepEntry } from "./workflow-journal-types.ts";
import { decodeStorageJson, encodeStorageJson } from "./workflow-typed-json.ts";

/** A run row, as the driver hands it back. */
export type RunRow = {
  run_id: string;
  workflow: string;
  status: RunStatus;
  created_at: string | number;
  /** `null` when the run was started with no input — the column is nullable. */
  input: string | null;
  output: string | null;
  error: string | null;
  /** NULL off the platform, and for a row written before the column existed. */
  code_version: string | null;
};

/** A step row. */
export type StepRow = {
  key: string;
  name: string;
  status: "ok" | "failed";
  output: string | null;
  error: string | null;
  attempts: number;
  /** NULL for a row written before the column existed — see `StepEntry.startedAt`. */
  started_at: string | number | null;
  finished_at: string | number;
};

/**
 * A sleep row, from the claim's `returning` and from the bulk read alike.
 *
 * `key` is optional because the CLAIM already knows which key it asked about and
 * its statement does not select one back; the bulk read selects it, and narrows
 * the type at its own call site — {@link toSleepRecord} never reads it.
 */
export type SleepRow = {
  key?: string;
  wake_at: string | number;
  woken: boolean;
  correlation_id: string | null;
  kind: SleepRecord["kind"];
};

/**
 * `bigint` arrives as a STRING from the driver, and `Number` is the read.
 *
 * Not a bug waiting to happen: these are epoch milliseconds, so the values are
 * ~1.7e12 against `Number.MAX_SAFE_INTEGER`'s 9e15 — four orders of magnitude of
 * room. `bigint` rather than `integer` because a 32-bit column overflows in 1970
 * + 24 days, which is the mistake this column shape exists to avoid.
 */
export const millis = (value: string | number): number => Number(value);

/**
 * An author value on its way into a `jsonb` position, or SQL `NULL`.
 *
 * `encodeStorageJson` is `JSON.stringify` underneath, which answers `undefined`
 * for `undefined` however its return type is spelled — and postgres.js REFUSES
 * an undefined parameter outright (`UNDEFINED_VALUE: Undefined values are not
 * allowed`, `handleValue` in its `types.js`; `sql.unsafe` is untagged, so every
 * parameter goes through it). So a workflow body that returns nothing —
 * ordinary, for one that exists to do side effects — made `setStatus`'s
 * `{ output: outcome.output }` throw from inside the driver, the run never left
 * `running`, and the delivery failed and was retried against the same fault.
 *
 * `null` here rather than a guard per call site, because there are four of them
 * and the next one added would be the one that forgets. It is also what makes
 * the three backends agree: the platform journal already omits the field and the
 * memory one stores `undefined`, so a stored SQL `NULL` reads back as absent
 * from all three.
 */
export const encodedOrNull = (value: unknown): string | null =>
  value === undefined ? null : encodeStorageJson(value);

export function toRunRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    workflow: row.workflow,
    status: row.status,
    createdAt: millis(row.created_at),
    // `undefined` and not `null` for an absent input, which is what the memory
    // and platform journals answer — `isRecord` refuses both, but only one of
    // them makes the three backends comparable.
    input: row.input === null ? undefined : decodeStorageJson(row.input),
    ...(row.output === null ? {} : { output: decodeStorageJson(row.output) }),
    ...(row.error === null ? {} : { error: { message: row.error } }),
    ...(row.code_version === null ? {} : { codeVersion: row.code_version }),
  };
}

export function toSleepRecord(row: SleepRow): SleepRecord {
  return {
    wakeAt: millis(row.wake_at),
    woken: row.woken,
    // `undefined` and not `null`, so a wait declared with no id compares equal
    // across the three backends — and so the strict `correlationId !== undefined`
    // test a targeted wake makes reads the same here as in memory.
    correlationId: row.correlation_id ?? undefined,
    kind: row.kind,
  };
}

export function toStepEntry(row: StepRow): StepEntry {
  return {
    key: row.key,
    name: row.name,
    status: row.status,
    ...(row.output === null ? {} : { output: decodeStorageJson(row.output) }),
    ...(row.error === null ? {} : { error: { message: row.error } }),
    attempts: row.attempts,
    // Absent rather than 0 when the column is NULL: a row predating this field
    // has no start, and reporting one as instant is worse than reporting it as
    // unknown. The conditional spread is the presence test rule 2's remedy
    // exists for, and the value is not the guard — `millis` still has to run.
    ...(row.started_at === null ? {} : { startedAt: millis(row.started_at) }),
    finishedAt: millis(row.finished_at),
  };
}
