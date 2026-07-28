// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI streaming TTS factory — returns a pure descriptor.
 *
 * See `sdk/providers/stt/assemblyai.ts` for the descriptor/opener split; the
 * host-side resolver in `host/providers/resolve.ts` turns this into an
 * openable `TtsOpener` during `createRuntime` using the `ASSEMBLYAI_API_KEY`
 * from the agent's env — the same key AssemblyAI STT and the LLM Gateway use,
 * so a full AssemblyAI pipeline needs exactly one secret.
 *
 * Note: this factory shares its name with the STT factory in
 * `@alexkroman1/aai/stt` and the LLM factory in `@alexkroman1/aai/llm`. When
 * using more than one, alias on import:
 *
 * ```ts
 * import { assemblyAI } from "@alexkroman1/aai/stt";
 * import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import type { TtsProvider } from "../../providers.ts";

export const ASSEMBLYAI_TTS_KIND = "assemblyai" as const;

/** Agent-env variable holding the AssemblyAI API key (same key as STT/LLM). */
export const ASSEMBLYAI_TTS_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** Production streaming-TTS host. */
export const ASSEMBLYAI_TTS_HOST = "streaming-tts.assemblyai.com";

/**
 * Default voice when `assemblyAI()` is called with no `voice`. Every voice in
 * the catalog speaks exactly one language, so changing `language` generally
 * means changing `voice` too.
 */
export const ASSEMBLYAI_TTS_DEFAULT_VOICE = "vera";

export interface AssemblyAITtsOptions {
  /**
   * Voice id, e.g. `"vera"`, `"michael"`, `"alba"`. Defaults to
   * {@link ASSEMBLYAI_TTS_DEFAULT_VOICE}. Each voice speaks one language:
   * English voices include `alba`, `anna`, `azelma`, `bill_boerst`,
   * `caro_davy`, `charles`, `cosette`, `eponine`, `eve`, `fantine`, `george`,
   * `jane`, `javert`, `jean`, `marius`, `mary`, `michael`, `paul`,
   * `peter_yearsley`, `stuart_bell`, `vera`; non-English are `estelle` (fr),
   * `giovanni` (it), `juergen` (de), `lola` (es), `rafael` (pt).
   */
  voice?: string;
  /**
   * Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
   * `"it"`, `"pt"`). Omitted by default so the server infers it from the
   * voice — set it only alongside a voice that speaks it.
   */
  language?: string;
}

export type AssemblyAITtsProvider = TtsProvider & {
  readonly kind: typeof ASSEMBLYAI_TTS_KIND;
  readonly options: AssemblyAITtsOptions & { voice: string };
};

export function assemblyAI(opts: AssemblyAITtsOptions = {}): AssemblyAITtsProvider {
  return {
    kind: ASSEMBLYAI_TTS_KIND,
    options: { ...opts, voice: opts.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE },
  };
}
