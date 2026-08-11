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
export { isPathInside } from "./server-static.ts";
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
export {
  MAX_WORKFLOW_BLOB_BYTES,
  MAX_WORKFLOW_INPUT_BYTES,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
  type WorkflowApiEngine,
} from "./workflow-api.ts";
export { type SessionWebSocket, safeSend, wireSessionSocket } from "./ws-handler.ts";
