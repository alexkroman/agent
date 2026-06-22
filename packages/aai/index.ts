// Copyright 2025 the AAI authors. MIT license.
/**
 * aai — shared fundamentals with no Node.js dependencies.
 *
 * Exports: `agent()` / `tool()` authoring helpers, types, KV interface,
 * allowed-host validation, WebSocket upgrade parsing, utils, and constants.
 * Consumed by aai-cli, aai-server, and aai-ui.
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

export * from "./sdk/allowed-hosts.ts";
export * from "./sdk/constants.ts";
export * from "./sdk/define.ts";
export * from "./sdk/kv.ts";
export * from "./sdk/types.ts";
export * from "./sdk/utils.ts";
export * from "./sdk/ws-upgrade.ts";
