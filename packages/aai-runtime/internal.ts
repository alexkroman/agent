// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-package infrastructure this package needs to hand on, and nothing an
 * embedder writes an agent against.
 *
 * **Two tranches live here, and they arrived for the same reason.**
 *
 * The FIRST is pass-through: every name re-exported below from
 * `@alexkroman1/aai/host-internal`, which the SDK itself deny-lists from its
 * contracted surface as "the SDK internals `@alexkroman1/aai-runtime` needs
 * across the package boundary; not semver-covered" (`NON_AUTHORING_SUBPATHS` in
 * `scripts/_api-contracts-tree.mjs`). They used to sit on this package's ROOT
 * barrel, which put fifty not-semver-covered names on the one surface an
 * embedder autocompletes over — and defeated the SDK's own exemption one
 * package over, since the exemption is per SUBPATH and the re-export minted a
 * new one.
 *
 * The SECOND is this package's OWN host infrastructure, declared in the modules
 * beside this file rather than in the SDK: the host-mode server and its relay,
 * the two transports and the `Transport` contract they satisfy, the session
 * core, the session-state backends and the tables they own, the workflow
 * serving half (the API handler, the surface, the world, the install), the wake
 * hint, the queue-lock sweep, the step slots' publishers, and the shipped
 * `Logger` values. `contracts/internal-surface.json` counted 68 of these:
 * tagged `@internal` at their declaration site, and reachable anyway from the
 * root barrel, so no capability could cover them and nothing but a comment said
 * they were not promised. Moving them here took that ratchet to zero, the same
 * way `@alexkroman1/aai` paid off its own 74.
 *
 * A release tag cannot fix that from here: API Extractor reads `@internal` at
 * the DECLARATION site, so a `/** @internal *\/` on a re-export clause member is
 * silently ignored (verified — the name stays `@public` in the report). A
 * subpath is the mechanism this repo already uses twice, for exactly this, and
 * `NON_AUTHORING_SUBPATHS` carries the matching entry so a name arriving here
 * joins no capability contract.
 *
 * **A name here that wants to be public does not get re-exported from
 * `runtime-barrel.ts`.** Its `@internal` tag comes OFF at the declaration site
 * and it joins a capability under `contracts/entrypoints/`, which is what buys
 * it an epoch and a frozen compiling template. Adding it to the barrel with the
 * tag still on it re-opens the ratchet, and the ratchet may only shrink.
 *
 * One block deliberately did NOT come here: the 17-name OPENER CONTRACT
 * (`registerSttKind`/`registerTtsKind` and their parameter types) stays on the
 * root barrel, because relocating it would make a custom speech provider — the
 * documented use — import from two subpaths, one of them labelled
 * not-semver-covered.
 *
 * @module internal
 */

// The publisher half of the step env — the READER (`stepEnv`) is authoring API
// on `@alexkroman1/aai/utils`, and lives in `sdk/` because the step bundle
// bundles it. Only a host calls this: the guest at bundle load, `aai dev` on
// every rebuild.
// The four step slots' publishers. `installWorkflowSupport` below is what
// calls all of them for an ordinary server; these are for a process that
// assembles its own.
// The two sizes an upload is measured in, plus the id grammar. Exported for the
// PLATFORM, which owns the byte route a deployed guest brokers through: its window
// cap and its key derivation have to be stated in the same units the SDK cuts in,
// and a second copy of either number is a silent disagreement about where an object
// begins. Not on an authoring subpath — an agent author never picks these.
export {
  type BuiltinToolOptions,
  builtinFetch,
  CONTAINED_ENV,
  isPrivateIp,
  pinnedFetch,
  publishSpeechSynthesizer,
  publishStepEnv,
  publishStepFetch,
  publishStepReporter,
  publishUploadReader,
  type ResolvedBuiltins,
  resolveAllBuiltins,
  resolveAndAssertPublic,
  resolveBuiltin,
  SANDBOX_ONLY_BUILTINS,
  SPEECH_UNAVAILABLE_MESSAGE,
  type SpeechSynthesizer,
  type StepFetch,
  type StepReporter,
  safeFetch,
  ssrfSafeFetch,
  type ToolDefRecord,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_BYTES,
  UPLOAD_TOKEN_RE,
  UPLOAD_WRITES_UNAVAILABLE_MESSAGE,
  UPLOADS_UNAVAILABLE_MESSAGE,
  type UploadAccess,
  type UploadReader, // `UploadAccess` is an intersection of these two, and a type a public
  // signature MENTIONS but does not export is a docs-build warning — see the
  // `UploadRange` note in `sdk/utils.ts` for the rule.
  type UploadWriteMeta,
  type UploadWriter,
} from "@alexkroman1/aai/host-internal";
// `ctx.generate` as a host builds it — the text-generation entry the studio's
// coding agent and the guest both call. Not authoring API: an agent author gets
// it handed to them on the tool context.
export {
  type CreateGenerateFnOptions,
  createGenerateFn,
  type HostGenerateFn,
} from "./generate.ts";
// HOST MODE — `aai dev --host`, a server that runs an agent definition supplied
// by a connecting client rather than one it was started with. `isHostAllowed`
// is the allow-list check that gate stands on.
export {
  buildHostAgent,
  isHostAllowed,
  type StartHostSessionOptions,
  startHostSession,
} from "./host-mode.ts";
// The other half of host mode: a tool whose `execute` is RELAYED back over the
// socket to the client that supplied the definition.
export {
  createRelayExecuteTool,
  type RelayExecuteTool,
  type RelayToolResult,
} from "./host-relay.ts";
// Which env var each provider's credential is read from. The CLI and the
// platform both spell these when they collect or forward a key, and a second
// copy of the mapping is a silent disagreement about which name is canonical.
export { PROVIDER_CREDENTIAL_ENVS } from "./providers/host-env.ts";
// The two shipped `Logger` values and the debug-env predicates behind them,
// plus the S2S tuning defaults a config is merged over. The `Logger` TYPE — the
// thing a host implements — is contracted, on the root barrel.
export {
  consoleLogger,
  createConsoleLogger,
  DEFAULT_S2S_CONFIG,
  debugLoggingEnabled,
  isDebugEnv,
} from "./runtime-config.ts";
// The static-asset half of `createServer`, split out at the file-length cap.
// `isPathInside` stays exported because the SSRF-adjacent containment rule it
// encodes is worth one definition, not one per caller.
export { isPathInside, serveStatic } from "./server-static.ts";
// Building a session core. The `SessionCore` TYPE is contracted (`session`);
// the constructor and its options bag are not — a host gets a core from
// `createRuntime`, and only this package and the guest stand one up by hand.
export { createSessionCore, type SessionCoreOptions } from "./session-core.ts";
// Reading a session's events back, and stamping one on the way in. The two
// TYPES a reader names (`SessionEventPage`, `SessionEventStream`) are
// contracted, on the root barrel.
export { createSessionEventStream, stampSessionEvent } from "./session-event-stream.ts";
// Session state's Postgres backend. `createRuntime` wires it itself, so what a
// consumer needs is the TABLE NAME: the platform's TTL sweep reads it out of
// every app schema, and spelling it here rather than in that sweep is what
// keeps a rename from being two edits that can disagree — exactly the rule
// `WORKFLOW_WAKE_TABLE` below states for its own table.
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
// The memory backend and the cache in front of both. `SessionStateBackend` and
// `SessionStateStore` — the shapes a host implementing a backend of its own has
// to name — are contracted, on the root barrel.
export { createMemoryStateBackend, createSessionStateStore } from "./session-state-store.ts";
// Uploads and step narration: the store both `/uploads` routes are served from,
// and the two publishers that hand a `"use step"` function its reader and its
// reporter. Exported for the embedders that build a server by hand — and for a
// spec, which publishes a fake rather than standing a store up.
export { createStepFetch } from "./step-fetch.ts";
// `speakOverWebSocket` is the implementation `installWorkflowSupport` publishes,
// exported for the same reason the publishers are: a process assembling its own
// step surface needs the default to hand to one.
export { speakOverWebSocket } from "./step-speak.ts";
// Running one tool call. `ExecuteTool`/`ExecuteToolOptions` — the shapes a host
// substituting an executor names — are contracted, on the root barrel.
export { executeToolCall } from "./tool-executor.ts";
export {
  createPipelineTransport,
  type PipelineTransportOptions,
} from "./transports/pipeline-transport.ts";
// `_internals` (the connectS2s spy seam) is deliberately NOT re-exported: it
// is a mutable object a test patches, and publishing it put a process-wide
// behaviour switch on the `@alexkroman1/aai-runtime` surface. Tests inside
// this package import it from the module directly.
export { createS2sTransport, type S2sTransportOptions } from "./transports/s2s-transport.ts";
// What a transport IS, as the session core sees it. `TransportEventBody` and
// `TransportEventType` — the two types `TransportCallbacks.report` mentions —
// are contracted, on the root barrel, so a consumer that has to satisfy one can
// still name it.
export type {
  Transport,
  TransportCallbacks,
  TransportSessionConfig,
} from "./transports/types.ts";
// The workflow HTTP API's HANDLER and the engine seam behind it. `createServer`
// mounts the route itself, so nothing outside this package wires one by hand.
// The prefix and the token env var — what the platform's proxy and the guest's
// deploy path have to agree with — are contracted, on the root barrel.
export {
  createWorkflowApi,
  WORKFLOW_API_METHODS,
  type WorkflowApiEngine,
  type WorkflowApiOptions,
} from "./workflow-api.ts";
// The durable-workflow host side. `createWorkflowClient` is what becomes
// `ctx.workflows`; `wdkAdapter` (below) is the Workflow DevKit binding,
// separate so the client can be specified without a world. The shapes a host
// names — `WdkAdapter`, `WdkRunRecord`, `WorkflowClientOptions` — are
// contracted, on the root barrel, along with the key-store resolver.
export { createWorkflowClient } from "./workflow-client.ts";
// Serving workflows: the one call that installs every step slot and mounts the
// surface. Shared rather than guest-only because `aai dev` needs the identical
// wiring — and the CLI may not import the guest (the dependency edge runs
// aai-guest -> aai-cli, never back).
export { installWorkflowSupport } from "./workflow-install.ts";
// The startup sweep that clears queue locks no live pool owns, and the advisory
// lock it contends for. Exported for a SPEC: what a fake cannot check is that
// `graphile_worker.force_unlock_workers` exists and does what its name says, and
// the constants' own doc says they exist "so a test or a verification script can
// contend for the SAME lock without restating the number" — which nothing outside
// this package could do while they stopped here. See
// `aai-server/workflow-lock-sweep.scenario.test.ts`. What the sweep reports when
// it declines (`SweepSkip`) is contracted, on the root barrel.
export {
  claimPoolPresenceAndSweep,
  type PoolPresence,
  PRESENCE_LOCK_CLASS,
  PRESENCE_LOCK_OBJECT,
} from "./workflow-lock-sweep.ts";
export { createStepReporter } from "./workflow-report.ts";
// The workflow surface itself and its three route prefixes — one spelling, so
// the platform's proxy and this server cannot name different paths.
export {
  createWorkflowSurface,
  handleWorkflowRequest,
  WORKFLOW_FLOW_PATH,
  WORKFLOW_STEP_PATH,
  WORKFLOW_WEBHOOK_PREFIX,
  type WorkflowSurface,
} from "./workflow-serve.ts";
// Standing an upload store up, and choosing its blob backend. The store TYPE,
// the two blob implementations and the part addressing are contracted, on the
// root barrel; these two are what JOIN them, which is a host's job.
export { createUploadStore, resolveUploadBlobs } from "./workflow-uploads.ts";
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
// Choosing the world a workflow lives in, and starting it when the agent
// declares one.
export {
  configureWorkflowWorld,
  startWorkflowWorldIfDeclared,
  type WorldKind,
} from "./workflow-world.ts";
// The socket layer under a session: wiring one up, and the guarded send that
// drops rather than throwing on a closed socket. `SessionWebSocket` — the
// minimal socket shape a host supplies — is contracted, on the root barrel.
export { safeSend, wireSessionSocket } from "./ws-handler.ts";
