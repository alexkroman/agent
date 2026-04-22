// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/tts` subpath barrel. Re-exports the TTS provider
 * contract types (via `tts.ts` → `sdk/providers.ts`) alongside the
 * concrete Cartesia adapter factory. Task 9 owns wiring this file
 * into `package.json` exports.
 */

// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./tts/cartesia.ts";
// Type-only re-export — no biome suppression needed; `export type *` is
// excluded from the `noReExportAll` rule.
export type * from "./tts.ts";
