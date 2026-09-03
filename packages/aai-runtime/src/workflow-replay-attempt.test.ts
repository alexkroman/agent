// Copyright 2026 the AAI authors. MIT license.
/**
 * The attempt lease's WINDOW, which is a number no behavioural test can pin.
 *
 * `workflow-replay.test.ts` covers what the charge DOES — a step refused when
 * its budget is held by live charges, and run when those charges have aged out —
 * and it passes under any window, because it moves the clock rather than
 * depending on the constant. That is the right shape for those tests and it
 * leaves the constant itself unguarded: shrinking it to a minute breaks nothing
 * and would silently make a live walk's charge expire mid-step, after which the
 * ceiling bounds nothing at all.
 *
 * So what is asserted here is the CONSTRAINT rather than the value. The window
 * has to clear the longest thing a single step can legitimately spend, and this
 * package already names one: `STEP_FETCH_INACTIVITY_MS`, the bound on one
 * outbound call making no progress. A step may take several of those in
 * sequence, so clearing one is a floor and not a proof — which is why the
 * assertion is a comparison and not an equality.
 */

import { STEP_FETCH_INACTIVITY_MS } from "@alexkroman1/aai/host-internal";
import { expect, test } from "vitest";
import { ATTEMPT_LEASE_MS } from "./workflow-replay-attempt.ts";

test("the lease clears the longest a single outbound step call may stall", () => {
  // A charge that expires while its walk is still running takes the ceiling
  // with it: every later delivery reads 1, believes it is the first reach, and
  // the budget stops bounding abandonment. Erring long is the cheap direction —
  // `ATTEMPT_LEASE_MS` carries that argument.
  expect(ATTEMPT_LEASE_MS).toBeGreaterThan(STEP_FETCH_INACTIVITY_MS);
});

test("and it is finite, because the whole point is that a charge is not forever", () => {
  // The bug this replaced: a scalar counter could not expire, so a walk that
  // died holding a charge held it permanently and `maxAttempts` deaths refused
  // the step for the life of the run.
  expect(Number.isFinite(ATTEMPT_LEASE_MS)).toBe(true);
});
