// Copyright 2026 the AAI authors. MIT license.
/**
 * How many steps one run's journal may hold, and what happens at the ceiling.
 *
 * ## Retention bounds the POPULATION; nothing bounded the INDIVIDUAL
 *
 * `aai_platform.sweep_terminal_workflow_runs()` deletes terminal runs older than
 * 30 days, hourly (`aai-server/pg-cron-bodies.ts`). That is a real bound and it
 * is on the wrong axis for this: it bounds how many RUNS the table holds, and a
 * live run is not eligible for it at any size. A live run's journal also cannot
 * be TRUNCATED — replay answers every settled key from it, so an entry dropped
 * is a step re-executed — so there was no mechanism of any kind bounding one
 * run.
 *
 * What that costs is O(N) per delivery and O(N²) across a run: `replayRun` reads
 * the whole journal at the top of every walk. So a run that has done thousands
 * of steps gets monotonically slower at doing the next one, and the failure
 * arrives as a run that stopped making progress for no stated reason. There is
 * no continue-as-new here and no child workflows, so an author has no way to
 * split one either.
 *
 * ## A LOUD ceiling, because the alternative is a silent curve
 *
 * The engine cannot fix the growth, and this deliberately does not try. What it
 * refuses is the state nobody can act on: a run degrading for a year and then
 * becoming undeliverable, which reads as a platform fault rather than as a body
 * that needs splitting. Temporal bounds a history for the same reason.
 *
 * So: a warning at {@link WORKFLOW_JOURNAL_WARN_STEPS}, naming the count and the
 * ceiling while there is still room to act, and a refusal at
 * {@link WORKFLOW_JOURNAL_MAX_STEPS}.
 *
 * ## The numbers, and why they are not tuning
 *
 * The ceiling is well above any shipped shape — the widest template fan-out is
 * tens of steps, and a `mapConcurrent` over a long recording is hundreds — so it
 * is a bound on the RUNAWAY case rather than a budget an author is meant to plan
 * against. It is deliberately not configurable: a per-agent ceiling is a knob
 * whose only correct value is "lower than the one that already hurts", and the
 * remedy for a body that needs more is to split the body, which no number here
 * can supply.
 *
 * The warning is at 80% for the ordinary reason a warning exists: at the
 * ceiling there is nothing left to do but fail, and the whole point is to be
 * told before that.
 *
 * @module
 */

/**
 * The most settled steps one run's journal may hold.
 *
 * Reached, the run FAILS with a message naming the ceiling. See this module's
 * doc for why a ceiling exists at all and why it is not an option.
 */
export const WORKFLOW_JOURNAL_MAX_STEPS = 10_000;

/** Where a run starts SAYING it is growing — 80% of the ceiling. */
export const WORKFLOW_JOURNAL_WARN_STEPS = Math.floor(WORKFLOW_JOURNAL_MAX_STEPS * 0.8);

/** What {@link journalBound} decided about one run's journal. */
export type JournalBoundVerdict =
  | { kind: "ok" }
  /** Room left, but say so — `message` is ready to log. */
  | { kind: "warn"; steps: number; message: string }
  /** No room. `message` is the run's failure, and names the remedy. */
  | { kind: "refuse"; steps: number; message: string };

/**
 * Classify a run by how much journal it has.
 *
 * A pure function of the count, so the decision is testable without a store, a
 * walk, or a body — the two callers supply the count they already hold and this
 * owns the thresholds and the wording.
 */
export function journalBound(steps: number): JournalBoundVerdict {
  if (steps >= WORKFLOW_JOURNAL_MAX_STEPS) {
    return {
      kind: "refuse",
      steps,
      message:
        `workflow run has ${steps} journaled steps, at the ceiling of ` +
        `${WORKFLOW_JOURNAL_MAX_STEPS}: every delivery replays the whole journal, so a run ` +
        "this long cannot make progress. Split the body into shorter runs — one run per " +
        "unit of work, started from a step — rather than one run that accumulates.",
    };
  }
  if (steps >= WORKFLOW_JOURNAL_WARN_STEPS) {
    return {
      kind: "warn",
      steps,
      message: "Workflow run journal is approaching its ceiling",
    };
  }
  return { kind: "ok" };
}
