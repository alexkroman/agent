// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/stt` subpath barrel. Re-exports the STT provider
 * contract types (via `stt.ts` → `sdk/providers.ts`) alongside the
 * concrete AssemblyAI adapter factory. Task 9 owns wiring this file
 * into `package.json` exports.
 */

// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./stt/assemblyai.ts";
// Type-only re-export — no biome suppression needed; `export type *` is
// excluded from the `noReExportAll` rule.
export type * from "./stt.ts";
