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
 * There used to be three structural exceptions — names nothing imported but a
 * signature on this page could not be spelled without: `WakeHintOptions`,
 * `WakeHintPublisher` and `WorldKind`. All three went with the code that named
 * them (the wake hint, then the DevKit's world), so there are none, and a name
 * arriving here now owes an importer.
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

// One backend under test, as the shared `JournalStore` conformance suite names
// it — imported for the signature of `JournalConformanceSuite` at the foot of
// this file and deliberately NOT re-exported: nothing imports the NAME (an arm
// is written as a literal at its one call site), and this subpath's rule is that
// a name here owes an importer. A consumer that wants it can have the line.
import type { JournalArm } from "./journal-conformance-cases.ts";
// The same, for the `SessionStateBackend` contract's own suite type below. Also
// type-only, so the case module it is declared in — and the `vitest` import at
// the top of that module — is erased rather than bundled; see "Why this is a
// LOADER" at the foot of this file.
import type { SessionStateArm } from "./session-state-conformance-slots.ts";

export {
  CONTAINED_ENV,
  publishStepEnv,
  resolveAllBuiltins,
  safeFetch,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_BYTES,
  UPLOAD_TOKEN_RE,
} from "@alexkroman1/aai/host-internal";
// The guest's own outbound keep-alive. `aai-server` sets the PLATFORM server's
// above it, because the shorter of the two decides and a client value above the
// server's reaps nothing — see `HTTP_KEEP_ALIVE_TIMEOUT_MS` there.
export { EGRESS_KEEP_ALIVE_MS } from "./_egress-fetch.ts";
/**
 * The W3C trace-context parser, so the two sides of the platform hop agree.
 *
 * The runtime MINTS a `traceparent` on every RPC and `aai-server` reads the id
 * off the request to put it on its own log lines. One grammar, in the package
 * that emits it — a second regex in the server would be the drift that makes a
 * correlation key silently stop correlating. `_trace-context.ts` carries the
 * argument.
 *
 * {@link parseTraceparent} is the same parse with the SPAN id and the flags
 * kept, which is what it takes to make the caller's span a real parent rather
 * than merely a matching string — `aai-server/tracing-propagator.ts` is its one
 * consumer, and it is on this seam rather than beside it so the exported span
 * and the log line cannot come to disagree about what a header means.
 */
export { parseTraceparent, type TraceParent, traceIdOf } from "./_trace-context.ts";
// Parsing an `Authorization: Bearer <token>` header. Here because FOUR
// byte-identical copies existed — the guest's gate (`aai-guest/harness-auth.ts`),
// `bearerMatches` in this package, `aai-server/_bearer.ts`, and the platform's
// guest gate through it — and all of them matched the scheme case-sensitively.
// `aai-server` cannot be imported by the other two, so this is the narrowest home
// that reaches all three; it is now the ONLY copy, that module having deleted its
// own once it turned out it could import this subpath (it already does in five
// others). `isBlankSecret` beside it is deliberately NOT exported: the one caller
// outside this package, `guest-bearer.ts`, is safe by its own ordering.
export { parseBearer } from "./bearer.ts";
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
// The five paths the PLATFORM serves a guest on, plus the credential pair every
// client here takes. Declared on this side because the dependency runs one way —
// `aai-server` imports this package and never the reverse — so the five handlers
// take their route from the table rather than restating the literal.
export {
  MAX_PLATFORM_SOCKET_FRAME_BYTES,
  PLATFORM_ROUTES,
  PLATFORM_SOCKET_PATH,
  type PlatformEndpoint,
  type PlatformRoute,
  platformUrl,
} from "./platform-endpoint.ts";
// The guest's own socket CLIENT. Its importer is `aai-server`'s
// `platform-socket.scenario.test.ts`, which drives the real client against the
// real platform over a real port — the one spec that can say the two ends are
// wired to each other, and one neither package can write alone.
export {
  createPlatformSocket,
  type PlatformSocket,
  platformSocketUrl,
} from "./platform-socket.ts";
// The frames that same guest sends when it carries those five routes down ONE
// socket instead of five POSTs. Declared beside the table and for the same
// reason: `aai-server/platform-socket-handler.ts` is the other end of this wire,
// and a schema per side is a frame one of them silently drops.
export {
  PlatformInboundFrameSchema,
  type PlatformReplyFrame,
  parsePlatformFrame,
} from "./platform-socket-frames.ts";
// The console-backed `Logger` the CLI, the guest and the platform's own logger
// all start from. The `Logger` TYPE — the thing a host implements — is
// contracted, on the root barrel.
export { consoleLogger } from "./runtime-config.ts";
// Which keys of an agent's env a SERVER may read — everything but the host-mode
// gate. Shared for the same reason `isPathInside` below is: the guest harness makes
// the identical statement about a deployed agent and had its own copy of the line,
// so a gate variable added later would have had to be remembered in two places.
export { agentServerEnv } from "./server-env.ts";
// The two route TABLES — every path this package serves, split by which surface
// mounts it. `aai-server`'s `GUEST_ROUTES` composes them with the harness's own
// routes instead of re-typing the strings, which is what it did while
// `WORKFLOW_FLOW_PATH` below was already exported for exactly that purpose. See
// `server-routes.ts` for why there are two tables and not one.
export {
  routeMatches,
  SERVER_ROUTES,
  type ServerRoute,
  type ServerRouteMatch,
  WORKFLOW_CALLBACK_ROUTES,
} from "./server-routes.ts";
// The containment rule under the static-asset server, shared because it is
// SSRF-adjacent and worth one definition rather than one per caller.
export { isPathInside } from "./server-static.ts";
// Reading a session's events back, and stamping one on the way in. The two
// TYPES a reader names (`SessionEventPage`, `SessionEventStream`) are
// contracted, on the root barrel.
export { createSessionEventStream, stampSessionEvent } from "./session-event-stream.ts";
// Session state's PLATFORM backend — the HTTP client `aai-server` serves on
// `POST /:slug/session-state`. Here for the same reason `createPlatformJournal`
// below is, and it is the same arm: `session-state-conformance-platform.scenario.test.ts`
// in `aai-server` builds one over the real route and a real Postgres, which is
// the only thing anywhere that exercises this client and the platform's own SQL
// together (its unit arm's transport is a fake over the memory reference). Not
// an embedder's to call — `createRuntime` selects a backend from the boot env.
export { createPlatformStateBackend } from "./session-state-platform.ts";
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
// Where a LOCAL deployment keeps a workflow's on-disk state. The READER
// (`localWorkflowDataDir`) is not here — every reader is inside this package —
// but the one WRITER is `aai dev`, which had spelled the key out by hand
// because it reached no barrel. A disagreement between the two is silent:
// uploads under one directory, runs under another, and no error anywhere.
export { WORKFLOW_DATA_DIR_ENV } from "./workflow-data-dir.ts";
/**
 * A run journal in this process's memory, for a host that must hold one across
 * a rebuild.
 *
 * `aai dev` is the importer and the reason: it rebuilds the runtime on every
 * file save, and the engine's own default is a FRESH journal per build — so
 * every save discarded the runs. STORAGE per process, CODE per build. What a
 * host does with this is pass it as `RuntimeOptions.journal`; nothing else here
 * builds a store by hand.
 */
export { createMemoryJournal } from "./workflow-journal-memory.ts";
/**
 * The journal's PLATFORM backend — the HTTP client `aai-server` serves.
 *
 * Here for the same reason `createPostgresJournal` above is: `workflow-runtime.ts`
 * picks it, and the conformance arm in `aai-server` builds one to drive the real
 * route with. That arm is the only thing anywhere that exercises this client and
 * the platform's own SQL together — its unit arm's transport is a fake over the
 * memory reference — so the export is what makes the last mile of that wire
 * testable at all. Nothing an embedder calls: `createAgentServer` chooses a
 * journal from the boot env.
 */
export { createPlatformJournal } from "./workflow-journal-platform.ts";
/**
 * The durable JOURNAL and its schema.
 *
 * On `/internal` rather than the root barrel because a name is here when
 * something IMPORTS it and it is not authoring API: the two consumers are
 * `workflow-runtime.ts`, which picks a backend, and the scenario suite in
 * `aai-server` that drives the real arm. A host embedding this runtime is handed
 * a journal by `createAgentServer`; it does not build one.
 */
export { createPostgresJournal } from "./workflow-journal-postgres.ts";
export {
  applyWorkflowJournalDdl,
  workflowJournalDdl,
} from "./workflow-journal-schema.ts";
// Asking the PLATFORM to queue a message for one of this guest's own runs.
// `aai-server`'s enqueue handler is the other end, and `payloadRunId` is what it
// reads a run id out of a body with.
export {
  createPlatformQueueSend,
  enqueueToPlatform,
  type PlatformQueueOptions,
  payloadRunId,
} from "./workflow-platform-queue.ts";
// The CLASSIFIER over the queue-name grammar. It began as the DevKit's
// (`parseQueueName` in `@workflow/world`) and is ours now. It is a declared
// dependency of THIS package and not of `aai-server`, so a second spelling on
// that side is exactly the copy this subpath exists to prevent.
//
// The platform calls it TWICE and both are writes rather than reads: the enqueue
// HANDLER refuses a name it cannot classify (400, before the row exists), and
// `workflow-queue-store.ts` stores what it answers as `workflow_queue.kind`. The
// claim then compares that column.
//
// `STEP_QUEUE_NAME_PATTERN` and `WORKFLOW_QUEUE_NAME_PATTERN` used to be exported
// beside it, as strings, because the claim applied them inside Postgres as
// `~ $n` — a `RegExp` would not survive the trip into SQL. Storing the kind
// retires that: the grammar is applied once per message, in this package, and
// `20260903010000_workflow_queue_run_kind_columns.sql` carries what it bought
// (a busy tick 516 ms -> 20 ms) and why the column is not GENERATED from the
// grammar in the DDL instead.
export { queueNameKind, WORKFLOW_QUEUE_PATH } from "./workflow-queue-dispatch.ts";
// The workflow surface itself and the flow prefix — one spelling, so the
// platform's proxy and this server cannot name different paths.
//
// `publishWorkflowWebhookUrl` is beside it for the same reason: the GUEST is the
// one composition that knows its public origin (`AAI_PUBLIC_BASE_URL` in its exec
// env, which the agent env never carries), and it must not learn the webhook path
// in order to publish a minter over it. What it fills is the step slot a workflow
// BODY reads through `stepWebhookUrl`.
export { handleWorkflowRequest, publishWorkflowWebhookUrl } from "./workflow-serve.ts";
export { decodeStorageJson, encodeStorageJson } from "./workflow-typed-json.ts";
// Standing an upload store up. The store TYPE, the two blob implementations and
// the part addressing are contracted, on the root barrel; this is what JOINS
// them, which is a host's job.
export { createUploadStore } from "./workflow-uploads.ts";
// Wiring a socket up under a session. `SessionWebSocket` — the minimal socket
// shape a host supplies — is contracted, on the root barrel.
export { wireSessionSocket } from "./ws-handler.ts";

/**
 * The {@link JournalStore} CONFORMANCE suite, loaded on demand.
 *
 * One case list, run over every arm a run really journals into
 * (`journal-conformance.ts` carries the argument). Two of the three arms live in
 * this package; the third is `createPlatformJournal` wired to the platform's REAL
 * handler and a real Postgres, which can only be stood up in `aai-server` — so
 * the case list has to cross the package boundary, and this is the subpath that
 * direction is allowed on (`aai-server` imports this package; never the reverse).
 *
 * That arm is the whole point: the platform arm in this package's unit tier
 * delegates every SEMANTIC to a memory-backed fake transport, so a divergence in
 * the platform's own SQL is invisible to it — and one was shipped. `createRun`'s
 * `on conflict … do nothing` answered a duplicate run id with SUCCESS while the
 * contract, the memory reference and the self-hosted store all refuse it, so two
 * racing starts on one run id both believed they had won.
 *
 * ## Why this is a LOADER and not a re-export clause
 *
 * The case modules `import { describe, expect, test } from "vitest"`, and vitest
 * is an OPTIONAL peer dependency of this package. A static
 * `export { journalConformance } from …` here is bundled INTO `dist/internal.js`
 * — measured: `import { describe, expect, test } from "vitest"` lands on line 4 —
 * and `@alexkroman1/aai-cli`'s published `dist` imports a VALUE from this exact
 * module (`consoleLogger`, in `_dev-env.ts`) with every bare specifier left
 * external. So the plain clause makes `aai dev` unrunnable in any install that
 * does not happen to have the test runner: `ERR_MODULE_NOT_FOUND` from inside a
 * published package, which neither `publint` nor `attw` can see. Behind a dynamic
 * import the same code splits into its own chunk (verified: zero `vitest`
 * references in `dist/internal.js`) and is fetched only by the caller that asks
 * for it. Same rule as `@alexkroman1/aai-runtime/eval/vitest` and
 * `@alexkroman1/aai/testing/vitest` — anything that pulls the runner is reached
 * deliberately — expressed as a function because this subpath cannot afford to
 * be split in two.
 *
 * A consumer awaits it at the TOP of its test file and registers the cases
 * synchronously afterwards, which is what a `describe` body needs:
 *
 * `no-check`: `describeWithPg` is an `aai-server` test helper, which a doc
 * example cannot import (the harness compiles fences under the SCAFFOLD
 * tsconfig, where a private workspace package does not resolve), and `store`
 * is the arm the reader is registering. Not the `await` and not the loader —
 * both of those type-check.
 * ```ts no-check
 * const { journalConformance, journalIds } = await loadJournalConformance();
 * describeWithPg("…", () => {
 *   journalConformance({ label: "platform", journal: () => store, uid: journalIds("pf") });
 * });
 * ```
 */
export type JournalConformanceSuite = {
  /** Declares the whole case list over one arm. Call inside a `describe` body. */
  journalConformance: (arm: JournalArm) => void;
  /** The arm-independent id factory every case mints its keys from. */
  journalIds: (label: string) => () => string;
};
export async function loadJournalConformance(): Promise<JournalConformanceSuite> {
  const { journalConformance, journalIds } = await import("./journal-conformance.ts");
  return { journalConformance, journalIds };
}

/**
 * The {@link SessionStateBackend} CONFORMANCE suite, loaded on demand.
 *
 * The second loader on this subpath, and it is here for the reason the first one
 * is: `session-state-conformance.ts` declares one case list over every backend a
 * session's durable state really lands in, three of whose four arms live in this
 * package. The fourth is `createPlatformStateBackend` wired to the platform's
 * REAL handler and a real Postgres, which can only be stood up in `aai-server` —
 * so the case list has to cross the package boundary, and this is the subpath
 * that direction is allowed on.
 *
 * **A separate function rather than a widened return, deliberately.** One loader
 * handing back both suites would make an `aai-server` file that registers the
 * journal's cases import the session-state case modules too — a second dynamic
 * chunk pulled in for nothing — and would put two contracts' vocabularies behind
 * one name. One clause per contract; the cost is a paragraph.
 *
 * Why a LOADER and not `export { sessionStateConformance } from …` is measured,
 * and the measurement is `loadJournalConformance`'s above: the case modules
 * `import { describe, expect, test } from "vitest"`, an OPTIONAL peer of this
 * package, and a static clause here lands that import in `dist/internal.js`
 * (line 4, verified) — which `@alexkroman1/aai-cli`'s published `dist` imports a
 * VALUE from with every bare specifier external. `aai dev` would then die with
 * `ERR_MODULE_NOT_FOUND` in any install without the test runner, invisible to
 * both `publint` and `attw`.
 *
 * A consumer awaits it at the TOP of its test file and registers the cases
 * synchronously afterwards, which is what a `describe` body needs:
 *
 * `no-check`: `describeWithPg` is an `aai-server` test helper a doc example
 * cannot import (fences compile under the SCAFFOLD tsconfig, where a private
 * workspace package does not resolve), and `backend` is the arm the reader is
 * registering. Not the `await` and not the loader — both of those type-check.
 * ```ts no-check
 * const { sessionStateConformance, sessionStateIds } = await loadSessionStateConformance();
 * describeWithPg("…", () => {
 *   sessionStateConformance({ label: "platform", backend: () => backend, uid: sessionStateIds("pf") });
 * });
 * ```
 */
export type SessionStateConformanceSuite = {
  /** Declares the whole case list over one arm. Call inside a `describe` body. */
  sessionStateConformance: (arm: SessionStateArm) => void;
  /** The arm-independent session-id factory every case mints its keys from. */
  sessionStateIds: (label: string) => () => string;
};
export async function loadSessionStateConformance(): Promise<SessionStateConformanceSuite> {
  const { sessionStateConformance, sessionStateIds } = await import(
    "./session-state-conformance.ts"
  );
  return { sessionStateConformance, sessionStateIds };
}
