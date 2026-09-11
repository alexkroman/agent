// Copyright 2026 the AAI authors. MIT license.
/**
 * The four-input precedence, stated one input at a time.
 *
 * The end-to-end half — that the transport really reaches this, with the
 * shipped lists — is `pipeline-user-speech.test.ts`'s "acknowledgement and
 * interruption phrases"; the lists and their matching semantics are
 * `aai`'s `barge-in-phrases.test.ts`. What is here is the ORDER, which is the
 * part of this transport most likely to be got wrong by someone editing one
 * of the four inputs.
 */

import {
  DEFAULT_ACKNOWLEDGEMENT_PHRASES,
  DEFAULT_INTERRUPTION_PHRASES,
} from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { createAgentSpeakingPredicate, createBargeInPolicy } from "./pipeline-barge-in-policy.ts";

function makePolicy(
  overrides: {
    agentIsSpeaking?: boolean;
    minBargeInWords?: number;
    interruptionMinDurationMs?: number;
    utteranceDurationMs?: number;
    phrases?: { acknowledgement: readonly string[]; interruption: readonly string[] };
  } = {},
) {
  return createBargeInPolicy({
    agentIsSpeaking: () => overrides.agentIsSpeaking ?? true,
    minBargeInWords: () => overrides.minBargeInWords ?? 2,
    interruptionMinDurationMs: () => overrides.interruptionMinDurationMs ?? 0,
    utteranceDurationMs: () => overrides.utteranceDurationMs ?? 0,
    phrases: overrides.phrases ?? { acknowledgement: [], interruption: [] },
  });
}

const SHIPPED = {
  acknowledgement: DEFAULT_ACKNOWLEDGEMENT_PHRASES,
  interruption: DEFAULT_INTERRUPTION_PHRASES,
};

describe("step 1: there has to be a floor to take", () => {
  test("a silent agent is never interrupted, whatever was said", () => {
    const policy = makePolicy({ agentIsSpeaking: false, phrases: SHIPPED });
    expect(policy.partialInterrupts(5, "stop right there")).toBe(false);
    expect(policy.finalInterrupts("stop right there")).toBe(false);
  });
});

describe('step 2: `bargeIn: "off"` refuses everything', () => {
  test("an unreachable threshold silences the interruption list too", () => {
    const policy = makePolicy({
      minBargeInWords: Number.POSITIVE_INFINITY,
      phrases: SHIPPED,
    });
    expect(policy.partialInterrupts(9, "stop")).toBe(false);
    expect(policy.finalInterrupts("stop talking")).toBe(false);
  });
});

describe("step 3: the words, over both gates", () => {
  test("an interruption phrase beats the word count AND the duration gate", () => {
    const policy = makePolicy({
      minBargeInWords: 9,
      interruptionMinDurationMs: 5000,
      utteranceDurationMs: 0,
      phrases: SHIPPED,
    });
    expect(policy.partialInterrupts(1, "stop")).toBe(true);
  });

  test("an acknowledgement loses to neither gate — it just never interrupts", () => {
    const policy = makePolicy({ minBargeInWords: 1, phrases: SHIPPED });
    expect(policy.partialInterrupts(1, "mm-hmm")).toBe(false);
    expect(policy.finalInterrupts("mm-hmm")).toBe(false);
  });
});

describe("step 4: the two thresholds, when the words say nothing", () => {
  test("the word count applies on both paths", () => {
    const policy = makePolicy({ minBargeInWords: 3 });
    expect(policy.partialInterrupts(2, "two words")).toBe(false);
    expect(policy.partialInterrupts(3, "three words here")).toBe(true);
    expect(policy.finalInterrupts("two words")).toBe(false);
    expect(policy.finalInterrupts("three words here")).toBe(true);
  });

  test("the duration gate applies to an INTERIM only", () => {
    const policy = makePolicy({
      minBargeInWords: 1,
      interruptionMinDurationMs: 500,
      utteranceDurationMs: 100,
    });
    expect(policy.partialInterrupts(3, "let me ask")).toBe(false);
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
    expect(policy.partialInterrupts(1, "hello")).toBe(true);
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
