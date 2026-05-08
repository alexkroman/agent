// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/s2s` subpath barrel.
 *
 * Re-exports S2S descriptor factories. Importing this barrel does not
 * pull in any provider SDK — the host resolver handles that at session
 * start.
 */

export type { S2sProvider } from "../providers.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./s2s/openai-realtime.ts";
