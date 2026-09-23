// Copyright 2026 the AAI authors. MIT license.
/**
 * The all-AssemblyAI cascaded pipeline, as one call.
 *
 * This exists because of a measured failure, not for tidiness. Agents built
 * from a plain description kept coming out in S2S mode when nothing had asked
 * for it — the most persistent defect across the starter evals — and the
 * reason was arithmetic rather than misunderstanding. S2S was the absence of
 * configuration (an `agent()` with no provider fields ran on the
 * speech-to-speech service), while the recommended pipeline cost four
 * imports plus three magic strings:
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 * import { llm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * export default agent({
 *   name: "Jane",
 *   stt: assemblyAIStt({ model: "universal-3-5-pro" }),
 *   llm: llm({ provider: "assemblyai", model: "qwen3-next-80b-a3b" }),
 *   tts: assemblyAITts({ voice: "jane" }),
 * });
 * ```
 *
 * Prose telling an author to prefer the second was not going to beat that
 * gap, and it did not. So the gap was closed twice over: first with this
 * preset, then structurally — an `agent()` that declares no providers runs
 * this pipeline by default, unset stages of a partial triple are filled from
 * it, and the default pipeline's voice is one field
 * (`agent({ voice: "jane" })`). The golden path needs no preset at all:
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * export default agent({ name: "Jane", voice: "jane" });
 * // Swap one stage; the other two stay on AssemblyAI:
 * agent({ name: "Jane", llm: "claude-sonnet-4-6" });
 * ```
 *
 * The preset remains the explicit spelling of that default — spread it to
 * make the three stages visible in the config, or to set `region` once
 * across STT and the LLM gateway:
 *
 * ```ts
 * import { agent, assemblyAIPipeline } from "@alexkroman1/aai";
 * agent({ name: "Jane", ...assemblyAIPipeline({ region: "eu" }), llm: "claude-sonnet-4-6" });
 * ```
 *
 * It also documents the one runtime hazard in the long form. A gateway model
 * id is a free-form string the service rejects with a 400 at the first
 * session — no compile-time check, no deploy-time check — so an invented one
 * ships. The default fill supplies a real model for every unset stage.
 *
 * There is deliberately no `model`/`sttModel` option on the preset itself
 * (its early ones were retired: the preset's `model` meant the LLM model
 * while `assemblyAIStt({ model })` meant the STT model, and one word meaning
 * two things per import path is the same trap the factory renames removed).
 */

import { omitUndefined } from "../omit-undefined.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "../providers.ts";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "./llm/assemblyai.ts";
import { llm } from "./llm/llm.ts";
import { assemblyAIStt } from "./stt/assemblyai.ts";
import { type AssemblyAITtsVoice, assemblyAITts } from "./tts/assemblyai.ts";

export interface AssemblyAIPipelineOptions {
  /**
   * TTS voice id, e.g. `"jane"`, `"michael"`, `"alba"`. Defaults to
   * `"jane"` (US-accented English). Each voice speaks exactly one
   * language — see
   * `ASSEMBLYAI_TTS_VOICES` (from `@alexkroman1/aai/tts`) for the
   * catalog; a name outside it fails in-band after connect and leaves the
   * agent silent. (`agent({ voice })` is the same setting without the
   * preset.)
   */
  voice?: AssemblyAITtsVoice;
  /**
   * EU data residency. Applies to STT and the LLM gateway; TTS has a single
   * endpoint. Note the EU gateway serves only Claude and most Gemini models,
   * so an EU agent must also override `llm` with a model the EU endpoint
   * carries (e.g. `llm: "claude-sonnet-4-6"` after the spread). An override
   * that replaces a whole stage descriptor must re-declare `region` itself —
   * `stt: assemblyAIStt({ model, region: "eu" })` — since it replaces the
   * preset's descriptor including its region.
   */
  region?: "us" | "eu";
  /**
   * End-of-turn window for the STT stage, in ms — the same two settings
   * `agent({ minTurnSilenceMs, maxTurnSilenceMs })` reaches without the
   * preset, here for a config that already spreads it (an EU region, say).
   *
   * `maxTurnSilenceMs` is the PAUSE-TOLERANCE knob: it bounds only utterances
   * that never read as complete, so raising it is paid for by hesitant speech
   * alone. `minTurnSilenceMs` is the end-of-turn CHECK and taxes every
   * finished utterance. Read `DEFAULT_MAX_TURN_SILENCE_MS` and
   * `DEFAULT_MIN_TURN_SILENCE_MS` before moving either — both are measured.
   */
  minTurnSilenceMs?: number;
  /** See {@link AssemblyAIPipelineOptions.minTurnSilenceMs}. */
  maxTurnSilenceMs?: number;
}

/**
 * All three pipeline stages on AssemblyAI, ready to spread into `agent()`.
 *
 * Every stage bills to `ASSEMBLYAI_API_KEY` — the one key a published agent is
 * guaranteed to have — so this configuration runs the moment it is deployed.
 */
export function assemblyAIPipeline(options: AssemblyAIPipelineOptions = {}): {
  stt: SttProvider;
  llm: LlmProvider;
  tts: TtsProvider;
} {
  const { voice, region, minTurnSilenceMs, maxTurnSilenceMs } = options;
  return {
    stt: assemblyAIStt(omitUndefined({ region, minTurnSilenceMs, maxTurnSilenceMs })),
    // `reasoningEffort: "none"` because on a voice line time-to-first-token IS
    // the quality, and the default model is a hybrid-thinking one. Measured
    // against tau2-bench retail: 12 of 53 turns waited over 5s for the agent's
    // first word, worst 19.1s — and in every gap over 8s the first word was
    // ordinary content with no tool call yet, so the wait was the model
    // thinking, not work being done.
    //
    // The dead-air cover does reach that window — it is armed as the turn's
    // stream opens, not at the first tool call — but cover is not a substitute
    // for a low time-to-first-token, it is a way of not sounding hung up while
    // one elapses. The illustration is in the same run: one of those gaps was
    // the filler itself ("One moment.", the hold phrase of the day) arriving
    // 10.9s late.
    //
    // **The value must be one the default ACCEPTS, and that is not uniform.**
    // `ASSEMBLYAI_LLM_DEFAULT_MODEL` carries the matrix; the short version is
    // that this id takes `"none"` and reaches 0 reasoning tokens, the
    // `gpt-5.6` family REQUIRES `"none"` for tool calls, and a Gemini id
    // refuses it outright with a 400 that the streaming path turns into an
    // opaque 500. So the id and this argument move TOGETHER — the default has
    // moved four times and this line changed with it three of those times.
    //
    // On the current default this argument AGREES with the factory rather than
    // doing the work: the id is inside `TOOLS_REQUIRE_NO_REASONING`, where
    // `"none"` is a tool-calling requirement and the factory fills it in. It
    // stays anyway, because under a default OUTSIDE that set it is the only
    // thing turning reasoning off — and the measured cost of losing it there is
    // 1786ms p50 time-to-first-token against 999ms. Deleting it as redundant
    // makes the next id change a silent regression.
    llm: llm({
      provider: "assemblyai",
      model: ASSEMBLYAI_LLM_DEFAULT_MODEL,
      providerOptions: { reasoningEffort: "none", ...omitUndefined({ region }) },
    }),
    tts: assemblyAITts(voice ? { voice } : {}),
  };
}
