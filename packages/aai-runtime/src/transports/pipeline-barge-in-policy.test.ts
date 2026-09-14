// Copyright 2026 the AAI authors. MIT license.
/**
 * The three-input precedence, stated one input at a time.
 *
 * It was FOUR, and the removed one is worth naming here: the two barge-in
 * phrase lists used to sit above both thresholds, so an "interruption phrase"
 * interrupted at any word count and a backchannel never did. Nothing in this
 * policy reads the caller's wording now, which is why `partialInterrupts`
 * takes no text — so the specs below are the whole decision, rather than the
 * part of it the words did not already settle.
 */
import { describe, expect, test } from "vitest";
import { createAgentSpeakingPredicate, createBargeInPolicy } from "./pipeline-barge-in-policy.ts";

function makePolicy(
  overrides: {
    agentIsSpeaking?: boolean;
    minBargeInWords?: number;
    interruptionMinDurationMs?: number;
    utteranceDurationMs?: number;
  } = {},
) {
  return createBargeInPolicy({
    agentIsSpeaking: () => overrides.agentIsSpeaking ?? true,
    minBargeInWords: () => overrides.minBargeInWords ?? 2,
    interruptionMinDurationMs: () => overrides.interruptionMinDurationMs ?? 0,
    utteranceDurationMs: () => overrides.utteranceDurationMs ?? 0,
  });
}

describe("step 1: there has to be a floor to take", () => {
  test("a silent agent is never interrupted, whatever was said", () => {
    const policy = makePolicy({ agentIsSpeaking: false });
    expect(policy.partialInterrupts(5)).toBe(false);
    expect(policy.finalInterrupts("stop right there")).toBe(false);
  });
});

describe('step 2: `bargeIn: "off"` refuses everything', () => {
  test("an unreachable threshold refuses however many words arrive", () => {
    const policy = makePolicy({ minBargeInWords: Number.POSITIVE_INFINITY });
    expect(policy.partialInterrupts(9)).toBe(false);
    expect(policy.finalInterrupts("stop talking")).toBe(false);
  });
});

describe("step 3: the two thresholds", () => {
  // Nothing here reads the caller's WORDING any more — the phrase lists that
  // used to sit over these gates are gone, so "stop" and "mm-hmm" are decided
  // by word count and duration like any other utterance.
  test("the word count applies on both paths", () => {
    const policy = makePolicy({ minBargeInWords: 3 });
    expect(policy.partialInterrupts(2)).toBe(false);
    expect(policy.partialInterrupts(3)).toBe(true);
    expect(policy.finalInterrupts("two words")).toBe(false);
    expect(policy.finalInterrupts("three words here")).toBe(true);
  });

  test("a one-word interruption no longer bypasses the gates", () => {
    // The behaviour change this removal MAKES, pinned so it is a decision
    // rather than a regression: "stop" used to interrupt at any word count.
    const policy = makePolicy({
      minBargeInWords: 9,
      interruptionMinDurationMs: 5000,
      utteranceDurationMs: 0,
    });
    expect(policy.partialInterrupts(1)).toBe(false);
  });

  test("a backchannel no longer gets a pass either", () => {
    // The other half of the same change: "mm-hmm" is now just a short
    // utterance, so a threshold of 1 lets it through.
    const policy = makePolicy({ minBargeInWords: 1 });
    expect(policy.partialInterrupts(1)).toBe(true);
    expect(policy.finalInterrupts("mm-hmm")).toBe(true);
  });

  test("the duration gate applies to an INTERIM only", () => {
    const policy = makePolicy({
      minBargeInWords: 1,
      interruptionMinDurationMs: 500,
      utteranceDurationMs: 100,
    });
    expect(policy.partialInterrupts(3)).toBe(false);
    // A committed final is demonstrably real speech, so there is nothing for a
    // sustained-speech gate to establish.
    expect(policy.finalInterrupts("let me ask")).toBe(true);
  });

  test("0 disables the duration gate", () => {
    const policy = makePolicy({
      minBargeInWords: 1,
      interruptionMinDurationMs: 0,
      utteranceDurationMs: 0,
    });
    expect(policy.partialInterrupts(1)).toBe(true);
  });
});

describe("createAgentSpeakingPredicate", () => {
  const predicate = (state: {
    playback?: boolean;
    inFlight?: boolean;
    spoke?: boolean;
    recordable?: boolean;
  }) =>
    createAgentSpeakingPredicate({
      isPlaybackPending: () => state.playback ?? false,
      isTurnInFlight: () => state.inFlight ?? false,
      hasTurnSpoken: () => state.spoke ?? false,
      hasSpokenRecordable: () => state.recordable ?? true,
    })();

  test("a turn that has not spoken does NOT hold the floor", () => {
    expect(predicate({ inFlight: true, spoke: false })).toBe(false);
  });

  test("a turn that has spoken does, and so does audio still playing out", () => {
    expect(predicate({ inFlight: true, spoke: true })).toBe(true);
    expect(predicate({ playback: true })).toBe(true);
  });

  test("FILLER is not speaking — the measured case", () => {
    // Dead-air cover is audio, so it drives the playback clock and
    // `markSpoke` alike; without the recordable term a caller talking over a
    // holding phrase aborted the real reply being generated behind it.
    expect(predicate({ inFlight: true, spoke: true, recordable: false })).toBe(false);
    expect(predicate({ playback: true, recordable: false })).toBe(false);
  });
});
