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
 * import { assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * export default agent({
 *   name: "Jane",
 *   stt: assemblyAIStt({ model: "universal-3-5-pro" }),
 *   llm: assemblyAILlm({ model: "gpt-5.5" }),
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

import { type AssemblyAILlmProvider, assemblyAILlm } from "./llm/assemblyai.ts";
import { type AssemblyAIProvider, assemblyAIStt } from "./stt/assemblyai.ts";
import {
  type AssemblyAITtsProvider,
  type AssemblyAITtsVoice,
  assemblyAITts,
} from "./tts/assemblyai.ts";

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
}

/**
 * All three pipeline stages on AssemblyAI, ready to spread into `agent()`.
 *
 * Every stage bills to `ASSEMBLYAI_API_KEY` — the one key a published agent is
 * guaranteed to have — so this configuration runs the moment it is deployed.
 */
export function assemblyAIPipeline(opts: AssemblyAIPipelineOptions = {}): {
  stt: AssemblyAIProvider;
  llm: AssemblyAILlmProvider;
  tts: AssemblyAITtsProvider;
} {
  const { voice, region } = opts;
  return {
    stt: assemblyAIStt(region ? { region } : {}),
    llm: assemblyAILlm(region ? { region } : {}),
    tts: assemblyAITts(voice ? { voice } : {}),
  };
}
