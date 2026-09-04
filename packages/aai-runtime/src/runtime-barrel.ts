// Copyright 2025 the AAI authors. MIT license.
/**
 * Runtime barrel — the full Node.js runtime engine for running agents.
 *
 * **You are probably in the wrong place.** Writing an agent needs
 * `@alexkroman1/aai` and the provider subpaths; nothing on this page. This is
 * the surface for EMBEDDING the runtime in a host process of your own — what
 * `aai dev`, the guest sandbox and a self-hosted `server.mjs` import.
 *
 * If you are embedding one, this is the handful to read, and the rest of the
 * page is plumbing:
 *
 * - {@link createAgentServer} — an agent served over HTTP + WebSocket in one
 *   call. The scaffold's own `server.mjs` imports this and
 *   {@link withHostCredentialFallback}, and nothing else from here.
 * - {@link withToolsDir} — the agent's `tools/` directory, discovered by a
 *   process that has no bundler to do it at build time.
 * - {@link createRuntime} — the engine underneath it ({@link RuntimeOptions},
 *   {@link Runtime}, {@link SessionStartOptions}), for a process that owns its
 *   own transport.
 * - {@link withHostCredentialFallback} — fill an agent's provider credentials
 *   from the host's own environment.
 * - {@link requiredProviderEnvVars} — which keys an agent config needs, before
 *   starting it.
 * - {@link resolveLlm} — turn an LLM descriptor into a Vercel AI SDK model.
 * - {@link createPostgresDb} — the `ctx.db` handle over your own database.
 * - {@link registerSttKind} / {@link registerTtsKind} and the opener contract
 *   below — substituting a speech stage of your own; {@link registerLlmKind}
 *   for the model stage.
 *
 * Everything on this page is CONTRACTED: each name belongs to exactly one of
 * the fourteen capabilities under `contracts/`, so a signature change here is
 * classified against an epoch rather than discovered by whoever's build breaks.
 *
 * The cross-package infrastructure that `aai-server`, `aai-cli` and `aai-guest`
 * need from this package — the host-mode server, the two transports, the
 * session core and its state tables, the durable journal and its DDL, the
 * platform route table, and the workflow delivery door — is deliberately NOT
 * here. It lives on
 * `@alexkroman1/aai-runtime/internal`, which carries no capability, no epoch
 * and no semver promise. A name there that wants to become public gets its
 * `@internal` tag REMOVED at the declaration site and joins a capability under
 * `contracts/entrypoints/`; it is never re-exported from this file with the tag
 * still on it (see `internal.ts`, and `contracts/internal-surface.json`).
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate: a new symbol in one of these modules does not ship as public API
 * until it is added here.
 *
 * @module runtime
 */

// Note: ./_runtime-conformance.ts is intentionally NOT re-exported here.
// It imports `vitest`, which is a devDependency. Re-exporting it would pull
// `vitest` into the production bundle of this barrel and break runtime
// imports in environments without dev deps installed (e.g. the deployed
// platform server). It is consumed directly by sibling test files.

// `SessionStateStore.syncSession` mentions this type, and a type a public
// signature MENTIONS but does not export is a docs-build warning here — and
// warnings are errors (see the `WdkStreamOptions` note below, same rule).
// The OPENER CONTRACT — what `registerSttKind`/`registerTtsKind` (below) take
// and what an opener of your own is written against. It lives here rather than
// on `@alexkroman1/aai/stt`+`/tts` for the reason those two functions do: a HOST
// application registers a kind and an agent author never does, so the types and
// the seam they serve belong on one page. `SttProvider`/`TtsProvider` stay on
// the authoring subpaths — those are what a FACTORY returns, which is an
// author's concern.
export type {
  AgentEnv,
  HostCredentialEnv,
  ProviderEnv,
  RunCodeExecutor,
  SttError,
  SttEvents,
  SttOpener,
  SttOpenOptions,
  SttSession,
  SttTurnMeta,
  TtsError,
  TtsEvents,
  TtsOpener,
  TtsOpenOptions,
  TtsSession,
  TtsWordTiming,
  Unsubscribe,
} from "@alexkroman1/aai/host-internal";
export type { StateSyncSession } from "./_state-sync.ts";
export {
  type AgentServerOptions,
  createAgentServer,
} from "./agent-server.ts";
export {
  createHostServer,
  type HostServerOptions,
  type HostSessionDefaults,
} from "./host-server.ts";
// The guest's own stdout/stderr ring, and the platform's client of it. Shared
// rather than guest-local because both ends of one wire read this shape: the
// guest fills it (`aai-guest/harness-logs.ts`) and the platform serialises what
// it reads back out (`aai-server/agent-logs.ts`). One definition, or the two
// sides can disagree about what a cursor means.
export {
  createLogBuffer,
  DEFAULT_LOG_BUFFER_LINES,
  DEFAULT_LOG_LINE_BYTES,
  DEFAULT_LOG_PAGE_LINES,
  LOG_LINE_TRUNCATED,
  type LogBuffer,
  type LogBufferOptions,
  type LogLine,
  type LogPage,
  type LogStream,
} from "./log-buffer.ts";
// MCP tool discovery — the other source of tools a host assembles before it
// builds a runtime, and the only one that reaches a third party. HTTP only; the
// modules' docs carry why stdio is refused rather than discouraged, and why a
// server that is down costs its own tools and never the session.
export {
  MCP_CONNECT_TIMEOUT_MS,
  type McpCallResult,
  type McpConnectOptions,
  type McpSession,
  type McpSessionOpener,
  type ResolvedMcpServer,
} from "./mcp-connect.ts";
export type { McpDrift, McpTrust } from "./mcp-drift.ts";
export type { McpInputSchema } from "./mcp-schema.ts";
export {
  type McpServerStatus,
  type McpToolSurface,
  type McpToolsOptions,
  withMcpTools,
} from "./mcp-tools.ts";
export {
  type CloseableDb,
  type CreatePostgresDbOptions,
  createPostgresDb,
  type ReservedDb,
} from "./postgres-db.ts";
export { withHostCredentialFallback } from "./providers/host-env.ts";
// Narrow named exports rather than the whole module: the rest of resolve.ts is
// internal descriptor plumbing. `requiredProviderEnvVars` is used by the CLI
// dev server to check credentials before starting; `resolveLlm` lets host
// applications (e.g. the platform server's browser studio) turn an LLM
// descriptor into a Vercel AI SDK model without duplicating provider wiring.
//
// `registerSttKind`/`registerTtsKind`/`registerLlmKind` are the PROVIDER
// substitution seam, and they are on this subpath rather than on
// `/stt`+`/tts`+`/llm` because a HOST application registers a kind and an agent
// author never does. `aai-evals`' level-1 target is the in-repo consumer: it
// drives a real pipeline session with a real LLM and real tools, with the two
// speech stages faked, which is what "text-driven, above the audio boundary"
// means in practice.
//
// All three are ONE mechanism — the same `registerKind` under three names, and
// three doc comments here and in `providers/` describe them as one — so the LLM
// third belongs on the page the other two are on. It was reachable from no
// subpath at all while `resolveLlm`, which READS the registry it writes, was
// published and contracted.
export {
  type LlmRegistryEntry,
  type OpenerRegistryEntry,
  registerLlmKind,
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
// The logger a host passes in, and the S2S tuning bag a config can override.
// The two shipped `Logger` VALUES (`consoleLogger`, `createConsoleLogger`) and
// the debug-env predicates are infrastructure — see
// `@alexkroman1/aai-runtime/internal`.
export type {
  LogContext,
  LogFn,
  Logger,
  LogLevel,
  S2SConfig,
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
export type { SessionCore } from "./session-core.ts";
export type { SessionEventPage, SessionEventStream } from "./session-event-stream.ts";
// The bearer variable that CLOSES the event-stream read route, beside the types a
// reader of it names. On the barrel for the same reason `WORKFLOW_API_TOKEN_ENV` is:
// a host closing a surface has to be able to spell the variable that closes it, and
// this one reached no published subpath at all — so an embedder either hardcoded the
// string or left the route as it found it.
export { SESSION_EVENTS_TOKEN_ENV } from "./session-events-api.ts";
// Applying the session-state DDL to a database this deployment OWNS. The tables
// come with the database and the owner applies them; a self-hosted server is that
// owner, so it needs a way to say so at boot. See the function's own doc.
export { ensureSessionStateSchema } from "./session-state-postgres.ts";
export type {
  SessionStateBackend,
  SessionStateStore,
  // `SessionStateBackend.readEvents` returns these, so a host implementing the
  // backend has to name the type. It is only reachable from here.
  StoredSessionEvent,
} from "./session-state-store.ts";
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
export type { ExecuteTool, ExecuteToolOptions } from "./tool-executor.ts";
// Directory tool discovery — the Node half of `toolRegistry`, and the only
// source of one that reads a filesystem. A host with a bundler in its path (the
// CLI's generated worker entry, a spec's `import.meta.glob`) already has its
// modules; a plain `server.mjs` has neither, and without this the only way to
// give a self-hosted agent a tool was the hand-written map `agent()` refuses.
export { withToolsDir } from "./tools-dir.ts";
export type {
  // `PipelineTransportOptions.skipGreeting` names this. That options type is on
  // `@alexkroman1/aai-runtime/internal`, but the rule is unchanged: a caller
  // passing the THUNK form — which is how a resume that recovered nothing gets
  // greeted — would otherwise have a type to satisfy and no way to name it.
  SkipGreeting,
  // `TransportCallbacks.report` names this, so anything implementing that
  // interface (it is on `@alexkroman1/aai-runtime/internal`) needs the other —
  // a forgotten export here would be a type a consumer has to satisfy and has
  // no way to import.
  TransportEventBody,
  TransportEventType,
} from "./transports/types.ts";
// The workflow HTTP API's ADDRESSING. `createServer` mounts the route itself,
// so nothing outside this package has to wire one — what is exported is the
// token's env var (the guest's deploy path reads it to decide whether a
// deployed app's API is closed) and the prefix, so the platform's proxy and
// this server cannot name different paths. The handler and its engine seam are
// on `@alexkroman1/aai-runtime/internal`.
export {
  MAX_WORKFLOW_INPUT_BYTES,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
} from "./workflow-api.ts";
// The durable-workflow host side's TYPES. The client that becomes
// `ctx.workflows`, and the DevKit binding itself, are on
// `@alexkroman1/aai-runtime/internal`; `resolveKeyStore` is below, beside the
// stores it chooses between.
export type {
  WdkAdapter,
  WdkRunRecord,
  // `readStream`'s options. Exported because `WdkAdapter` is: a type a public
  // signature MENTIONS but does not export is a docs-build warning here, and
  // warnings are errors — see the root guide's `includeForgottenExports` note.
  WdkStreamOptions,
  WorkflowClientOptions,
} from "./workflow-client.ts";
// The journal's tables, for the same reason and the same operator: a self-hosted
// deployment owns its database and `server.mjs` may import only this surface.
export { ensureWorkflowJournalSchema } from "./workflow-journal-schema.ts";
export {
  createMemoryKeyStore,
  createPostgresKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
  type WorkflowKeyStore,
} from "./workflow-keys.ts";
// An embedder's choice between the two LOCAL key stores — Postgres when it holds
// a `Db`, memory otherwise. A DEPLOYED guest does not come through it: the
// platform's own index is selected by `selectKeyStore` (`workflow-runtime.ts`)
// out of the environment, beside `selectJournal`.
export { resolveKeyStore } from "./workflow-keys-select.ts";
// The upload store's two blob backends and the key grammar a window is written
// under. `createUploadStore` and `resolveUploadBlobs`, which JOIN them to a
// record, are `@internal` and on `@alexkroman1/aai-runtime/internal` — the
// asymmetry this package's guide records under "What writing the templates
// found".
export {
  createHttpUploadBlobs,
  createMemoryUploadBlobs,
  type HttpUploadBlobsOptions,
  partKey,
  partsOf,
  UPLOAD_KEY_PREFIX,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  UPLOADS_TABLE,
  type UploadBlobs,
  type UploadMeta,
  type UploadPart,
  type UploadStore,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "./workflow-uploads.ts";
export type { SessionWebSocket } from "./ws-handler.ts";
