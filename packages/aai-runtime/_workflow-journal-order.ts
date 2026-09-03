// Copyright 2026 the AAI authors. MIT license.
/**
 * The three orderings the journal PROMISES, as comparators.
 *
 * Extracted from `workflow-journal-memory.ts` at the 500-line cap, and the seam
 * is the one the interface already draws: `readSteps`, `listRuns` and
 * `resumableRuns` each document an order, both databases implement it as an
 * `order by`, and the memory backend has to reproduce it in JavaScript. These
 * are that reproduction and nothing else — pure functions of two values, with no
 * knowledge of the store they sort for.
 *
 * They are also the place the ONE cross-backend hazard lives. An order that
 * differs by deployment is exactly the drift the conformance suite exists to
 * catch — it compares the three arms' answers directly — and it has been found
 * once: `readSteps` was documented as "the order they settled", which memory
 * implemented as insertion order while both databases ran
 * `order by finished_at, key`, so two steps of one fan-out settling inside one
 * millisecond came back in opposite orders depending on where the run was
 * deployed.
 *
 * @internal
 */

import type { ResumableRun, RunRecord, StepEntry } from "./workflow-journal-types.ts";

/**
 * Earliest deadline first, the id breaking a tie.
 *
 * A run with NO deadline is due NOW, so it sorts as `0` rather than last: what
 * the ordering decides is which runs survive `limit`, and the most overdue are
 * the ones that have been stranded longest.
 */
export function soonestFirst(a: ResumableRun, b: ResumableRun): number {
  const at = (run: ResumableRun) => run.wakeAt ?? 0;
  return at(a) - at(b) || codeUnit(a.runId, b.runId);
}

/**
 * `finishedAt`, ties broken by `key` — which is what both databases do
 * (`order by finished_at, key`).
 *
 * A named comparator rather than an inline one because the tie-break is a nested
 * ternary inline, which Biome's `noNestedTernary` rejects.
 */
export function settledFirst(a: StepEntry, b: StepEntry): number {
  return a.finishedAt - b.finishedAt || codeUnit(a.key, b.key);
}

/**
 * Code-unit order, and never `localeCompare`: with no explicit locale that
 * answers to the runtime's ICU default, so the same two values would order
 * differently on two machines.
 */
export function codeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Newest first, with the id breaking a tie.
 *
 * `createdAt` alone is not a total order — two runs started in the same
 * millisecond are ordinary under a fan-out — so the id is what makes the
 * listing STABLE across calls rather than merely sorted. Both terms are
 * REVERSED, which is what makes it newest first.
 */
export function newestFirst(a: RunRecord, b: RunRecord): number {
  return b.createdAt - a.createdAt || codeUnit(b.runId, a.runId);
}
