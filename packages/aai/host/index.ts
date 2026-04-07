// Copyright 2025 the AAI authors. MIT license.
/**
 * Host barrel — re-exports all SDK internals for use by the platform
 * server (`aai-server`) and CLI. **Not a public API.**
 *
 * Includes the full isolate-safe kernel plus host-only modules that
 * depend on Node.js APIs (server, executor, S2S, etc.).
 *
 * Consumer packages should import from the top-level `@alexkroman1/aai`
 * entry, `./server`, `./types`, `./kv`, `./protocol`, or `./testing`.
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

// Isolate-safe kernel
export * from "../isolate/index.ts";

// Host-only modules
export * from "./_runtime-conformance.ts";
export * from "./builtin-tools.ts";
export * from "./direct-executor.ts";
export * from "./runtime-config.ts";
export * from "./s2s.ts";
export * from "./session.ts";
export * from "./unstorage-kv.ts";
export * from "./ws-handler.ts";
