---
summary: >-
  The host runtime: why it is its own package, the one-way dependency on the
  SDK, the `host-internal` seam, the published surface, and package-wide rules
read_when: >-
  working on sessions, transports, providers or workflows on the host side
---

# aai-runtime

`@alexkroman1/aai-runtime` — the host runtime. It is what actually runs an
`agent.ts`: `createRuntime`, `createAgentServer`, the session core, the
transports, the provider openers, the workflow API, and the WebSocket handler.

## Directory guides

Rules that govern one area live beside the files they govern, and Claude Code
loads them when you work there:

- [`src/CLAUDE.md`](src/CLAUDE.md) — the `src/` map (which directory holds
  what, what stays flat), client surfaces, subagents, egress pools, reply
  metrics.
- [`src/session/CLAUDE.md`](src/session/CLAUDE.md),
  [`src/server/CLAUDE.md`](src/server/CLAUDE.md),
  [`src/runtime/CLAUDE.md`](src/runtime/CLAUDE.md),
  [`src/tools/CLAUDE.md`](src/tools/CLAUDE.md),
  [`src/uploads/CLAUDE.md`](src/uploads/CLAUDE.md) — one session's lifecycle
  and vocabularies; `createAgentServer`; the prompt suffix, dialogs and
  personas; tool execution; the upload store.
- [`src/contracts/CLAUDE.md`](src/contracts/CLAUDE.md) — capabilities, epochs,
  and the frozen compatibility templates.
- [`src/transports/CLAUDE.md`](src/transports/CLAUDE.md) — the transport
  boundary, the capability table, per-turn prompt resolution.
- [`src/transports/pipeline/CLAUDE.md`](src/transports/pipeline/CLAUDE.md) —
  the pipeline's stage directories and their import direction, heard history,
  reset, `speakLine`; its `speech/`, `history/` and `reply/` guides hold
  `speech_started` and push-to-talk, the context budget and rollback, and
  code-initiated lines.
- [`src/workflow/CLAUDE.md`](src/workflow/CLAUDE.md) — journal selection,
  webhook URLs, the two base URLs, run notify, the typed-JSON codec.
- [`src/workflow/api/CLAUDE.md`](src/workflow/api/CLAUDE.md) — HTTP status
  classification and upload-id checks.
- [`src/integration/CLAUDE.md`](src/integration/CLAUDE.md) — the S2S and
  history-rollback property tests.
- [`src/telephony/CLAUDE.md`](src/telephony/CLAUDE.md) — where the phone-call
  design lives.

Reference siblings, read on demand: [`JOURNAL-CLAUDE.md`](JOURNAL-CLAUDE.md)
(journal + replay engine), [`TEXT-AGENT-CLAUDE.md`](TEXT-AGENT-CLAUDE.md)
(text mode, `/eval`), [`DIALOG-CLAUDE.md`](DIALOG-CLAUDE.md) (dialog knobs),
[`TOOL-OUTCOMES-CLAUDE.md`](TOOL-OUTCOMES-CLAUDE.md) (tool results and throws).

## What this package is, and what it is NOT

**It is the HOST half.** `@alexkroman1/aai` is the authoring surface —
`agent()`, `tool()`, `sessionSlot()`, the provider FACTORIES — and this package
reads those declarations and runs them. An `agent.ts` imports nothing from here.

A provider factory returns a pure DESCRIPTOR (`{ kind, options }`) and imports
no vendor SDK; the resolver here turns it into an open socket. So the vendor
packages (`@ai-sdk/*`, `@deepgram/sdk`, `ai`, `postgres`, `ws`, …) are
dependencies of this package, never of the SDK — keep them out of every
authoring install.

## The dependency direction is one-way, and it is enforced

`aai-runtime` → `aai`. Never the reverse: both are published, and a cycle would
be unresolvable at install time as well as unbuildable.

Fifteen `host/` modules stay in the SDK because published SDK subpaths need
them: `ssrf.ts`, `builtin-tools.ts`, `builtin-run-code.ts`, `web-search.ts`,
`page-design.ts`, `session-notes.ts`, `_calculate.ts`, `_fetch-capped.ts`,
`_undici.ts` (`/tools`), `ffmpeg.ts` and its two helpers (`/ffmpeg`),
`slugify.ts` (`/slugify`), `workspace-files.ts` (`/workspace-files`). This
package imports them back through those public subpaths.

## `@alexkroman1/aai/host-internal` is the seam

SDK symbols this package needs that are NOT authoring API — tuning constants
(`DEFAULT_STT_SAMPLE_RATE`, `MAX_CLIENT_WS_BUFFERED_BYTES`), the
`resolve*Settings` functions, helpers like `freezeStorable`,
`serializeToolFailure`, `mapStream`, `toToolJsonSchema` — cross on
`@alexkroman1/aai/host-internal`, which is on `NON_AUTHORING_SUBPATHS`: no
capability, no epoch, no TypeDoc page, no semver promise.

- **Other framework packages import it directly** (the guest's studio chat, the
  studio server's model selection, the template gate). Do not re-route them
  through `@alexkroman1/aai-runtime/internal`: an importer's tsconfig would then
  pull this package's whole module graph into its program (it broke
  `aai-templates`' typecheck on a `BodyInit` mismatch in `_upload-blobs-*.ts`).
  What the subpath excludes is an AGENT, not a package.
- **It is not `./internal`**, because that subpath is deliberately ZOD-FREE and
  the schema helpers (`EMPTY_PARAMS`, `isConvertibleSchema`,
  `toToolJsonSchema`) import zod.
- **Adding a symbol:** authoring API → import from the public subpath that owns
  it; otherwise add it to `host-internal.ts`. Never a relative path into
  `packages/aai/src/sdk/` — Biome's `noRestrictedImports` rejects it and
  `tsconfig.build.json` reports `TS6059`.

## Layout

**A directory holding an `index.ts` is a module**, entered through that index
alone (`guard-invariants` rule 37, in aai-ui too): `runtime/`, `server/`,
`session/`, `tools/`, `uploads/`, `mcp/`, `platform/`, `inbox/`, `s2s/`,
`text-agent/`, and `transports/pipeline/` with one subdirectory per stage. The
map, and what stays flat and why, is [`src/CLAUDE.md`](src/CLAUDE.md).
`providers/`, `telephony/`, `eval/`, `testing/` and `session-state/` are
older directories with no index.

**The durable-workflow half is the directory `workflow/`**, with `api/`,
`replay/` and `journal/` for its three largest clusters. It holds the
`_workflow-*` harnesses and `journal-conformance*` too; `step-*` deliberately
stays flat — those are the SDK's step primitives, not the replay engine.

**Before turning another prefix into a directory, find everything that
discovers it by FILENAME** — none of it is a compiler error: suites that scan
for their own subject (`startsWith("workflow-journal-")`),
`RUNTIME_ROUTE_SOURCES` in `guard-invariants-scopes.mjs`,
`check-optional-peers.mjs`'s per-specifier exemptions, and baseline JSONs. A
scan must carry an `expect(found.length).toBeGreaterThan(0)` floor so an empty
match fails loudly. [`JOURNAL-CLAUDE.md`](JOURNAL-CLAUDE.md) has the rest.

## The published surface: two barrels and a rule between them

The capabilities and their epochs are in
[`src/contracts/CLAUDE.md`](src/contracts/CLAUDE.md); what follows is which
barrel a name goes on.

- **`@alexkroman1/aai-runtime` (`runtime-barrel.ts`) is exactly the names the
  capabilities select.** `API-EXPORTS.json` is the count — never write one here.
  Nothing on it is `@internal`; `contracts/internal-surface.json` is at 0 and the
  ratchet only shrinks.
- **`@alexkroman1/aai-runtime/internal` (`internal.ts`) is cross-package
  infrastructure** for `aai-server`, `aai-cli` and `aai-guest`: session-state
  backends, the journal and its DDL, the platform route table, the queue-name
  grammar, the delivery door (`handleWorkflowRequest`, `WORKFLOW_QUEUE_PATH`),
  the typed-JSON storage codec, the step-env publisher, the upload store,
  `consoleLogger`, and SDK pass-throughs. It is on `NON_AUTHORING_SUBPATHS` in
  `scripts/_api-contracts-tree.mjs`: no capability, no epoch, no semver.
- **A name is on `/internal` because something IMPORTS it.** Intra-package use
  is relative imports, so an unimported `@internal` name is simply not
  re-exported. Do not add a clause in anticipation of a consumer.
- **Never re-export another package's non-semver names on the root barrel** —
  the SDK's per-SUBPATH exemption for `host-internal` does not follow them, and
  a contract would then promise epochs on SDK internals.
- **API Extractor reads `@internal` at the DECLARATION site**; a
  `/** @internal */` on a re-export clause is silently ignored. Making a name
  public means removing the tag where it is declared and adding it to a
  capability under `contracts/entrypoints/`, not re-exporting it.
- **A type no published function accepts or returns is not a contract** — a
  contracted type whose constructor is internal is a finding.
- **The 17-name opener contract stays on the root barrel** — konsistent's
  `runtime-opener-contract-on-root-barrel` refuses the tidy-up and carries the
  argument. The opener types are declared here (`providers/openers.ts`).
- The server-side session is `ServerSession` (in `/internal`); `aai-ui`'s is
  `BrowserSession`. Keep the side of the wire in any new name that both
  packages might publish.

### The handles a caller RECEIVES are sealed

`Runtime` carries `[runtimeBrand]: true` and `SessionAuth` `[sessionAuthBrand]`
— each a type-only `unique symbol`, so only `createRuntime` /
`createSessionAuth` can mint one and a received handle can grow a member in a
minor. Rules that follow:

- A test DOUBLE implements the unsealed slice a consumer takes
  (`SessionRuntime` for `createServerForRuntime`), never the sealed handle.
- A method that would widen a sealed handle becomes a free function over it
  (`connectSession`) or a sub-handle.
- A handle that is only ever received (`AgentServer`, `TextAgent`,
  `EvalSession`, …) is tagged `@sealed` in TSDoc so a new member is a revision.
  `EvalTurn` is not — a caller-implemented `SimulationTarget` returns one.
- **Test seams are not public types.** They live on `HostRuntimeOptions` /
  `HostRuntime` via `createRuntimeWithSeams` (`runtime.ts`) and on
  `HostEvalSessionOptions` via `openEvalSessionWithSeams`, reached by relative
  import. Fields shared by every entry point are one `HostAgentOptions`
  (`env` and `llm` are excluded — their types differ per entry point).
- **`auth` stays a server FIELD, not an `upgrade`-hook use**: the hook answers
  synchronously, a claimed socket cannot be handed back, resume ownership is
  recorded on the session the server starts, and the ticket subprotocol must be
  kept out of the handshake reply.

### Four subpaths are RENDERED, and the root barrel is not

`typedoc.json` names only `eval-barrel`, `eval-vitest-barrel`,
`testing-barrel` and `testing-vitest-barrel` — they are written by whoever
wrote the `agent.ts`, so they belong in the authoring reference. The root
barrel, `/internal`, `/auth`, `/metrics` and `/tracing` stay deny-listed in
`scripts/docs-markdown.mjs`. See [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
"Rendering `aai-runtime` is a docs decision", for the files one change touches
together.

## Driving an agent from text is a published surface

In [`TEXT-AGENT-CLAUDE.md`](TEXT-AGENT-CLAUDE.md): the text-agent surface, why
a workflow app is evaluated by RUNNING it, and why a keyless run gets a
SCRIPTED model.

### A test file has TWO doors: `/testing` and `/testing/vitest`

`@alexkroman1/aai-runtime/testing` re-exports every name of
`@alexkroman1/aai/testing` plus `runWorkflow`, `runTextAgent` and
`scriptedTextModel`; `@alexkroman1/aai-runtime/testing/vitest` re-exports every
installer of `@alexkroman1/aai/testing/vitest` plus everything `/eval/vitest`
carries (the eval suites, the runner-free `/eval` half, the simulated caller and
judge, the SDK stubs a case composes with). All as the SAME declarations, so a
unit spec and an eval file each need those two imports for their harness. The
table of which import serves which FILE is "Which testing import, by FILE" in
`packages/aai/src/sdk/CLAUDE.md`.

- **Why on the runtime, and why two.** The SDK never imports this package, so
  its helpers are re-exported HERE rather than the engine moving there; and the
  pure door must stay importable without vitest (an optional peer) —
  `published-testing-split`'s rule that whatever installs or restores is on a
  `/vitest` subpath. `runtime-runner-free-subpaths` refuses a `vitest` import in
  `testing-barrel.ts`.
- **Ownership does not move with a re-export.** The SDK stubs an eval composes
  with are owned here by `eval-stubs`, the rest of the SDK's helpers by
  `testing-stubs` (dropping one from a door is this package's break), and every
  runtime name keeps its capability — `src/contracts/CLAUDE.md`.
- **`testing-doors.test.ts` holds each door to its sources** (values by
  identity, type names by the barrels' lists), so a helper the SDK or
  `/eval/vitest` gains fails here until the door carries it.
- **`/eval/vitest` and `/eval` stay.** `/eval/vitest` is the door
  `/testing/vitest` builds on (a stub an eval needs is a line in
  `eval-vitest-barrel.ts` and one in `testing-vitest-barrel.ts`); `/eval` is
  the runner-free door for a harness that is not vitest —
  `scripts/loadtest-stub-agent` and `aai-evals`' runner import it.
  `/eval/simulate` is gone.
- konsistent's `template-testing-doors` holds every template file to the two
  doors (it refuses the SDK's `/testing` subpaths and `/eval*` there), and
  `template-eval-runtime-subpaths` keeps the embedder subpaths out of a template
  eval.

## The server and the sessions are ONE copy of this package

A worker bundle inlines this package (`__aaiCreateRuntime`, "User-shipped
runtime" in `packages/aai-guest/CLAUDE.md`), and **the guest harness carries no
copy of its own**: it drives the agent through the bundle's, reached as
`__aaiCreateRuntime.host` — the typed `GuestHost` surface (`guest-host.ts`:
`createServerForRuntime`, the delivery door, tracing, the session gate), checked
by `version` at load. A self-hosted host (`aai dev`, `aai start`, a `--target`
entry) builds both the server and the runtime from its own copy. So in every
host the server shell, the engine and the sessions share one module instance,
and **their state is module-level**: the run context, the shared run reads, the
app pool registry, and `WorkflowRequestError` (an `instanceof`).

- **What still crosses copies is registered** in the SDK's `BOUNDARY_KEYS`
  (`aai/src/sdk/_boundary.ts`) and reached by `globalSlot(name)`: the metrics
  sinks (an agent's own code — `registerMetricsSink`, a `createTextAgent` — runs
  in the bundle's copy while a self-hosted exporter lives in the host's), the
  client event feed, and the instance record. Never hand-write `Symbol.for`.
- **Every copy records its module URL** (`_instance-check.ts`); an agent-mode
  guest warns when it sees two (`warnOnSecondRuntime`), and
  `harness/externals.test.ts` fails if the built harness defines a runtime
  function or imports this package statically.
- Adding a field to `GuestHost` is additive; removing or changing one bumps
  `GUEST_HOST_VERSION` and the harness's `SUPPORTED_GUEST_HOST_VERSION`
  (`aai-guest-core/bundle.ts`, pinned equal by its test).

## Runtime invariants

`@alexkroman1/aai/internal` publishes `invariant(condition, name, detail?)`,
`InvariantViolation` and `isInvariantViolation`. State a property once where it
is maintained, and every test, load run and production session becomes a
detector for it.

- **It throws; it is never a log.** A violation is a bug in this process by
  construction; a peer's input is validated by a schema, not by this. A WRONG
  invariant turns a working path into an outage, so add one only for a property
  this code establishes and nothing else can perturb.
- **`detail` is a THUNK**, run only on the failing path so a violation reports
  the actual numbers. Its call is wrapped, so a second throw inside it cannot
  lose the finding.
- **No SAMPLING.** Every invariant today is O(1); add a rate only with the
  first O(n) caller. O(n) whole-log checks belong in a harness
  (`workflow/journal/_invariants.ts`).
- **Never inside an error handler** — a throw there turns a 500 into an
  unhandled rejection. The workflow API's classification is swept over a pure
  function instead (`src/workflow/api/CLAUDE.md`).

Stated so far:

- **`session.page.tail`** (`session/event-stream.ts`) — a page cannot contain
  events its own tail says do not exist (a read starting past the tail is
  legitimate and answers zero events).
- **`capacity.line.terms`** (`aai-server/platform/db-capacity.ts`) — the terms
  a boot line names must COMPOSE the total it prints. See "The boot line
  describes the reading it was built from" in that package.
