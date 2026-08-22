// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/stt` subpath barrel — the speech-to-text stage of a
 * pipeline agent.
 *
 * Four vendors, one shape: each factory returns a serializable DESCRIPTOR
 * (`{ kind, options }`), and you hand it to `agent({ stt })`. Nothing here
 * opens a socket or reads a credential — the host resolves the descriptor at
 * session start, so importing this barrel pulls in no vendor SDK.
 *
 * @example Swap the STT stage of an otherwise default agent
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { deepgram } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   // `llm` and `tts` keep their AssemblyAI defaults.
 *   stt: deepgram({ model: "nova-3", language: "en" }),
 * });
 * ```
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`,
 * `ELEVENLABS_API_KEY`, `SONIOX_API_KEY`, each also exported as a
 * `*_API_KEY_ENV` constant — and the host reads it out of the agent's own
 * environment when the session starts. That is what keeps a descriptor safe to
 * serialize across the CLI → server → guest boundary.
 *
 * ## What an unset language means, per vendor
 *
 * The field is spelled the way each vendor spells it on the wire, so the four
 * do not line up — and neither do their defaults. This is the one
 * cross-provider fact you cannot assemble from the per-symbol docs, and the
 * row that surprises people is Deepgram's:
 *
 * | factory | field | unset means |
 * | --- | --- | --- |
 * | {@link assemblyAIStt} | `languages` | detect per turn (code-switches across 18) |
 * | {@link deepgram} | `language` | **English** — `"en"` is sent for you |
 * | {@link elevenlabs} | `languageCode` | auto-detect (the field is omitted) |
 * | {@link soniox} | `languageHints` | auto-detect (the field is omitted) |
 *
 * So moving an agent from {@link assemblyAIStt} to {@link deepgram} silently
 * drops multilingual transcription, and moving the other way silently gains
 * code-switching — read {@link AssemblyAIOptions.languages} before you do,
 * because that default has a measured failure mode with no obvious symptom.
 *
 * ## The host-side opener contract is on `/runtime`
 *
 * Implementing an STT vendor of your own — `SttOpenOptions`, `SttSession`,
 * `SttEvents`, `SttError`, `SttTurnMeta`, `Unsubscribe` — is a HOST job, and
 * those types live on `@alexkroman1/aai/runtime` beside `registerSttKind`,
 * which is what you hand the opener to. Only {@link SttProvider}, the
 * descriptor a factory here returns, stays on this page.
 *
 * @module stt
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
export type { ProviderDescriptor, SttProvider } from "../providers.ts";
export {
  ASSEMBLYAI_API_KEY_ENV,
  ASSEMBLYAI_KIND,
  ASSEMBLYAI_STREAMING_EU_URL,
  type AssemblyAIOptions,
  type AssemblyAIProvider,
  assemblyAIStt,
} from "./stt/assemblyai.ts";
export {
  DEEPGRAM_API_KEY_ENV,
  DEEPGRAM_KIND,
  DEFAULT_DEEPGRAM_ENDPOINTING_MS,
  type DeepgramOptions,
  type DeepgramProvider,
  deepgram,
} from "./stt/deepgram.ts";
export {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_KIND,
  type ElevenLabsOptions,
  type ElevenLabsProvider,
  elevenlabs,
} from "./stt/elevenlabs.ts";
export {
  SONIOX_API_KEY_ENV,
  SONIOX_KIND,
  type SonioxOptions,
  type SonioxProvider,
  soniox,
} from "./stt/soniox.ts";
