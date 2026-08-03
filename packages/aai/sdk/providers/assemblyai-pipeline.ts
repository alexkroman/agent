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
 * imports, two of them aliasing the same exported name, plus three magic
 * strings:
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAI } from "@alexkroman1/aai/stt";
 * import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
 * export default agent({
 *   name: "Vera",
 *   stt: assemblyAI({ model: "universal-3-5-pro" }),
 *   llm: assemblyAILlm({ model: "gpt-5.5" }),
 *   tts: assemblyAITts({ voice: "vera" }),
 * });
 * ```
 *
 * Prose telling an author to prefer the second was not going to beat that gap,
 * and it did not. So the gap is closed instead:
 *
 * ```ts
 * import { agent, assemblyAIPipeline } from "@alexkroman1/aai";
 * export default agent({ name: "Vera", ...assemblyAIPipeline({ voice: "vera" }) });
 * ```
 *
 * It also removes the one runtime hazard in the long form. A gateway model id
 * is a free-form string the service rejects with a 400 at the first session —
 * no compile-time check, no deploy-time check — so an invented one ships. The
 * preset supplies a real default for all three stages.
 *
 * The three stages stay individually overridable, because an agent that wants
 * Cartesia for TTS and AssemblyAI for the rest should not have to abandon the
 * preset: spread it, then set the one field.
 *
 * ```ts
 * import { agent, assemblyAIPipeline } from "@alexkroman1/aai";
 * import { cartesia } from "@alexkroman1/aai/tts";
 * agent({ name: "Vera", ...assemblyAIPipeline(), tts: cartesia() });
 * ```
 */

import { type AssemblyAILlmProvider, assemblyAI as assemblyAILlm } from "./llm/assemblyai.ts";
import { type AssemblyAIProvider, assemblyAI as assemblyAIStt } from "./stt/assemblyai.ts";
import {
  type AssemblyAITtsProvider,
  type AssemblyAITtsVoice,
  assemblyAI as assemblyAITts,
} from "./tts/assemblyai.ts";

export interface AssemblyAIPipelineOptions {
  /**
   * Gateway LLM model. Defaults to `ASSEMBLYAI_LLM_DEFAULT_MODEL`
   * (`"gpt-5.5"`) — see `@alexkroman1/aai/llm` for the catalog.
   */
  model?: string;
  /**
   * TTS voice id, e.g. `"vera"`, `"michael"`, `"alba"`. Defaults to
   * `"vera"`. Each voice speaks exactly one language — see
   * `ASSEMBLYAI_TTS_VOICES` (from `@alexkroman1/aai/tts`) for the
   * catalog; a name outside it fails in-band after connect and leaves the
   * agent silent.
   */
  voice?: AssemblyAITtsVoice;
  /** Streaming STT model. Defaults to `"universal-3-5-pro"`. */
  sttModel?: string;
  /**
   * EU data residency. Applies to STT and the LLM gateway; TTS has a single
   * endpoint. Note the EU gateway serves only Claude and most Gemini models,
   * so an EU agent must also name a `model` the EU endpoint carries.
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
  const { model, voice, sttModel, region } = opts;
  return {
    stt: assemblyAIStt({ ...(sttModel ? { model: sttModel } : {}), ...(region ? { region } : {}) }),
    llm: assemblyAILlm({ ...(model ? { model } : {}), ...(region ? { region } : {}) }),
    tts: assemblyAITts({ ...(voice ? { voice } : {}) }),
  };
}
