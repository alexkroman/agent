// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/stt` subpath barrel.
 *
 * Re-exports the descriptor factory (`assemblyAI`) and the shared STT
 * contract types. Importing this barrel does not pull in the `assemblyai`
 * SDK — that happens only when the host resolver is invoked.
 */

export type { SttError, SttEvents, SttOpenOptions, SttProvider, SttSession } from "../providers.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./stt/assemblyai.ts";
