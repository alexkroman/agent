// Copyright 2026 the AAI authors. MIT license.
/**
 * Two deliveries both reaching the end of one body.
 *
 * @module
 */

import type { Interleaving } from "./interleaving.ts";

/**
 * The compare-and-set that lets exactly one delivery finish a run, frozen.
 *
 * Two deliveries over a single ordinary step. The first walk journals `s0#0` and
 * writes `completed`; the second walk's `readSteps` catches the entry, replays
 * past it without executing anything, reaches the same answer, and writes
 * `completed` too — where `expect: ["running"]` refuses it and it reads the
 * verdict back instead.
 *
 * What the guard it catches is for, from `JournalStore.setStatus`: *"the failure
 * it prevents is a cancelled run being marked `completed` by a worker that had
 * not noticed."* This scenario is the benign version of that race — both
 * deliveries agree on the answer — which is what makes it a good regression: the
 * ordering is short, it reproduces on every run, and the only thing standing
 * between it and a run whose recorded verdict is not the one its cancel decided
 * is the compare-and-set.
 */
export const doubleTerminalMove: Interleaving = {
  name: "double-terminal-move",
  description: "two deliveries both reach the end of the body, and one compare-and-set wins",
  program: [{ t: "step", name: "", value: 0 }],
  deliveries: 2,
  stepConcurrency: 1,
  arm: "direct",
  ordering: [2, 1, 4, 3, 7, 10, 9, 5, 8, 11, 12, 13, 6, 14, 15, 16, 17],
  catches: { defect: "unguardedStatus", law: "moved the run terminal" },
};
