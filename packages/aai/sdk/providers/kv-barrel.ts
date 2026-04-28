// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/kv` subpath barrel.
 *
 * Re-exports KV descriptor factories. Importing this barrel does
 * not pull in any unstorage driver — the host resolver handles that
 * at session start.
 */

export type { Kv } from "../kv.ts";
export type { KvProvider } from "../providers.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/fs.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/memory.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/redis.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./kv/s3.ts";
