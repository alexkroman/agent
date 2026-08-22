// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/s2s` subpath barrel — speech-to-speech, where the whole
 * turn runs service-side.
 *
 * S2S is the OTHER session mode, and it is opt-in: setting `s2s` replaces the
 * `stt`/`llm`/`tts` pipeline entirely, so transcription, the model loop and
 * synthesis all happen inside one vendor socket. Two vendors, one shape — each
 * factory returns a serializable DESCRIPTOR (`{ kind, options }`), and nothing
 * here opens a socket or reads a credential.
 *
 * @example An OpenAI Realtime agent
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { openaiRealtime } from "@alexkroman1/aai/s2s";
 *
 * export default agent({
 *   name: "Concierge",
 *   systemPrompt: "You are a hotel concierge. Be brief.",
 *   s2s: openaiRealtime({ model: "gpt-realtime", voice: "marin" }),
 * });
 * ```
 *
 * `s2s` and the pipeline fields refuse each other at COMPILE time, and so does
 * the top-level `voice` convenience — an S2S voice rides on the descriptor,
 * because it is the service that synthesizes.
 *
 * **{@link assemblyAIS2s} is also on the root barrel**, which is the one
 * exception to "provider factories live on subpaths". S2S became opt-in when
 * the pipeline became the default mode, so the descriptor that opts in sits
 * beside `agent()` where an author meets it; the two `*_KIND`/`*_API_KEY_ENV`
 * constants an author never writes stay here only. `openaiRealtime` is on this
 * subpath alone, like every other vendor.
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, each also
 * exported as a `*_API_KEY_ENV` constant — and the host reads it out of the
 * agent's own environment when the session starts. That is what keeps a
 * descriptor safe to serialize across the CLI → server → guest boundary.
 *
 * @module s2s
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
export type { ProviderDescriptor, S2sProvider } from "../providers.ts";
export {
  ASSEMBLYAI_S2S_API_KEY_ENV,
  ASSEMBLYAI_S2S_KIND,
  type AssemblyAIS2sOptions,
  type AssemblyAIS2sProvider,
  assemblyAIS2s,
} from "./s2s/assemblyai.ts";
export {
  OPENAI_REALTIME_API_KEY_ENV,
  OPENAI_REALTIME_KIND,
  type OpenaiRealtimeOptions,
  type OpenaiRealtimeProvider,
  type OpenaiRealtimeVoice,
  openaiRealtime,
} from "./s2s/openai-realtime.ts";
