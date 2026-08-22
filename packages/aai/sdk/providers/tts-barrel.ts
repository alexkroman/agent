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
 * import { CARTESIA_DEFAULT_VOICE, cartesia } from "@alexkroman1/aai/tts";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   // `stt` and `llm` keep their AssemblyAI defaults.
 *   tts: cartesia({ voice: CARTESIA_DEFAULT_VOICE, model: "sonic-3" }),
 * });
 * ```
 *
 * **Picking a voice is the one setting a TTS stage cannot infer**, and an
 * unrecognised id has no authoring-time symptom: the agent connects, reports
 * ready and is permanently silent. For AssemblyAI the ids are enumerated in
 * {@link ASSEMBLYAI_TTS_VOICES} (with each accent alongside) and the retired
 * ones in {@link ASSEMBLYAI_TTS_DEPRECATED_VOICES} — read them there rather
 * than trusting a name from anywhere else. On the default pipeline you do not
 * need this barrel at all: `agent({ voice: "michael" })` desugars to
 * {@link assemblyAITts}.
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY`,
 * `RIME_API_KEY`, each also exported as a `*_API_KEY_ENV` constant — and the
 * host reads it out of the agent's own environment when the session starts.
 * That is what keeps a descriptor safe to serialize across the CLI → server →
 * guest boundary.
 *
 * ## The host-side opener contract is on `/runtime`
 *
 * Implementing a TTS vendor of your own — `TtsOpenOptions`, `TtsSession`,
 * `TtsEvents`, `TtsError`, `TtsWordTiming`, `Unsubscribe` — is a HOST job, and
 * those types live on `@alexkroman1/aai/runtime` beside `registerTtsKind`,
 * which is what you hand the opener to. Only {@link TtsProvider}, the
 * descriptor a factory here returns, stays on this page.
 *
 * @module tts
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
export type { ProviderDescriptor, TtsProvider } from "../providers.ts";
export {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_DEPRECATED_VOICES,
  ASSEMBLYAI_TTS_KIND,
  ASSEMBLYAI_TTS_LANGUAGES,
  ASSEMBLYAI_TTS_VOICES,
  type AssemblyAITtsLanguage,
  type AssemblyAITtsOptions,
  type AssemblyAITtsProvider,
  type AssemblyAITtsVoice,
  assemblyAITts,
} from "./tts/assemblyai.ts";
export {
  CARTESIA_API_KEY_ENV,
  CARTESIA_DEFAULT_VOICE,
  CARTESIA_KIND,
  type CartesiaOptions,
  type CartesiaProvider,
  cartesia,
} from "./tts/cartesia.ts";
export {
  RIME_API_KEY_ENV,
  RIME_DEFAULT_VOICE,
  RIME_KIND,
  type RimeOptions,
  type RimeProvider,
  rime,
} from "./tts/rime.ts";
