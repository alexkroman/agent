// Copyright 2026 the AAI authors. MIT license.
/**
 * What one journal ROW is, and what the driver's version of it has to be read as.
 *
 * Split from `platform-workflow-journal.ts` so the STATEMENTS and the row shapes
 * they answer with are separate files — and so `text` has one definition rather
 * than one per half of the journal, which is how the hooks module came to carry a
 * copy.
 *
 * Every value here stays ENCODED: the platform is a transport for the runtime's
 * typed JSON and never decodes it (see that module's header), so a `jsonb` column
 * arrives and leaves as `::text`.
 *
 * @internal
 */

/**
 * `bigint` arrives as a STRING from the driver, and `Number` is the read.
 *
 * Left alone every comparison against a deadline is lexicographic and every
 * arithmetic one is concatenation — both silent. Epoch milliseconds are far under
 * 2^53, so the conversion is exact for any date this will see.
 */
export const millis = (value: unknown): number => Number(value);

/** A stored value, as the codec wrote it. `null` from the driver means absent. */
export const text = (value: unknown): string | undefined =>
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
   * The bundle the run was STARTED against, absent off the platform and for a
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
   * When the walk REACHED this step, absent for a row written before the
   * column existed — see `StepEntry.startedAt`.
   */
  startedAt: number | undefined;
  finishedAt: number;
};

/** One wait. */
export type JournalSleepRow = {
  wakeAt: number;
  woken: boolean;
  correlationId: string | undefined;
  kind: string;
};

export function toRun(row: Record<string, unknown>): JournalRunRow {
  return {
    runId: String(row.run_id),
    workflow: String(row.workflow),
    status: String(row.status),
    createdAt: millis(row.created_at),
    input: text(row.input),
    output: text(row.output),
    error: text(row.error),
    // A DIAGNOSTIC, so an absent value stays absent rather than being coerced:
    // `String(undefined)` is `"undefined"`, which compares unequal to every
    // real bundle hash and would report a redeploy on a run that never had one.
    codeVersion: text(row.code_version),
  };
}

export function toStep(row: Record<string, unknown>): JournalStepRow {
  return {
    key: String(row.key),
    name: String(row.name),
    status: String(row.status),
    output: text(row.output),
    error: text(row.error),
    attempts: Number(row.attempts),
    // Absent rather than 0 when the column is NULL: a row predating this field
    // has no start, and `0` would report a long step as instant.
    startedAt:
      row.started_at === null || row.started_at === undefined ? undefined : millis(row.started_at),
    finishedAt: millis(row.finished_at),
  };
}
