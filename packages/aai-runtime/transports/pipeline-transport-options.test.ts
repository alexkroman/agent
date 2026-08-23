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

import { DEFAULT_DEAD_AIR_COVER_MS } from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import { makeCallbacks } from "./_transport-recorder.ts";
import {
  type PipelineTransportOptions,
  resolvePipelineOptions,
} from "./pipeline-transport-options.ts";

function resolveBare(extra?: Partial<PipelineTransportOptions>) {
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
    ...extra,
  });
}

describe("pipeline defaults", () => {
  test("turn-taking windows come from the shipped constants", () => {
    const resolved = resolveBare();
    expect(resolved.interruptionMinDurationMs).toBe(DEFAULT_INTERRUPTION_MIN_DURATION_MS);
    expect(resolved.minBargeInWords).toBe(DEFAULT_MIN_BARGE_IN_WORDS);
    // The shipped dead-air cover default, pinned at the resolver. It was for a
    // while unreachable: the cover's enable was `holdPhrase.length > 0` and
    // `holdPhrase` defaulted to `""`, so no default agent had cover at all.
    expect(resolved.deadAirCoverMs).toBe(DEFAULT_DEAD_AIR_COVER_MS);
  });

  test("preemptive generation is OFF in the shipped default", () => {
    // The one assertion that pins the shipped state of this feature. It was ON
    // by author decision; the adoption log it shipped without was finally
    // collected over a tau2-bench retail run and the feature buys **+8ms per
    // caller turn** — 14 adoptions at a p50 0.44s head start, of which 5 (36%)
    // were poisoned after adoption by a tool call and restarted the turn,
    // having burned p50 0.69s each. For that it threw away 44% of the LLM
    // requests it issued. See `preemptiveGeneration` in
    // pipeline-transport-options.ts for the full arithmetic and for why
    // gating adoption on "has it produced text" cannot rescue it.
    // An explicit `true` still opts in.
    expect(resolveBare().preemptiveGeneration).toBe(false);
    expect(resolveBare({ preemptiveGeneration: true }).preemptiveGeneration).toBe(true);
  });

  test("an utterance's tail can still finish inside the STT silence window", () => {
    // Endpointing lives in the STT provider now (`min_turn_silence`), and this
    // window is what keeps "How many options do you have? Also, I want to
    // return three items." from committing at the question mark and answering
    // half the request. It has to be long enough for the pause between two
    // spoken sentences.
    //
    // The floor is 1000, and it briefly moved to 800 to follow a default that
    // was set to 800 and then reverted on tau2 reward (0.68 -> 0.12; see the
    // block comment on DEFAULT_MIN_TURN_SILENCE_MS). It is back where it was:
    // 800 is below every window the measurements justified, and this assertion
    // guards DRIFT rather than correctness — it cannot tell you whether a value
    // above the floor is right.
    expect(DEFAULT_MIN_TURN_SILENCE_MS).toBeGreaterThanOrEqual(1000);
  });

  test("the barge-in duration gate is on, and short enough to stay responsive", () => {
    // 0 would let room noise and the tail of the agent's own audio abandon a
    // reply mid-word; too large and a caller cannot interrupt at all.
    expect(DEFAULT_INTERRUPTION_MIN_DURATION_MS).toBeGreaterThan(0);
    expect(DEFAULT_INTERRUPTION_MIN_DURATION_MS).toBeLessThanOrEqual(1000);
  });
});
