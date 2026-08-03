// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/s2s` subpath barrel.
 *
 * Re-exports S2S descriptor factories. Importing this barrel does not
 * pull in any provider SDK — the host resolver handles that at session
 * start.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression per line, and the escape-hatch ratchet only
 * moves down. Listing them also makes the public surface of this subpath
 * readable in one place — add new symbols here when a provider gains one.
 */

export type { S2sProvider } from "../providers.ts";
export {
  ASSEMBLYAI_S2S_KIND,
  type AssemblyAIS2sProvider,
  assemblyAIS2s,
} from "./s2s/assemblyai.ts";
export {
  OPENAI_REALTIME_KIND,
  type OpenaiRealtimeOptions,
  type OpenaiRealtimeProvider,
  type OpenaiRealtimeVoice,
  openaiRealtime,
} from "./s2s/openai-realtime.ts";
