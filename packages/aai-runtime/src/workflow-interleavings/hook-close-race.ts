// Copyright 2026 the AAI authors. MIT license.
/**
 * A signal landing inside the few scheduling points between a wait's
 * `claimHook` and its `closeHook`.
 *
 * @module
 */

import type { Interleaving } from "./interleaving.ts";

/**
 * The window `closeHook`'s compare-and-set decides, frozen.
 *
 * Two deliveries of a body whose only statement is a `waitFor` with a deadline
 * already in the past, and a signaller retrying into the same round. The
 * interesting instant is between the walk reading the wait and the walk shutting
 * it: a `deliverHook` released there means the window was ANSWERED, and the
 * close must be refused so that this walk and every later replay read the same
 * branch.
 *
 * The guard it catches is `closeHook`'s compare-and-set on `delivered` — the
 * version this repo shipped without it *"prevented only half the divergence it
 * is documented to prevent"*, and what a signal landing inside the window then
 * produced was this walk taking the TIMED-OUT branch while every later replay
 * read the ANSWERED one.
 *
 * Regenerated when `execute`'s opening collapsed to ONE round trip
 * (`workflow-engine.ts`): a delivery issues four journal calls where it issued
 * one and then three, so the old ordering named ids in an order this arm never
 * schedules and the replay STARVED rather than failing — the shape this type's
 * own doc warns about, and why an ordering is read off a run and never edited.
 */
export const hookCloseRace: Interleaving = {
  name: "hook-close-race",
  description:
    "a signal answers a timeout window between the walk reading it and the walk closing it",
  program: [{ t: "hook", token: "", mode: "timeout" }],
  deliveries: 2,
  stepConcurrency: 1,
  arm: "direct",
  ordering: [2, 1, 8, 11, 9, 5, 10, 3, 4, 6, 13, 7, 12, 15, 16, 14, 17, 18, 20, 19, 21, 22, 23, 24],
  catches: { defect: "unconditionalClose", law: "was both delivered and closed" },
};
