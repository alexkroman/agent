// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { toAgentConfig } from "../agent-config.ts";
import { agent } from "../define.ts";
import { assemblyAIPipeline } from "./assemblyai-pipeline.ts";
import { resolveAssemblyAISttSettings } from "./stt/assemblyai.ts";

describe("assemblyAIPipeline", () => {
  test("the default pipeline turns reasoning OFF", () => {
    // Time-to-first-token IS the quality on a voice line. The dead-air cover
    // does reach the pre-first-token window, but cover is not a substitute for
    // a low TTFT — it only keeps the line from sounding hung up while one
    // elapses. Pinned as a test because the symptom of losing it is seconds of
    // silence rather than an error.
    const { llm: stage } = assemblyAIPipeline();
    const effort = (d: typeof stage) => d.options.providerOptions?.reasoningEffort;
    // This pin and the model pin below are ONE fact: the value has to be one
    // the id accepts, and the families disagree — `"none"` here reaches 0
    // reasoning tokens, a Gemini id answers 400 to it. See
    // ASSEMBLYAI_LLM_DEFAULT_MODEL for the matrix.
    expect(effort(stage)).toBe("none");
    // The descriptor must carry a model that accepts the parameter. Pinned
    // alongside the effort because the two are coupled, and the direction of
    // the coupling has now flipped twice: into the `gpt-5.6` family (INSIDE
    // TOOLS_REQUIRE_NO_REASONING, where `"none"` was a tool-calling
    // requirement the factory filled) and back out to a Gemini id, which
    // REFUSES `"none"` and makes the preset's explicit value load-bearing
    // again — this time to avoid a 500 rather than to buy latency. The factory now fills `"none"` on its
    // own, so the preset's explicit argument merely agrees with it: an id
    // property rather than a pipeline one, exactly as the previous version of
    // this comment predicted it would become.
    //
    // The preset keeps the explicit `"none"` anyway, because what it defends
    // against is the default moving back OFF the set — as it was at
    // `qwen3-next-80b-a3b`, where the factory filled nothing and this argument
    // was the only thing standing between the default pipeline and per-turn
    // thinking latency (measured 1786ms p50 time-to-first-token on gpt-5.5's
    // server-side default against 999ms with reasoning off).
    //
    // For THIS id the stakes are higher than latency: the gateway answers 500
    // to a tool-carrying request on it unless the effort is off, so the pair
    // below is what stands between the default pipeline and a call that
    // connects and cannot answer.
    expect(stage.options.model).toBe("gpt-5.6-luna");

    // An agent with no providers at all gets the same treatment. Asserted
    // through toAgentConfig, not agent(): the default fill runs at the
    // mode-derivation sites (toAgentConfig, and the runtime's provider
    // resolution), so `agent()` itself leaves the stage unset.
    expect(toAgentConfig(agent({ name: "t" })).llm).toStrictEqual(stage);

    // Region must not drop it.
    expect(effort(assemblyAIPipeline({ region: "eu" }).llm)).toBe("none");
  });

  test("assemblyAIPipeline carries the endpointing options onto its STT stage", () => {
    // The preset is the escape hatch the shorthand cannot serve: a config that
    // already spreads it (for `region`) sets the window here instead.
    const { stt } = assemblyAIPipeline({ region: "eu", maxTurnSilenceMs: 4500 });
    const settings = resolveAssemblyAISttSettings(stt.options);
    expect(settings.maxTurnSilenceMs).toBe(4500);
    expect(settings.region).toBe("eu");
  });

  test("is the AssemblyAI stage at every position", () => {
    const { stt, llm, tts } = assemblyAIPipeline();
    expect([stt.kind, llm.kind, tts.kind]).toEqual(["assemblyai", "assemblyai", "assemblyai"]);
  });

  test("puts a named voice on the TTS stage, and the region on the LLM's options", () => {
    const { llm, tts } = assemblyAIPipeline({ voice: "jess", region: "eu" });
    expect(tts.options).toEqual({ voice: "jess" });
    expect(llm.options.providerOptions).toMatchObject({ region: "eu" });
  });
});
