// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/stt` subpath barrel.
 *
 * Re-exports the descriptor factories (`assemblyAIStt`, `deepgram`,
 * `elevenlabs`, `soniox`) and the shared STT contract types. Importing this
 * barrel does not pull in the `assemblyai` SDK — that happens only when the
 * host resolver is invoked.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression per line, and the escape-hatch ratchet only
 * moves down. Listing them also makes the public surface of this subpath
 * readable in one place — add new symbols here when a provider gains one.
 *
 * @module stt
 */

export type {
  SttError,
  SttEvents,
  SttOpenOptions,
  SttProvider,
  SttSession,
  // Exported because `SttEvents.partial`/`final` name it in their signatures.
  // TypeDoc runs with `treatWarningsAsErrors`, so a type reachable from a
  // documented signature but absent from an entry point FAILS the docs build.
  SttTurnMeta,
  Unsubscribe,
} from "../providers.ts";
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
