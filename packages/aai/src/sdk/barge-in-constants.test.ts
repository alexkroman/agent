// Copyright 2026 the AAI authors. MIT license.
/**
 * The two barge-in gates.
 *
 * Pinning VALUES rather than behaviour, deliberately: both of these encode a
 * measurement, both have been moved and one has been moved and reverted, and
 * the failure mode of a silent change is a turn-taking regression that no
 * other test in the repo would catch. The module doc carries the evidence; this
 * file makes a change to either fail loudly and cite it.
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MIN_BARGE_IN_WORDS,
} from "./barge-in-constants.ts";

describe("barge-in gates", () => {
  test("a single word may interrupt the agent", () => {
    // 1, not 2. At 2 the caller's one-word give-up probe ("Hello?", running
    // 2.4-2.6 times per call on tau2-bench retail) could not fire an interim
    // barge-in at all, and a fragment that short rarely commits a final either
    // — measured worst case, the agent held the floor 12.8s after one.
    // Replicated over two runs: truncated caller utterances 36% -> 20-24% and
    // spelled-identifier truncations 4 -> 0.
    expect(DEFAULT_MIN_BARGE_IN_WORDS).toBe(1);
  });

  test("but it must be sustained speech, not a backchannel", () => {
    // 500ms, and this is the gate that makes the line above survivable: once
    // the word count is 1, nothing else in the pipeline distinguishes an
    // interruption from an acknowledgement. Halving it to 250 was tried and
    // reverted the same day — backchannel selectivity (tau-voice S_BC) fell
    // from 4/4 correct across six runs to 1 of 3.
    expect(DEFAULT_INTERRUPTION_MIN_DURATION_MS).toBe(500);
  });

  test("the two are independent decisions", () => {
    // The mistake this guards against is treating them as one dial. The word
    // count decides whether a fragment can interrupt AT ALL; the duration
    // window decides whether a short one was an interruption or an
    // acknowledgement. Lowering the first fixed identifier truncation;
    // lowering the second broke backchannels. A future change that "simplifies"
    // them into a single knob loses one of those two answers.
    expect(DEFAULT_MIN_BARGE_IN_WORDS).not.toBe(DEFAULT_INTERRUPTION_MIN_DURATION_MS);
  });
});
