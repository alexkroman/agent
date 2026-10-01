// Copyright 2026 the AAI authors. MIT license.
/**
 * MCP clients: connecting to configured servers (`connect.ts`), resolving their
 * config, adapting their tool schemas, the drift/trust record, and the `"mcp"`
 * toolset `withMcpTools` attaches after the agent's own (`tools.ts`). Outside
 * this directory, import from here; a name not re-exported here is private to
 * it (guard-invariants rule 37).
 */

export type {
  McpCallResult,
  McpConnectOptions,
  McpSession,
  McpSessionOpener,
  ResolvedMcpServer,
} from "./connect.ts";
export { MCP_CONNECT_TIMEOUT_MS } from "./connect.ts";
export type { McpDrift, McpTrust } from "./drift.ts";
export type { McpInputSchema } from "./schema.ts";
export type { McpServerStatus, McpToolSurface, McpToolsOptions } from "./tools.ts";
export { connectMcpServers, withMcpTools } from "./tools.ts";
