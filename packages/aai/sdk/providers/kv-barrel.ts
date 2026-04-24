// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/kv` subpath barrel.
 *
 * Re-exports the KV descriptor factories and shared types. Importing this
 * barrel does not pull in `unstorage` or any driver SDK — the host resolver
 * handles that when the descriptor is opened.
 */

export type { Kv } from "../kv.ts";
export type { KvProvider } from "../providers.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/cloudflare-kv.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/memory.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/unstorage.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/upstash.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/vercel-kv.ts";
