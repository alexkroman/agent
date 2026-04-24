// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/tts` subpath barrel.
 *
 * Re-exports the descriptor factory (`cartesia`) and the shared TTS
 * contract types. Does not pull in `@cartesia/cartesia-js` — the host
 * resolver handles that at session start.
 */

export type { TtsError, TtsEvents, TtsOpenOptions, TtsProvider, TtsSession } from "../providers.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./tts/cartesia.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./tts/rime.ts";
