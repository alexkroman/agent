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
 *   call.
 * - {@link withToolsDir} — the agent's `tools/` directory, discovered by a
 *   process that has no bundler to do it at build time.
 * - {@link createRuntime} — the engine underneath it ({@link RuntimeOptions},
 *   {@link Runtime}, {@link SessionStartOptions}), for a process that owns its
 *   own transport; {@link connectSession} runs a session over your own audio
 *   I/O on it.
 * - {@link resolveLlm} — turn an LLM descriptor into a Vercel AI SDK model.
 * - {@link createPostgresDb} — a `Db` over your own Postgres, for the stores the
 *   runtime keeps there (`RuntimeOptions.db` — session slots, the workflow
 *   journal and its key index). It is not handed to tool code; a tool needing
 *   SQL brings its own client.
 * - {@link registerSttKind} / {@link registerTtsKind} and the opener contract
 *   below — substituting a speech stage of your own; {@link registerLlmKind}
 *   for the model stage.
 *
 * Everything on this page is CONTRACTED: each name belongs to exactly one of
 * the capabilities under `contracts/`, so a signature change here is
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

// The OPENER CONTRACT — what `registerSttKind`/`registerTtsKind` (below) take
// and what an opener of your own is written against. It lives here rather than
// on `@alexkroman1/aai/stt`+`/tts` for the reason those two functions do: a HOST
// application registers a kind and an agent author never does, so the types and
// the seam they serve belong on one page. `SttProvider`/`TtsProvider` stay on
// the authoring subpaths — those are what a FACTORY returns, which is an
// author's concern. DECLARED in this package (`providers/openers.ts`), so the
// `providers` capability that publishes them also owns them.
export type { AgentEnv, ProviderEnv, RunCodeExecutor } from "@alexkroman1/aai/host-internal";
export {
  type AgentServerOptions,
  createAgentServer,
} from "./agent-server.ts";
// What every way of RUNNING an agent definition takes — `RuntimeOptions`,
// `TextAgentOptions` and the two eval option bags all extend it.
export type { HostAgentOptions } from "./host-agent-options.ts";
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
export type {
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
} from "./providers/openers.ts";
// Narrow named exports rather than the whole module: the rest of resolve.ts is
// internal descriptor plumbing. `resolveLlm` lets host
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
  S2sConfig,
} from "./runtime-config.ts";
// A session over a caller's own audio I/O — a free function over the sealed
// handle rather than a method on it. See `runtime-connect.ts`.
export { connectSession } from "./runtime-connect.ts";
// The seal `Runtime` carries. TYPE-ONLY: there is no value to import, which is
// what stops a hand-written object from satisfying the type.
export type { runtimeBrand, SessionConnection, SessionConnectOptions } from "./runtime-types.ts";
export {
  type AgentServer,
  createRuntimeServer,
  DEFAULT_LISTEN_HOST,
  type RuntimeServerOptions,
  rejectingRuntime,
  type ServerRequestHook,
  type ServerUpgradeHook,
  type SessionRuntime,
  type SharedServerOptions,
} from "./server.ts";
// Authenticating `WS /websocket` — `createSessionAuth`, the ticket helpers and
// their types — is `@alexkroman1/aai-runtime/auth` (`auth-barrel.ts`), its own
// subpath and capability. A server option names only the opaque `SessionAuth`.
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
export { ensureSessionStateSchema } from "./session-state/backends/postgres.ts";
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
export { startTelephonySession } from "./telephony/telephony-server.ts";
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
// `PipelineTransportOptions.skipGreeting` names this, and a caller passing the
// THUNK form — which is how a resume that recovered nothing gets greeted —
// would otherwise have a type to satisfy and no way to name it.
export type { SkipGreetingOption } from "./transports/types.ts";
// The workflow HTTP API's ADDRESSING. `createRuntimeServer` mounts the route itself,
// so nothing outside this package has to wire one — what is exported is the
// token's env var (the guest's deploy path reads it to decide whether a
// deployed app's API is closed) and the prefix, so the platform's proxy and
// this server cannot name different paths. The handler and its engine seam are
// on `@alexkroman1/aai-runtime/internal`.
export {
  MAX_WORKFLOW_INPUT_BYTES,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
} from "./workflow/api.ts";
// The journal's tables, for the same reason and the same operator: a self-hosted
// deployment owns its database and `server.mjs` may import only this surface.
export { ensureWorkflowJournalSchema } from "./workflow/journal/schema.ts";
export {
  createMemoryKeyStore,
  createPostgresKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
  type WorkflowKeyStore,
} from "./workflow/keys.ts";
// An embedder's choice between the two LOCAL key stores — Postgres when it holds
// a `Db`, memory otherwise. A DEPLOYED guest does not come through it: the
// platform's own index is selected by `selectKeyStore` (`workflow/runtime.ts`)
// out of the environment, beside `selectJournal`.
export { resolveKeyStore } from "./workflow/keys-select.ts";
// What an OPERATOR configures an upload bucket with, the record shapes a step
// reads back, and the two failures a caller has to tell apart. The store, its
// two blob backends, the part addressing and the table name are the PLATFORM's
// wiring and are on `@alexkroman1/aai-runtime/internal` — no public signature
// takes or returns one, so a contract over them promised epochs on plumbing.
export {
  UPLOAD_KEY_PREFIX,
  UPLOAD_STORAGE_BUCKET_ENV,
  UPLOAD_STORAGE_KEY_ENV,
  UPLOAD_STORAGE_URL_ENV,
  type UploadMeta,
  type UploadPart,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "./workflow/uploads.ts";
export type { SessionWebSocket } from "./ws-handler.ts";
