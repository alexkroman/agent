// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `agent-mcp`.
 *
 * The `agent({ mcpServers })` field: a server's declaration
 * (`McpServerConfig`, with its resolvers and their `McpResolveContext`), the
 * grammar of a server key (`MCP_SERVER_KEY_RE`) and the rule turning a server's
 * tool name into the one the model calls (`MCP_TOOL_PREFIX`, `mcpToolName`).
 *
 * Split off `agent` when it reached 77 names: the MCP vocabulary moves with
 * the protocol, not with what declaring an agent looks like. The CLIENT that
 * reads these is `withMcpTools` on `@alexkroman1/aai-runtime` — this SDK opens
 * no sockets. `AgentDeclaration.mcpServers` still names `McpServers`, so adding
 * or dropping the field is visible on `agent`.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  MCP_SERVER_KEY_RE,
  MCP_TOOL_PREFIX,
  type McpResolvable,
  type McpResolveContext,
  type McpServerConfig,
  type McpServers,
  mcpToolName,
} from "../../index.ts";
