// Copyright 2025 the AAI authors. MIT license.
/**
 * Runtime barrel — the full Node.js runtime engine for running agents.
 *
 * Used by aai-server (sandbox) and aai-cli (dev server).
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate: a new symbol in one of these modules does not ship as public
 * API until it is added here. The user-facing core is `createRuntime` and its
 * option/handle types plus a handful of helpers (`safeFetch`,
 * `withHostCredentialFallback`, `createPostgresDb`, `requiredProviderEnvVars`,
 * `resolveLlm`, `resolveAllBuiltins`); most of the rest is platform plumbing
 * kept importable for aai-server/aai-cli and tagged `@internal` at its
 * declaration site.
 *
 * @module runtime
 */

// Note: ./_runtime-conformance.ts is intentionally NOT re-exported here.
// It imports `vitest`, which is a devDependency. Re-exporting it would pull
// `vitest` into the production bundle of this barrel and break runtime
// imports in environments without dev deps installed (e.g. the deployed
// platform server). It is consumed directly by sibling test files.

export type { AgentEnv, HostCredentialEnv, ProviderEnv } from "../sdk/env-types.ts";
export {
  type AgentServerOptions,
  createAgentServer,
} from "./agent-server.ts";
export type { RunCodeExecutor } from "./builtin-run-code.ts";
export {
  type BuiltinToolOptions,
  type ResolvedBuiltins,
  resolveAllBuiltins,
  resolveBuiltin,
  SANDBOX_ONLY_BUILTINS,
  type ToolDefRecord,
} from "./builtin-tools.ts";
export {
  type CreateGenerateFnOptions,
  createGenerateFn,
  type HostGenerateFn,
} from "./generate.ts";
export {
  buildHostAgent,
  isHostAllowed,
  type StartHostSessionOptions,
  startHostSession,
} from "./host-mode.ts";
export {
  createRelayExecuteTool,
  type RelayExecuteTool,
  type RelayToolResult,
} from "./host-relay.ts";
export {
  createHostServer,
  type HostServerOptions,
  type HostSessionDefaults,
} from "./host-server.ts";
export {
  type CloseableDb,
  type CreatePostgresDbOptions,
  createPostgresDb,
  type ReservedDb,
} from "./postgres-db.ts";
export { PROVIDER_CREDENTIAL_ENVS, withHostCredentialFallback } from "./providers/host-env.ts";
// Narrow named exports rather than the whole module: the rest of resolve.ts is
// internal descriptor plumbing. `requiredProviderEnvVars` is used by the CLI
// dev server to check credentials before starting; `resolveLlm` lets host
// applications (e.g. the platform server's browser studio) turn an LLM
// descriptor into a Vercel AI SDK model without duplicating provider wiring.
export { requiredProviderEnvVars, resolveLlm } from "./providers/resolve.ts";
export {
  type AgentRuntime,
  createRuntime,
  type Runtime,
  type RuntimeOptions,
  type SessionStartOptions,
} from "./runtime.ts";
export {
  consoleLogger,
  createConsoleLogger,
  DEFAULT_S2S_CONFIG,
  debugLoggingEnabled,
  isDebugEnv,
  type LogContext,
  type LogFn,
  type Logger,
  type LogLevel,
  type S2SConfig,
} from "./runtime-config.ts";
export {
  type AgentServer,
  createServer,
  DEFAULT_LISTEN_HOST,
  decliningRuntime,
  type PassthroughServerOptions,
  type ServerOptions,
  type SessionRuntime,
} from "./server.ts";
// The static-asset half of `createServer`, split out at the file-length cap.
// `isPathInside` stays exported because the SSRF-adjacent containment rule it
// encodes is worth one definition, not one per caller.
export { isPathInside, serveStatic } from "./server-static.ts";
export { createSessionCore, type SessionCore, type SessionCoreOptions } from "./session-core.ts";
export {
  builtinFetch,
  CONTAINED_ENV,
  isPrivateIp,
  pinnedFetch,
  resolveAndAssertPublic,
  safeFetch,
  ssrfSafeFetch,
} from "./ssrf.ts";
export {
  CARRIER_CODECS,
  type CarrierCodec,
  type CarrierInbound,
  type CarrierName,
  carrierByName,
  telnyxCodec,
  twilioCodec,
} from "./telephony/carriers.ts";
export { TELEPHONY_SAMPLE_RATE } from "./telephony/mulaw.ts";
export {
  createTelephonyBridge,
  type TelephonyBridgeOptions,
} from "./telephony/telephony-bridge.ts";
export {
  CARRIER_PARAM,
  startTelephonySession,
  TELEPHONY_PATH,
} from "./telephony/telephony-server.ts";
// The TEXT session mode — an agent definition driven over a message list.
// Public: it is how a text-based agent is run, the counterpart of
// `createRuntime` for the other two modes.
export {
  createTextAgent,
  type TextAgent,
  type TextAgentOptions,
  type TextTurnOptions,
  type TextTurnResult,
} from "./text-agent.ts";
// The repair both `streamText` loops share. Exported for a caller assembling
// its own request against the same model (and because `salvageJson` is the
// half that costs no tokens).
export { createToolCallRepair, salvageJson } from "./tool-call-repair.ts";
export { type ExecuteTool, type ExecuteToolOptions, executeToolCall } from "./tool-executor.ts";
export {
  createPipelineTransport,
  type PipelineTransportOptions,
} from "./transports/pipeline-transport.ts";
// `_internals` (the connectS2s spy seam) is deliberately NOT re-exported: it
// is a mutable object a test patches, and publishing it put a process-wide
// behaviour switch on the `@alexkroman1/aai/runtime` surface. Tests inside
// this package import it from the module directly.
export { createS2sTransport, type S2sTransportOptions } from "./transports/s2s-transport.ts";
export type {
  Transport,
  TransportCallbacks,
  TransportSessionConfig,
} from "./transports/types.ts";
// The workflow HTTP API. `createServer` mounts it itself, so nothing outside
// this package has to wire a route — what is exported is the token's env var
// (the guest's deploy path reads it to decide whether a deployed app's API is
// closed) and the prefix, so the platform's proxy and this server cannot name
// different paths.
export {
  createWorkflowApi,
  MAX_WORKFLOW_INPUT_BYTES,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
  type WorkflowApiEngine,
  type WorkflowApiOptions,
} from "./workflow-api.ts";
// The durable-workflow host side. `createWorkflowClient` is what becomes
// `ctx.workflows`; `wdkAdapter` is the Workflow DevKit binding, separate so the
// client can be specified without a world. The key
// store's two factories ride along because the guest picks between them —
// Postgres on the platform, memory under `aai dev`.
export {
  createWorkflowClient,
  resolveKeyStore,
  type WdkAdapter,
  type WdkRunRecord,
  type WorkflowClientOptions,
} from "./workflow-client.ts";
export {
  createMemoryKeyStore,
  createPostgresKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
  type WorkflowKeyStore,
} from "./workflow-keys.ts";
// Serving workflows, and choosing the world they live in. Shared rather than
// guest-only because `aai dev` needs the identical wiring — and the CLI may not
// import the guest (the dependency edge runs aai-guest -> aai-cli, never back).
export {
  createWorkflowSurface,
  handleWorkflowRequest,
  WORKFLOW_FLOW_PATH,
  WORKFLOW_STEP_PATH,
  WORKFLOW_WEBHOOK_PREFIX,
  type WorkflowSurface,
} from "./workflow-serve.ts";
// The wake hint. Exported for BOTH ends: the guest builds the publisher, and
// the platform's wake sweep reads the table this names (see workflow-wake-hint.ts
// — one spelling, so a rename cannot be two edits that disagree).
export {
  createWakeHintPublisher,
  GRAPHILE_JOB_EXPIRY,
  type WakeHintOptions,
  type WakeHintPublisher,
  WORKFLOW_WAKE_TABLE,
} from "./workflow-wake-hint.ts";
export { wdkAdapter } from "./workflow-wdk.ts";
export {
  configureWorkflowWorld,
  startWorkflowWorldIfDeclared,
  type WorldKind,
} from "./workflow-world.ts";
export { type SessionWebSocket, safeSend, wireSessionSocket } from "./ws-handler.ts";
