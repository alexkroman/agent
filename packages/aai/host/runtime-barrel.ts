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
export * from "./generate.ts";
export * from "./host-mode.ts";
export * from "./postgres-db.ts";
export * from "./providers/host-env.ts";
// Narrow named exports rather than `export *`: the rest of resolve.ts is
// internal descriptor plumbing. `requiredProviderEnvVars` is used by the CLI
// dev server to check credentials before starting; `resolveLlm` lets host
// applications (e.g. the platform server's browser studio) turn an LLM
// descriptor into a Vercel AI SDK model without duplicating provider wiring.
export { requiredProviderEnvVars, resolveLlm } from "./providers/resolve.ts";
export * from "./runtime.ts";
export * from "./runtime-config.ts";
export * from "./server.ts";
export * from "./session-core.ts";
export * from "./ssrf.ts";
export * from "./tool-executor.ts";
export * from "./transports/pipeline-transport.ts";
export * from "./transports/s2s-transport.ts";
export * from "./transports/types.ts";
export * from "./ws-handler.ts";
