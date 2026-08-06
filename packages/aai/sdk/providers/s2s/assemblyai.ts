// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI speech-to-speech (Voice Agent API) descriptor — host transport
 * resolves at session start.
 *
 * S2S used to be the implicit default: an `agent()` with no provider fields
 * ran on the AssemblyAI speech-to-speech service. That default now belongs to
 * the cascaded pipeline (see `assemblyAIPipeline` and the internal
 * `defaultProviders` rule), so S2S is opt-in — this descriptor is the opt-in:
 *
 * ```ts
 * import { agent, assemblyAIS2s } from "@alexkroman1/aai";
 * export default agent({ name: "Ivy", s2s: assemblyAIS2s() });
 * ```
 *
 * Bills to `ASSEMBLYAI_API_KEY`, same as the pipeline preset.
 */

import type { S2sProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_S2S_KIND = "assemblyai" as const;

/**
 * Env var holding this stage's credential.
 *
 * The same string as the STT/TTS/LLM AssemblyAI constants by design — a
 * distinct NAME per stage is what lets `apiKeyEnv` point one stage at another
 * account without moving the others (see `descriptorEnvVar` in
 * `host/providers/resolve.ts`).
 */
export const ASSEMBLYAI_S2S_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** Descriptor returned by {@link assemblyAIS2s}. */
export type AssemblyAIS2sProvider = S2sProvider & {
  readonly kind: typeof ASSEMBLYAI_S2S_KIND;
  readonly options: Record<string, unknown>;
};

/**
 * Select AssemblyAI's speech-to-speech (Voice Agent API) session mode.
 * STT, the LLM loop, and TTS all run service-side over one socket.
 *
 * @public
 */
export function assemblyAIS2s(): AssemblyAIS2sProvider {
  return { kind: ASSEMBLYAI_S2S_KIND, options: {} };
}
