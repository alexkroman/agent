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
 * beside this file rather than in the SDK: the state backends and the tables
 * they own, the workflow serving half, the wake hint, the queue-lock sweep, the
 * step env publisher, and the shipped `Logger` value.
 * `contracts/internal-surface.json` counted 68 of these: tagged `@internal` at
 * their declaration site, and reachable anyway from the root barrel, so no
 * capability could cover them and nothing but a comment said they were not
 * promised. Moving them here took that ratchet to zero, the same way
 * `@alexkroman1/aai` paid off its own 74.
 *
 * A release tag cannot fix that from here: API Extractor reads `@internal` at
 * the DECLARATION site, so a `/** @internal *\/` on a re-export clause member is
 * silently ignored (verified — the name stays `@public` in the report). A
 * subpath is the mechanism this repo already uses twice, for exactly this, and
 * `NON_AUTHORING_SUBPATHS` carries the matching entry so a name arriving here
 * joins no capability contract.
 *
 * **A name is here because something IMPORTS it, and for no other reason.**
 * That rule was learned late: the tranches were assembled by moving whole
 * `@internal` blocks off the root barrel, so the subpath opened at 99 names of
 * which 33 were imported anywhere in the repo. The other 66 were not a smaller
 * version of the same problem — for a name already tagged `@internal` AT ITS
 * DECLARATION the cheaper move was always available, which is simply not to
 * re-export it: intra-package use is relative imports, so nothing breaks, and a
 * name reachable from no subpath cannot be autocompleted, reported, or come to
 * be depended on. They were removed, and the rule stands for the next one — a
 * clause added here in anticipation of a consumer is a surface with no reader.
 * One exception is structural, not aspirational: `WorldKind` is unimported but
 * named by the signature of something on this page, so a consumer satisfying it has
 * to be able to spell it. (There were three; the two the wake hint contributed went
 * with it.)
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

export {
  CONTAINED_ENV,
  publishStepEnv,
  resolveAllBuiltins,
  safeFetch,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_BYTES,
  UPLOAD_TOKEN_RE,
} from "@alexkroman1/aai/host-internal";
// The console-backed `Logger` the CLI, the guest and the platform's own logger
// all start from. The `Logger` TYPE — the thing a host implements — is
// contracted, on the root barrel.
export { consoleLogger } from "./runtime-config.ts";
// Which keys of an agent's env a SERVER may read — everything but the host-mode
// gate. Shared for the same reason `isPathInside` below is: the guest harness makes
// the identical statement about a deployed agent and had its own copy of the line,
// so a gate variable added later would have had to be remembered in two places.
export { agentServerEnv } from "./server-env.ts";
// The containment rule under the static-asset server, shared because it is
// SSRF-adjacent and worth one definition rather than one per caller.
export { isPathInside } from "./server-static.ts";
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
// The cache in front of both backends. `SessionStateBackend` and
// `SessionStateStore` — the shapes a host implementing a backend of its own has
// to name — are contracted, on the root barrel.
export { createSessionStateStore } from "./session-state-store.ts";
// Running one tool call. `ExecuteTool`/`ExecuteToolOptions` — the shapes a host
// substituting an executor names — are contracted, on the root barrel.
export { executeToolCall } from "./tool-executor.ts";
// The workflow HTTP API's method list, which the platform's guest-route table
// has to agree with. The HANDLER is not here: `createServer` mounts the route
// itself, so nothing outside this package wires one by hand.
export { WORKFLOW_API_METHODS } from "./workflow-api.ts";
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
// The two sizes an upload is measured in, plus the id grammar. Exported for the
// PLATFORM, which owns the byte route a deployed guest brokers through: its window
// cap and its key derivation have to be stated in the same units the SDK cuts in,
// and a second copy of either number is a silent disagreement about where an object
// begins. Not on an authoring subpath — an agent author never picks these.
//
// `publishStepEnv` is the publisher half of the step env — the READER (`stepEnv`)
// is authoring API on `@alexkroman1/aai/utils`, and lives in `sdk/` because the
// step bundle bundles it. Only a host calls this: the guest at bundle load,
// `aai dev` on every rebuild.
export {
  createPlatformQueueSend,
  enqueueToPlatform,
  type PlatformQueueOptions,
  payloadRunId,
} from "./workflow-platform-queue.ts";
export {
  callPlatformStorage,
  createPlatformStorage,
  createPlatformStreamer,
  createPlatformStreamReader,
  type PlatformStorageOptions,
} from "./workflow-platform-storage.ts";
// The workflow surface itself and the flow prefix — one spelling, so the
// platform's proxy and this server cannot name different paths.
export {
  createWorkflowSurface,
  handleWorkflowRequest,
  WORKFLOW_FLOW_PATH,
  type WorkflowSurface,
} from "./workflow-serve.ts";
export {
  binaryReplacer,
  binaryReviver,
  decodeTypedJson,
  encodeTypedJson,
} from "./workflow-typed-json.ts";
// Standing an upload store up. The store TYPE, the two blob implementations and
// the part addressing are contracted, on the root barrel; this is what JOINS
// them, which is a host's job.
export { createUploadStore } from "./workflow-uploads.ts";
export { wdkAdapter } from "./workflow-wdk.ts";
// Choosing the world a workflow lives in, and starting it when the agent
// declares one. `WorldKind` is what the first hands the second.
export {
  configureWorkflowWorld,
  startWorkflowWorldIfDeclared,
  type WorldKind,
} from "./workflow-world.ts";
// Wiring a socket up under a session. `SessionWebSocket` — the minimal socket
// shape a host supplies — is contracted, on the root barrel.
export { wireSessionSocket } from "./ws-handler.ts";
