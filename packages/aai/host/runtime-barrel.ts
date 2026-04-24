// Copyright 2025 the AAI authors. MIT license.
/**
 * Runtime barrel — the full Node.js runtime engine for running agents.
 *
 * Used by aai-server (sandbox) and aai-cli (dev server).
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

// Note: ./_runtime-conformance.ts is intentionally NOT re-exported here.
// It imports `vitest`, which is a devDependency. Re-exporting it would pull
// `vitest` into the production bundle of this barrel and break runtime
// imports in environments without dev deps installed (e.g. the deployed
// platform server). It is consumed directly by sibling test files.

export * from "./builtin-tools.ts";
export * from "./runtime.ts";
export * from "./runtime-config.ts";
export * from "./server.ts";
export * from "./session-core.ts";
export * from "./tool-executor.ts";
export * from "./transports/pipeline-transport.ts";
export * from "./transports/s2s-transport.ts";
export * from "./transports/types.ts";
export * from "./unstorage-kv.ts";
export * from "./ws-handler.ts";
