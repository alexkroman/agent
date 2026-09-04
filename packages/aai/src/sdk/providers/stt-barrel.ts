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
 * import { deepgramStt } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   // `llm` and `tts` keep their AssemblyAI defaults.
 *   stt: deepgramStt({ model: "nova-3", language: "en" }),
 * });
 * ```
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`,
 * `ELEVENLABS_API_KEY`, `SONIOX_API_KEY` — and the host reads it out of the
 * agent's own environment when the session starts. That is what keeps a
 * descriptor safe to serialize across the CLI → server → guest boundary. The
 * variable NAMES are not published: an author never types one, and the one
 * case for repointing a stage is `apiKeyEnv` on the AssemblyAI descriptor.
 *
 * ## What an unset language means, per vendor
 *
 * The field is spelled `language` for a single code and `languages` for a
 * list, which is the only difference between the four — but their DEFAULTS do
 * not line up, and that is the one cross-provider fact you cannot assemble
 * from the per-symbol docs. The row that surprises people is Deepgram's:
 *
 * | factory | field | unset means |
 * | --- | --- | --- |
 * | {@link assemblyAIStt} | `languages` | detect per turn (code-switches across 18) |
 * | {@link deepgramStt} | `language` | **English** — `"en"` is sent for you |
 * | {@link elevenLabsStt} | `language` | auto-detect (the field is omitted) |
 * | {@link sonioxStt} | `languages` | auto-detect (the field is omitted) |
 *
 * So moving an agent from {@link assemblyAIStt} to {@link deepgramStt} silently
 * drops multilingual transcription, and moving the other way silently gains
 * code-switching — read {@link AssemblyAISttOptions.languages} before you do,
 * because that default has a measured failure mode with no obvious symptom.
 *
 * Each vendor's own wire spelling (`language_codes`, `languageCode`,
 * `language_hints`) is applied by the host opener, not written here.
 *
 * ## The descriptor type is on the ROOT barrel TOO
 *
 * `SttProvider` — what a factory here returns — is also exported from
 * `@alexkroman1/aai`, beside the other three stage types, so an agent
 * annotating two stages writes one import rather than two. It stays here as
 * well: this is where the factory that produces one lives.
 * `ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
 * one interface with four reference pages was three too many.
 *
 * ## The host-side opener contract is on `/runtime`
 *
 * Implementing an STT vendor of your own — `SttOpenOptions`, `SttSession`,
 * `SttEvents`, `SttError`, `SttTurnMeta`, `Unsubscribe` — is a HOST job, and
 * those types live on `@alexkroman1/aai-runtime` beside `registerSttKind`,
 * which is what you hand the opener to.
 *
 * @module stt
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
export type { ProviderCredentialOptions, SttProvider } from "../providers.ts";
export {
  ASSEMBLYAI_STT_EU_URL,
  type AssemblyAISttOptions,
  assemblyAIStt,
} from "./stt/assemblyai.ts";
export {
  DEEPGRAM_DEFAULT_ENDPOINTING_MS,
  type DeepgramSttOptions,
  deepgramStt,
} from "./stt/deepgram.ts";
export { type ElevenLabsSttOptions, elevenLabsStt } from "./stt/elevenlabs.ts";
export { type SonioxSttOptions, sonioxStt } from "./stt/soniox.ts";
