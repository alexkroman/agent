// Copyright 2026 the AAI authors. MIT license.
/**
 * Two walks reaching one unsettled step and both journaling it.
 *
 * @module
 */

import type { Interleaving } from "./interleaving.ts";

/**
 * The at-least-once cost, frozen at the moment it is paid.
 *
 * Two deliveries at `stepConcurrency: 2`, over a `flaky` leaf — a step that
 * throws once and then succeeds, i.e. an ordinary in-process retry. Both walks
 * read a journal with no entry for `s0#0`, both charge an attempt, and both run
 * the body. `workflow-engine.ts` is explicit that this is a cost rather than a
 * correctness problem: *"The one thing a lock WOULD buy is not doing the work
 * twice, which is a cost rather than a correctness problem."* What makes it safe
 * is that the FIRST append is authoritative and the second reads it back.
 *
 * The guard it catches is `appendStep`'s first-writer-wins. Note which check
 * sees its removal: LAW 2 compares a step's
 * `{status, output}`, and two walks of a deterministic body agree on both — it is
 * `checkJournalInvariants` that sees the difference, because the two entries
 * disagree on `attempts` (1 against 2, the second walk having charged after the
 * first) and on `finishedAt`. Those are the fields a resume reads to decide
 * whether a step was abandoned, so an overwrite is a durability defect that the
 * run's own answer cannot show.
 */
export const overlappingStepAppend: Interleaving = {
  name: "overlapping-step-append",
  description: "two walks reach one unsettled step, and the FIRST append stays authoritative",
  program: [{ t: "flaky", name: "", value: 0 }],
  deliveries: 2,
  stepConcurrency: 2,
  arm: "direct",
  ordering: [2, 1, 3, 5, 7, 6, 8, 4, 9, 11, 10, 12, 13, 14, 15, 16, 17, 18],
  catches: {
    defect: "overwritingAppend",
    law: "and read back as",
  },
};
