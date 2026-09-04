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
 * import { openAIS2s } from "@alexkroman1/aai/s2s";
 *
 * export default agent({
 *   name: "Concierge",
 *   systemPrompt: "You are a hotel concierge. Be brief.",
 *   s2s: openAIS2s({ model: "gpt-realtime", voice: "marin" }),
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
 * beside `agent()` where an author meets it. `openAIS2s` is on this
 * subpath alone, like every other vendor.
 *
 * **Credentials are never passed here.** Each factory's vendor names the env
 * var its key is read from — `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY` — and the
 * host reads it out of the agent's own environment when the session starts.
 * That is what keeps a descriptor safe to serialize across the CLI → server →
 * guest boundary. The variable NAMES are not published: an author never types
 * one, and the one case for repointing a stage is `apiKeyEnv` on the
 * AssemblyAI descriptor, which this stage carries too.
 *
 * ## The descriptor type is on the ROOT barrel TOO
 *
 * `S2sProvider` — what a factory here returns — is also exported from
 * `@alexkroman1/aai`, beside the other three stage types, so an agent
 * annotating two stages writes one import rather than two. It stays here as
 * well: this is where the factory that produces one lives.
 * `ProviderDescriptor`, the base all four narrow, is on the root ALONE now —
 * one interface with four reference pages was three too many.
 *
 * @module s2s
 */

// Named re-exports rather than `export *`: the wildcard form needs a
// `noReExportAll` suppression per line, and the escape-hatch ratchet only moves
// down. Listing them also makes the public surface of this subpath readable in
// one place — add new symbols here when a provider gains one.
export type { ProviderCredentialOptions, S2sProvider } from "../providers.ts";
export { type AssemblyAIS2sOptions, assemblyAIS2s } from "./s2s/assemblyai.ts";
export {
  type OpenAIS2sOptions,
  type OpenAIS2sVoice,
  openAIS2s,
} from "./s2s/openai.ts";
