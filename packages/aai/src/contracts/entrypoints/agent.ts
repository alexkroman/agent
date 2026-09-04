// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `agent`.
 *
 * Declaring an agent: the `agent()` and `workflowApp()` helpers, the parameter
 * unions that make a mode mistake a compile error, and the shape a declaration
 * resolves to.
 *
 * The `events` handler types are here for the same reason `AgentDef` is: they are
 * the SHAPE of an `agent({ events })` declaration, so a change to them is a change
 * to what declaring an agent looks like. `SessionEvent` itself is still not — it
 * is the wire union, contracted nowhere here because `/protocol` is a
 * non-authoring subpath — but `SessionEventType`, its KEY SET, is, and that is a
 * deliberate narrowing of the same rule. `agent({ events: { "tool.called": … } })`
 * is authoring code and the string literal IS the API, so with only the handler
 * types contracted this capability covered the brackets and not the keys:
 * `SessionEvent` is an opaque `z.infer` alias in the rollup, so removing an event
 * name left the hash byte-identical and shipped as a `patch` that broke a build.
 * Contracting the union of names makes that a classification instead.
 *
 * `ProviderCredentialOptions` is here for the same reason as
 * `ProviderDescriptor`: every provider options interface on all four stages
 * extends it, so no one stage owns it and the root is the narrowest place it
 * fits. It is what lets a descriptor repoint its own credential — the field the
 * host has always read off ANY descriptor generically, and which until now only
 * the four AssemblyAI options types could spell.
 *
 * `ProviderDescriptor` is here because it is the only one of the five
 * descriptor types with no stage of its own: `AgentDef` names all four stages,
 * and the base they narrow used to be re-exported from every stage subpath —
 * one interface with four reference pages, a name four capabilities each
 * half-owned. The four stage types themselves stay with their stages, which
 * publish the factories that produce them.
 *
 * The six `Mcp*` names are here for the same reason `AgentDef` is: `mcpServers`
 * is a field of an agent declaration, so its shape, the grammar of a server
 * key, and the rule turning a server's tool name into the one the model calls
 * are all part of what declaring an agent looks like. The CLIENT that reads
 * them is `withMcpTools` on `@alexkroman1/aai-runtime` and belongs to that
 * package's own `tools` capability — this SDK opens no sockets.
 *
 * `workflowApp()` belongs here rather than in `workflow`: it declares an AGENT
 * (returning `AgentDef`, like `agent()`), and what it selects is a front door.
 * The `workflow` capability is the runs themselves — `workflow()`, and what a
 * caller of `ctx.workflows` reads.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AgentDef,
  type AgentParams,
  type AssemblyAIPipelineOptions,
  agent,
  assemblyAIPipeline,
  type BuiltinTool,
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  type McpServerConfig,
  type McpServers,
  mcpToolName,
  type PipelineAgentParams,
  type PipelineVoiceTuning,
  type ProviderCredentialOptions,
  type ProviderDescriptor,
  type S2sAgentParams,
  type SessionEventContext,
  type SessionEventHandler,
  type SessionEventHandlers,
  type SessionEventType,
  type SharedAgentParams,
  type StaticAgentParams,
  type TextAgentParams,
  type ToolChoice,
  workflowApp,
} from "../../index.ts";
