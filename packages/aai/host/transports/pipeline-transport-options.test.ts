// Copyright 2026 the AAI authors. MIT license.
/**
 * The shipped pipeline defaults.
 *
 * `_pipeline-transport-harness.ts` overrides the turn-taking windows so the
 * behavioural specs don't have to wait them out, which means no other spec in
 * this directory ever sees what a real agent gets. This file is the one that
 * does: it resolves an options object carrying nothing but the required fields
 * and checks each default against the constant it comes from.
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS,
  DEFAULT_ENDPOINT_SETTLE_MS,
  DEFAULT_HOLD_PHRASE,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MIN_BARGE_IN_WORDS,
} from "../../sdk/constants.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import { makeCallbacks } from "./_pipeline-transport-harness.ts";
import { resolvePipelineOptions } from "./pipeline-transport-options.ts";

function resolveBare() {
  return resolvePipelineOptions({
    sid: "test-sid",
    stt: createFakeSttProvider(),
    llm: createFakeLanguageModel({ script: [] }),
    tts: createFakeTtsProvider(),
    callbacks: makeCallbacks(),
    executeTool: async () => {
      throw new Error("No executeTool provided to test");
    },
    sessionConfig: { systemPrompt: "s" },
    providerKeys: { stt: "k", tts: "k" },
  });
}

describe("pipeline defaults", () => {
  test("turn-taking windows come from the shipped constants", () => {
    const resolved = resolveBare();
    expect(resolved.endpointSettleMs).toBe(DEFAULT_ENDPOINT_SETTLE_MS);
    expect(resolved.completeSettleMs).toBe(DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS);
    expect(resolved.interruptionMinDurationMs).toBe(DEFAULT_INTERRUPTION_MIN_DURATION_MS);
    expect(resolved.minBargeInWords).toBe(DEFAULT_MIN_BARGE_IN_WORDS);
    expect(resolved.holdPhrase).toBe(DEFAULT_HOLD_PHRASE);
  });

  test("an utterance's tail can still finish inside the settle window", () => {
    // The complete-final window is what keeps "How many options do you have?
    // Also, I want to return three items." from committing at the question mark
    // and answering half the request. It has to be long enough for the pause
    // between two spoken sentences, and never longer than the general window.
    expect(DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS).toBeLessThanOrEqual(DEFAULT_ENDPOINT_SETTLE_MS);
  });

  test("the barge-in duration gate is on, and short enough to stay responsive", () => {
    // 0 would let room noise and the tail of the agent's own audio abandon a
    // reply mid-word; too large and a caller cannot interrupt at all.
    expect(DEFAULT_INTERRUPTION_MIN_DURATION_MS).toBeGreaterThan(0);
    expect(DEFAULT_INTERRUPTION_MIN_DURATION_MS).toBeLessThanOrEqual(1000);
  });
});
