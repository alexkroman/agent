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
export type { SttOpener, TtsOpener } from "../sdk/providers.ts";
// The publisher half of the step env — the READER (`stepEnv`) is authoring API
// on `@alexkroman1/aai/utils`, and lives in `sdk/` because the step bundle
// bundles it. Only a host calls this: the guest at bundle load, `aai dev` on
// every rebuild.
export { publishStepEnv } from "../sdk/step-env.ts";
// The three step slots' publishers. `installWorkflowSupport` below is what
// calls all of them for an ordinary server; these are for a process that
// assembles its own.
export { publishStepFetch, type StepFetch } from "../sdk/step-fetch.ts";
export { publishStepReporter, type StepReporter } from "../sdk/step-report.ts";
export {
  publishUploadReader,
  UPLOADS_UNAVAILABLE_MESSAGE,
  type UploadReader,
} from "../sdk/step-uploads.ts";
// `SessionStateStore.syncSession` mentions this type, and a type a public
// signature MENTIONS but does not export is a docs-build warning here — and
// warnings are errors (see the `WdkStreamOptions` note below, same rule).
export type { StateSyncSession } from "./_state-sync.ts";
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
//
// `registerSttKind`/`registerTtsKind` are the SPEECH-STAGE substitution seam,
// and they are on this subpath rather than on `/stt`+`/tts` because a HOST
// application registers a kind and an agent author never does. `aai-evals`'
// level-1 target is the in-repo consumer: it drives a real pipeline session
// with a real LLM and real tools, with the two speech stages faked, which is
// what "text-driven, above the audio boundary" means in practice.
export {
  type OpenerRegistryEntry,
  registerSttKind,
  registerTtsKind,
  requiredProviderEnvVars,
  resolveLlm,
} from "./providers/resolve.ts";
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
  createSessionEventStream,
  type SessionEventPage,
  type SessionEventStream,
  stampSessionEvent,
} from "./session-event-stream.ts";
// Session state's two backends and the cache in front of them. `createRuntime`
// wires them itself, so what a consumer needs is the TABLE NAME: the platform's
// TTL sweep reads it out of every app schema, and spelling it here rather than in
// that sweep is what keeps a rename from being two edits that can disagree —
// exactly the rule `WORKFLOW_WAKE_TABLE` below states for its own table.
export {
  createPostgresStateBackend,
  SESSION_EVENT_TABLE,
  SESSION_STATE_TABLE,
  // The tables' DDL, applied by whoever CREATES an app schema — the platform, at
  // provisioning. Exported for the same reason the two names above are: the
  // shape is the SDK's and there must be one copy of it, or the schema the
  // platform creates and the tables this backend queries can disagree.
  sessionStateDdl,
} from "./session-state-postgres.ts";
export {
  createMemoryStateBackend,
  createSessionStateStore,
  type SessionStateBackend,
  type SessionStateStore,
} from "./session-state-store.ts";
export {
  builtinFetch,
  CONTAINED_ENV,
  isPrivateIp,
  pinnedFetch,
  resolveAndAssertPublic,
  safeFetch,
  ssrfSafeFetch,
} from "./ssrf.ts";
// Serving workflows, and choosing the world they live in. Shared rather than
// guest-only because `aai dev` needs the identical wiring — and the CLI may not
// import the guest (the dependency edge runs aai-guest -> aai-cli, never back).
// Uploads and step narration: the store both `/uploads` routes are served from,
// and the two publishers that hand a `"use step"` function its reader and its
// reporter. Exported for the embedders that build a server by hand — and for a
// spec, which publishes a fake rather than standing a store up.
export { createStepFetch } from "./step-fetch.ts";
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
  // `PipelineTransportOptions.skipGreeting` names this, so the same rule as
  // `TransportEventBody` below applies: a caller passing the THUNK form — which
  // is how a resume that recovered nothing gets greeted — would otherwise have a
  // type to satisfy and no way to name it.
  SkipGreeting,
  Transport,
  TransportCallbacks,
  // `TransportCallbacks.report` names this, so anything implementing the one
  // needs the other — a forgotten export here would be a type a consumer has to
  // satisfy and has no way to import.
  TransportEventBody,
  TransportEventType,
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
  // `readStream`'s options. Exported because `WdkAdapter` is: a type a public
  // signature MENTIONS but does not export is a docs-build warning here, and
  // warnings are errors — see the root guide's `includeForgottenExports` note.
  type WdkStreamOptions,
  type WorkflowClientOptions,
} from "./workflow-client.ts";
export { installWorkflowSupport } from "./workflow-install.ts";
export {
  createMemoryKeyStore,
  createPostgresKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
  type WorkflowKeyStore,
} from "./workflow-keys.ts";
// The startup sweep that clears queue locks no live pool owns, and the advisory
// lock it contends for. Exported for a SPEC: what a fake cannot check is that
// `graphile_worker.force_unlock_workers` exists and does what its name says, and
// the constants' own doc says they exist "so a test or a verification script can
// contend for the SAME lock without restating the number" — which nothing outside
// this package could do while they stopped here. See
// `aai-server/workflow-lock-sweep.scenario.test.ts`.
export {
  claimPoolPresenceAndSweep,
  type PoolPresence,
  PRESENCE_LOCK_CLASS,
  PRESENCE_LOCK_OBJECT,
  type SweepSkip,
} from "./workflow-lock-sweep.ts";
export { createStepReporter } from "./workflow-report.ts";
export {
  createWorkflowSurface,
  handleWorkflowRequest,
  WORKFLOW_FLOW_PATH,
  WORKFLOW_STEP_PATH,
  WORKFLOW_WEBHOOK_PREFIX,
  type WorkflowSurface,
} from "./workflow-serve.ts";
export {
  createMemoryUploadBlobs,
  createUploadStore,
  resolveUploadBlobs,
  UPLOAD_KEY_PREFIX,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  UPLOADS_TABLE,
  type UploadBlobs,
  type UploadMeta,
  type UploadPart,
  type UploadStore,
  UploadTooLargeError,
} from "./workflow-uploads.ts";
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
