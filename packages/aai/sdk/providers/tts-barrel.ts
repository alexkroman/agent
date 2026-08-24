// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/tts` subpath barrel — the text-to-speech stage of a
 * pipeline agent.
 *
 * Three vendors, one shape: each factory returns a serializable DESCRIPTOR
 * (`{ kind, options }`), and you hand it to `agent({ tts })`. Nothing here
 * opens a socket or reads a credential — the host resolves the descriptor at
 * session start, so importing this barrel pulls in no vendor SDK.
 *
 * @example Swap the TTS stage of an otherwise default agent
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { CARTESIA_DEFAULT_VOICE, cartesiaTts } from "@alexkroman1/aai/tts";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   // `stt` and `llm` keep their AssemblyAI defaults.
 *   tts: cartesiaTts({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3" }),
 * });
 * ```
 *
 * **Picking a voice is the one setting a TTS stage cannot infer**, and an
 * unrecognised id has no authoring-time symptom: the agent connects, reports
 * ready and is permanently silent. For AssemblyAI the ids are enumerated in
 * {@link ASSEMBLYAI_TTS_VOICES}, with each accent alongside — read them there
 * rather than trusting a name from anywhere else, and note the TYPE cannot
 * enforce it ({@link AssemblyAITtsVoice} says why). On the default pipeline
 * you do not need this barrel at all: `agent({ voice: "michael" })` desugars
 * to {@link assemblyAITts}.
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY`,
 * `RIME_API_KEY` — and the host reads it out of the agent's own environment
 * when the session starts. That is what keeps a descriptor safe to serialize
 * across the CLI → server → guest boundary. The variable NAMES are not
 * published: an author never types one, and the one case for repointing a
 * stage is `apiKeyEnv` on the AssemblyAI descriptor.
 *
 * ## The descriptor type is on the ROOT barrel TOO
 *
 * `TtsProvider` — what a factory here returns — is also exported from
 * `@alexkroman1/aai`, beside the other three stage types, so an agent
 * annotating two stages writes one import rather than two. It stays here as
 * well: this is where the factory that produces one lives.
 * `ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
 * one interface with four reference pages was three too many.
 *
 * ## The host-side opener contract is on `/runtime`
 *
 * Implementing a TTS vendor of your own — `TtsOpenOptions`, `TtsSession`,
 * `TtsEvents`, `TtsError`, `TtsWordTiming`, `Unsubscribe` — is a HOST job, and
 * those types live on `@alexkroman1/aai-runtime` beside `registerTtsKind`,
 * which is what you hand the opener to.
 *
 * @module tts
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
export type { ProviderCredentialOptions, TtsProvider } from "../providers.ts";
export {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsOptions,
  type AssemblyAITtsVoice,
  type AssemblyAITtsVoiceId,
  type AssemblyAITtsVoiceInfo,
  assemblyAITts,
} from "./tts/assemblyai.ts";
export { CARTESIA_DEFAULT_VOICE, type CartesiaTtsOptions, cartesiaTts } from "./tts/cartesia.ts";
export { RIME_DEFAULT_VOICE, type RimeTtsOptions, rimeTts } from "./tts/rime.ts";
