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

- [`src/CLAUDE.md`](src/CLAUDE.md) — the flat `src/` modules: session
  lifecycle and vocabularies, `createAgentServer`, tools, subagents, the prompt
  suffix, dialogs/personas wiring, hook commits, the upload store, the egress
  pools, reply metrics.
- [`src/contracts/CLAUDE.md`](src/contracts/CLAUDE.md) — capabilities, epochs,
  and the frozen compatibility templates.
- [`src/transports/CLAUDE.md`](src/transports/CLAUDE.md) — pipeline/S2S
  behaviour: `speech_started`, per-turn prompt resolution, heard history,
  context budget, reset, push-to-talk.
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
  `../aai/sdk/` — Biome's `noRestrictedImports` rejects it and
  `tsconfig.build.json` reports `TS6059`.

## Layout

The filename prefix is the grouping: `runtime-*` (the runtime object and its
wiring), `session-*` (one session), `ws-*` / `_ws*` (the socket layer),
`_upload-*` (the upload store), plus `providers/`, `transports/`,
`telephony/`, `eval/`, `testing/` and `session-state/`.

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
  (`SessionRuntime` for `createRuntimeServer`), never the sealed handle.
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
`eval-simulate-barrel` and `testing-barrel` — they are written by whoever wrote
the `agent.ts`, so they belong in the authoring reference. The root barrel,
`/internal`, `/auth`, `/metrics` and `/tracing` stay deny-listed in
`scripts/docs-markdown.mjs`. See [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
"Rendering `aai-runtime` is a docs decision", for the files one change touches
together.

## Driving an agent from text is a published surface

In [`TEXT-AGENT-CLAUDE.md`](TEXT-AGENT-CLAUDE.md): the text-agent surface, why
a workflow app is evaluated by RUNNING it, and why a keyless run gets a
SCRIPTED model. Which subpaths a template eval may import is konsistent's
`template-eval-runtime-subpaths` (`/eval`, `/eval/simulate`, `/eval/vitest`).

## A deployed guest has TWO copies of this package

The harness bundles its own `aai-runtime` and calls `createRuntimeServer` from
it; the agent's runtime is built by the BUNDLE's `__aaiCreateRuntime`
(`packages/aai-guest/CLAUDE.md`, "User-shipped runtime"). Both load in one
process, so **anything used to rendezvous between them must be keyed on
`globalThis` (`Symbol.for`), never a module-level value.**

The workflow run context (`workflow/run-context.ts`) and the metrics sink
registry (`metrics-sink.ts`) are both `Symbol.for`-keyed for this reason; a
module-level `AsyncLocalStorage` gives one store per COPY, and the symptom is an
empty context `{}` on narration lines plus no streamed progress. **Test it with
`vi.resetModules()`**, which yields a second copy in one process —
`workflow/run-context.test.ts` loads two and asserts a context entered through
one is visible through the other.

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

- **`session.page.tail`** (`session-event-stream.ts`) — a page cannot contain
  events its own tail says do not exist (a read starting past the tail is
  legitimate and answers zero events).
- **`capacity.line.terms`** (`aai-server/platform-db-capacity.ts`) — the terms
  a boot line names must COMPOSE the total it prints. See "The boot line
  describes the reading it was built from" in that package.
