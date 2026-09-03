# aai-runtime

`@alexkroman1/aai-runtime` — the host runtime. It is what actually runs an
`agent.ts`: `createRuntime`, `createAgentServer`, the session core, the
transports, the provider openers, the workflow API, and the WebSocket handler.

## What this package is, and what it is NOT

**It is the HOST half of what used to be one package.** `@alexkroman1/aai` is
the authoring surface — `agent()`, `tool()`, `sessionSlot()`, the provider
FACTORIES — and everything in it is what a user types. This package is what
reads those declarations and runs them. An `agent.ts` imports nothing from
here.

The split is along a line the SDK already drew: **a provider factory returns a
pure DESCRIPTOR** (`{ kind, options }`) and imports no vendor SDK, and the
host-side resolver is what turns a descriptor into an open socket. That is why
the vendor packages are dependencies of this package and not of the SDK.

Two things came out of the split, and both are the reason not to undo it:

- **21 dependencies left the authoring install.** Every `@ai-sdk/*` adapter,
  `@deepgram/sdk`, `@elevenlabs/elevenlabs-js`, `@cartesia/cartesia-js`,
  `assemblyai`, `ai`, `postgres`, `ws`, `@workflow/world*` — none of which an
  `agent.ts` touches, all of which were in every user's `node_modules`.
- **~220 exports left the authoring reference**, which was two thirds of a
  combined API doc aimed at people writing agents.

## The dependency direction is one-way, and it is enforced

`aai-runtime` → `aai`. Never the reverse. `@alexkroman1/aai` may not import
this package: it is published, this package is published, and a cycle between
them would be unresolvable at install time as well as unbuildable.

Fifteen `host/` modules deliberately did NOT move, because published SDK
subpaths need them: `ssrf.ts`, `builtin-tools.ts`, `builtin-run-code.ts`,
`web-search.ts`, `page-design.ts`, `session-notes.ts`, `_calculate.ts`,
`_fetch-capped.ts`, `_undici.ts` (`@alexkroman1/aai/tools`), `ffmpeg.ts` and
its two helpers (`/ffmpeg`), `slugify.ts` (`/slugify`), and
`workspace-files.ts` (`/workspace-files`). This package imports them back
through those public subpaths.

## `@alexkroman1/aai/host-internal` is the seam

79 SDK symbols are needed by this package and are NOT authoring API — mostly
tuning constants (`DEFAULT_STT_SAMPLE_RATE`, `MAX_CLIENT_WS_BUFFERED_BYTES`,
`STT_FRAME_TARGET_MS`), the `resolve*Settings` functions every provider module
declares, and a handful of helpers (`freezeStorable`, `serializeToolFailure`,
`mapStream`, `toToolJsonSchema`).

They cross on `@alexkroman1/aai/host-internal`, a subpath that exists for
exactly this and is on `NON_AUTHORING_SUBPATHS` — no capability, no epoch, no
TypeDoc page, no semver promise.

**Three other FRAMEWORK packages import it directly, and that is the intended
route rather than a leak.** The guest's studio chat needs
`ASSEMBLYAI_LLM_API_KEY_ENV`, the studio server's model selection needs
`gatewayModelIds`, and the template gate needs
`ASSEMBLYAI_TTS_DEPRECATED_VOICES` — all SDK internals, none of them authoring
API. Handing them on through `@alexkroman1/aai-runtime/internal` was tried and
is worse: an importer's tsconfig then pulls this package's whole module graph
into its own program, which broke `aai-templates`' typecheck on an unrelated
`BodyInit` mismatch in `_upload-blobs-*.ts`. What the subpath excludes is an
AGENT, not a package.

**It is NOT `./internal`, and the reason is a documented invariant.** That
subpath is deliberately ZOD-FREE, and three of the 79 (`EMPTY_PARAMS`,
`isConvertibleSchema`, `toToolJsonSchema`) are the schema-conversion helpers,
which import zod by construction. Widening `./internal` to fit them would have
silently deleted the rule, so the host support surface got its own name.

When you need a new SDK symbol here: if it is authoring API, import it from the
public subpath that owns it. If it is not, add it to `host-internal.ts`. Do not
reach for a relative path into `../aai/sdk/` — Biome's `noRestrictedImports`
rejects it, and `tsconfig.build.json` reports it as `TS6059`.

## Layout

Flat, like the package it came out of. The filename prefixes are the grouping:
`runtime-*` (the runtime object and its wiring), `session-*` (one session's
lifecycle), `workflow-*` (the durable-workflow half), `ws-*` / `_ws*` (the
socket layer), `_upload-*` (the upload store), and the three subdirectories
that did keep a directory — `providers/`, `transports/`, `telephony/`.

## Telephony: a phone call is an ordinary session

`WS /phone` (`telephony/`) runs a carrier's media stream — Twilio Media
Streams, Telnyx media streaming — as an ordinary session, served by
`createServer` with no per-agent configuration. **The whole account is in
`packages/aai-guest/CLAUDE.md`, "A phone call is an ordinary session"** — the
shim design and the rule that no telephony branch may exist below the bridge,
the four decisions above the bridge (pacing, LEARNED rates, low-pass before
downsampling), what a `CarrierCodec` owes, and the two deliberate gaps. It is
the harness that serves this in production; the platform's TwiML webhook route
is in `packages/aai-server/CLAUDE.md`, "Telephony". This pointer used to sit in
`packages/aai/CLAUDE.md` under a `host/telephony/` path that has not existed
since the split, and that guide is at its cap.

## The published surface is versioned in epochs

Fourteen capabilities under `contracts/`, each a named slice of what an
embedder writes against: `server`, `runtime`, `session`, `session-state`,
`providers`, `telephony`, `uploads`, `db`, `keys`, `workflow`, `logging`,
`text`, `tools`, `eval`. The
mechanism is the repo's — see "The authoring surface is versioned in epochs" in
`docs/CLAUDE.md`, which owns all three artifacts over this surface (the reports,
the epochs and the renderings); `AGENTS.md` keeps the four obligations a change
owes — and what it means here is that a signature change on any
of the 125 public names is CLASSIFIED (`--bump … --retain` or `--drop "<reason>"`)
rather than discovered by whoever's build breaks.

`tools` is the smallest — one name, `withToolsDir` — and it is
its own capability rather than part of `runtime` because it assembles the
DEFINITION a runtime is handed rather than any part of the engine. See "Tool
discovery off the platform" below.

`eval` is the newest, and the only capability spanning TWO subpaths — see
"Driving an agent from text is a published surface" below.

The split shipped this package with no `contracts/` tree, so for its first days
221 exports moved with nothing recording it, while `aai` and `aai-ui` could not
change a parameter without a gate asking which. That asymmetry is the whole
reason this exists.

**A RETAINED epoch owes a frozen, compiling TEMPLATE** under
`contracts/compatibility/<capability>/v<N>.ts`, and `pnpm typecheck` is what
enforces it. There are **seven** — `db@2`, `runtime@3`, `server@4`,
`session-state@1`, `session-state@2`, `telephony@1` and `workflow@1` — and this
paragraph said "there are none today" until the DevKit removal retained the
first of them. Editing one to make an error go away defeats the mechanism: the
error IS the finding, and the way to change an API is a new epoch carrying a new
template.

**A template rather than an example, and the distinction is the point.** `aai`
and `aai-ui` freeze snippets an author READS: an `agent.ts` is a short file and
the useful artifact is a fragment of one. This package's consumers embed it —
they stand up a host, a carrier codec, a state backend — so the useful artifact
is a starter they COPY and edit, composed front to back, with the edit points
marked and no design commentary in the way (that material is in this guide,
which is where a reader can find it without opening twelve files). Each is the
starter as it was written AT THAT EPOCH; the way to change an API is a new epoch
carrying a new template, never an edit to a frozen one.

**A template does not exercise every contracted name, and that is not a hole in
the gate.** The epoch hash covers the capability's REPORT, which carries every
name the entrypoint selects — so a signature change on `partKey` moves
`uploads`'s hash and demands a classification whether or not any template
mentions it. Classification coverage is every name; what the rest lack is a
compile-time exercise. The gap is deliberate and per name:
`createServer`/`createHostServer` are a different artifact from the bootstrap
(embedding into an existing runtime, and a multi-tenant host-mode server);
`partKey`/`partsOf` would need a `delete` that `UploadBlobs` does not have;
`telnyxCodec`/`twilioCodec` are the shipped carriers a third-carrier template
exists to be an alternative to. Contorting a starter to touch all of them is how
these files became catalogues the first time. Where a name's absence is a
finding rather than a choice, it is in the list below.

### The root barrel had 50 names it does not own

Opting in is what surfaced it. `authoringSurface` reported **153** public names
where the package declares 103; the other fifty were re-exports of
`@alexkroman1/aai/host-internal`, which the SDK itself deny-lists from its own
contracted surface as "not semver-covered". **The exemption is per SUBPATH, so
re-publishing those names on this package's root barrel defeated it** — they
were back on the one surface an embedder autocompletes over, one package along,
and a contract over them would have promised epochs on the SDK's internals.

A release tag cannot fix that from here: **API Extractor reads `@internal` at
the DECLARATION site, so a `/** @internal */` on a re-export clause member is
silently ignored.** Verified before relying on it — the name stayed `@public` in
the regenerated report. The mechanism that does work is a subpath, which is what
`aai` uses twice for the same reason.

So `@alexkroman1/aai-runtime/internal` carries the platform-infrastructure
pass-throughs — seven of them now: the builtins resolver, the SSRF-safe fetch,
the step-env publisher, the containment flag, and the upload byte constants plus
the id grammar — and `NON_AUTHORING_SUBPATHS` in
`scripts/_api-contracts-tree.mjs` names it so a name arriving there joins no
capability. It opened at 31; the other 24 were moved off the barrel wholesale
and imported by nothing, and the rule that took them back off is below.
`aai-server`, `aai-cli` and `aai-guest` import from what is left — which is
honest, since they are the cross-package consumers the seam exists for.

**The 17-name OPENER CONTRACT deliberately stayed on the root barrel.**
`registerSttKind`/`registerTtsKind`/`registerLlmKind` live there — all three are
`registerKind` under three names, which is why the LLM one joined them (it
reached no published subpath at all while `resolveLlm`, the reader of the
registry it writes, was contracted). Moving their parameter types
(`SttOpener`, `SttOpenOptions`, `SttSession`, and the Tts twins) would make a
custom provider — the documented use, and what `aai-evals/fake-speech.ts` really
does — import from two subpaths, one of them labelled not-semver-covered. The
block's own comment already called those names one contract; the split respects
it. Do not "tidy" them onto `/internal` later.

### `SessionCore` collides with `aai-ui`, and renaming is this package's call

Root `AGENTS.md`'s "Disambiguating cross-package names" records one live
collision — `SessionCore`, one word for the two sides of one wire: here the
SERVER session bridging a `Transport` to the client protocol, in `aai-ui` the
BROWSER session (socket + audio + state). Neither reference page names the
other. That table used to carry four rows, and what the `/internal` split
resolved was never written down: `createSessionCore`, `createWorkflowApi` and
`WorkflowApiOptions` went to `@alexkroman1/aai-runtime/internal` — a public name
against an `/internal` one is not a collision, it is what `/internal` is for —
and then off the published surface entirely, under that subpath's "a name is
here because something IMPORTS it" rule. They are relative-import internals now,
so `API-EXPORTS.json` shows all three on `aai-ui` alone.

**Which INVERTS the old "do not rename either half" advice for those three.** It
held while both sides were contracted; an unpublished name has no epoch, no
frozen example and no semver promise, so renaming the runtime halves costs a
sweep rather than an epoch a side — and is worth doing, since they still occur
in ten-odd files here each and every reader disambiguates by package before
reading. Recommended, not done.

### The root barrel is the CONTRACTED surface, and nothing else

`contracts/internal-surface.json` opened at **68** and stands at **0**. Those 68
were the SECOND tranche off the root barrel, and unlike the 31 above they are
this package's OWN declarations rather than pass-through of the SDK's: tagged
`@internal` where they are declared, reachable anyway from the one page an
embedder autocompletes over, and therefore covered by no capability and promised
by nothing but a comment. They now sit on `@alexkroman1/aai-runtime/internal`
beside the pass-through tranche, which is the same move that took `aai` from 74
to 0.

**The division is now mechanical, and it is worth stating as a rule.**

- **`@alexkroman1/aai-runtime` (`runtime-barrel.ts`)** is exactly the 125 names
  the fourteen capabilities select. A name here has an epoch and a report.
  Nothing on it is
  `@internal` — that is what the zero means, and the ratchet is what holds it.
- **`@alexkroman1/aai-runtime/internal` (`internal.ts`)** is the cross-package
  infrastructure `aai-server`, `aai-cli` and `aai-guest` need: the session-state
  backends and their tables, the durable JOURNAL and its DDL, the platform route
  table, the queue-name grammar and its classifier, the delivery door
  (`handleWorkflowRequest`, `WORKFLOW_QUEUE_PATH`), the typed-JSON storage codec,
  the step-env publisher, the upload store, and the shipped `consoleLogger`. No
  capability, no epoch, no semver promise.

  **A name is on it because something IMPORTS it.** Both tranches were assembled
  by moving whole `@internal` blocks off the root barrel, which is why the
  subpath opened at 99 names of which **33** were imported anywhere in the repo.
  The other 66 were not a smaller version of the ratchet problem: for a name
  already tagged `@internal` at its DECLARATION, simply not re-exporting it is
  cheaper than publishing it somewhere quieter — intra-package use is relative
  imports, so nothing breaks, and a name reachable from no subpath cannot be
  autocompleted, reported on, or depended upon. They are gone, and adding a
  clause here in anticipation of a consumer is a surface with no reader. There
  used to be three structural exceptions — `WakeHintOptions`,
  `WakeHintPublisher` and `WorldKind`, unimported but named by the signature of
  something that was. All three went with the code that named them, so a name
  arriving here now owes an importer.

Where a capability's TYPE is contracted and its CONSTRUCTOR is not, the two are
deliberately on different pages and each clause says so: `SessionCore` on the
barrel and `createSessionCore` on `/internal`, `SessionStateBackend` against
`createPostgresStateBackend`, `UploadStore` against `createUploadStore`,
`WorkflowClientOptions` against `createWorkflowClient`. (There was a fourth,
`SweepSkip` against `claimPoolPresenceAndSweep`; the queue-lock sweep went with
the DevKit's world.) That asymmetry is a finding, not a shape to copy — see
"What writing the templates found" below.

**Making one of them public is not a re-export.** The `@internal` tag comes OFF
at the declaration site and the name joins a capability under
`contracts/entrypoints/`, which is what buys it an epoch and obliges a template.
Adding it to `runtime-barrel.ts` with the tag still attached puts it straight
back on the ratchet, and the ratchet may only shrink — a `/** @internal */` on
the re-export clause does not help, for the API Extractor reason above.

### What writing the templates found

Four things this surface cannot demonstrate about itself (two capabilities
publishing a type whose constructor is `@internal`, `WdkAdapter`'s nine methods
with no partial-implementation affordance, `TextTurnResult` letting an upstream
minor force an epoch), plus the one real defect they caught. **In
[`docs/CLAUDE.md`](../../docs/CLAUDE.md), "What writing the `aai-runtime` epoch
templates found"** — that guide owns the epochs; this one is at its cap.

### Self-hosted durable workflows: there is no world to start any more

**This section used to be four times as long, and deleting it is the clearest
measure of what the DevKit removal bought.** `createAgentServer` had to
`configureWorkflowWorld` (writing `WORKFLOW_TARGET_WORLD` and two more keys into
`process.env`), then `publishStepEnv`, then build a compiled `WorkflowSurface`
out of the `workflowCode`/`stepCode` pair `aai build` left on the worker bundle,
then `startWorkflowWorldIfDeclared` — in that order, and BEFORE the bind
whenever the port was known, so no request could reach a `getWorld()` that would
resolve and memoize an unconfigured world. `listen(0)` could not honour that and
had its own branch. Get any of it wrong and a self-hosted run sat `pending`
forever with nothing logged.

The replay engine executes a run in THIS process off the agent's own `workflows`
declaration. There is no artifact to load, no world to resolve, no memoization
window, and no port-0 special case. What is left of the sequence is one line:

- **`publishWorkflowStepEnv()` before the bind**, guarded on the agent declaring
  workflows. The guard is not frugality — it writes a module-global, so
  publishing for every `createAgentServer` would leak one test's env into the
  next (`unstubEnvs` only undoes `vi.stubEnv`). It publishes the AGENT env
  rather than `providerEnv`, so a step sees exactly what `.env` declares and
  cannot come to depend on a shell-exported key that will not exist after a
  deploy.

Two things the old wiring's failure taught, which still hold:

- **A test has to boot a workflow through this DOOR.** The e2e suite's
  `npm start` leg used `pizza-ordering`, which declares no workflows, and the
  one durable leg ran under `aai dev` — so the door nobody tested was the one
  that did not work. `aai-cli`'s `e2e.test.ts` covers both now, and the
  `pack + build + boot` subset boots every template it builds, a workflow app
  among them.
- **The scaffold PROMISES this.** `server.mjs` documents `PUBLIC_URL` as what to
  set "whenever a durable workflow has to hand a URL to somebody else", and
  `AgentServerOptions.env`'s own doc treats a dropped `DATABASE_URL` as a bug
  because a workflow upload's record would otherwise vanish before a resumed run
  read it. `ensureWorkflowJournalSchema` is on the PUBLIC barrel for the same
  reason — see "The tables come WITH the database" in
  `workflow-journal-postgres.ts`.

**The other half is the delivery door.** `createAgentServer` composes
`handleWorkflowRequest` into `createServer`'s `request` hook, so this door is
wired identically to `aai dev`'s and the harness's — but it supplies no
`allowRemote`, so `POST /workflow-queue` answers 401. That is correct: a
self-hosted server has no platform-owned queue to be vouched for by, and the
engine's own in-process timers are what deliver. What the composition buys is
that a door cannot silently LACK the route.

**What is still NOT wired is host mode** (`createHostServer`): its sessions run
caller-supplied agents, which declare no workflows.

### `createAgentServer` forwards what only it can

A front door has a failure mode the pair underneath does not: an option it does
not carry is unreachable, because dropping back to `createRuntime` +
`createServer` to set one means restating by hand every field the wrapper
derives — the silent drop the wrapper exists to prevent. `telephony` was the
sharp instance. It defaults to `!isStatic` in `createServer`, `createAgentServer`
did not forward it, so every server built through the documented door — the
scaffold's `server.mjs` included — mounted an unauthenticated `WS /phone` with no
way to switch it off. `page` was worse: the AGENT declares it, and nothing
carried the declaration through, so a `page: "static"` agent still got the voice
surfaces and a voice `GET /client-config`. It is read off the agent now, beside
`name` and `greeting`, with an explicit field still winning.

**`env` was the third, and it is why "belongs to the other door" is not a safe
reason to drop an option.** This guide used to call `ServerOptions.env` half of
"the host-mode pair" and leave it out on that ground: host mode is
`createHostServer`'s business, so an env on this door looked like an option for
a feature this door does not have. But `createServer` reads FOUR things out of
that record and only one of them is the host gate — `AAI_WORKFLOW_API_TOKEN`,
documented in `workflow-api.ts` as what CLOSES `/workflows/*`;
`AAI_SESSION_EVENTS_TOKEN`, the same shape one route over; and `DATABASE_URL`,
which is where a workflow upload's RECORD lives. So an operator who set the
token was still serving the workflow API, and its upload WRITE routes, wide
open, and an operator with a provisioned database still had uploads land in
this process's temp directory and vanish before a resumed run could read them.
The guest harness had the identical bug with the identical three symptoms — it
called `createServer` with no `env` at all — which is the tell that the
classification was wrong rather than the wiring.

It is forwarded now, minus the gate, through `agentServerEnv` (`server-env.ts`,
shared with the guest so the filter has one spelling): `?host=1` lets a caller
supply its own agent definition and run it on the operator's credentials, so
that key arriving with the other three would turn one secret into an
unauthenticated surface. `hostBaseAgent` really does belong to the other door.
**And the lesson for the next option is where the test went**: the token WAS
covered, by a spec that called `createServer` directly, which is exactly why the
wrapper's version survived it. A forwarding spec has to take the door a caller
takes.

**`journal` was the fourth, and it is why this is a CHECK now rather than a
rule.** `RuntimeOptions.journal` takes a host-supplied `JournalStore` — the whole
point being that a deployment which already owns a database keeps its durable
runs there — and this door did not forward it, so the only way to supply one was
to drop back to `createRuntime` + `createServer` and restate by hand every field
the wrapper derives. Found writing `contracts/compatibility/server/v8.ts`, which
could not name `AgentServerOptions["journal"]` while the option was nonetheless
IN this capability's report (the `agent: RuntimeOptions["agent"]` rollup).

**`agent-server-forwarding.ts` is what stops a fifth.** Every `RuntimeOptions`
member is either on `AgentServerOptions` or on an explicit
`UnforwardedRuntimeOption` deny-list with its reason, and `ForwardingGap` is the
subtraction — `never` today, and the NAME of the offending member the moment one
is added. That fails `turbo run typecheck` AND the build, because the module is
compiled by `tsconfig.build.json` and a build failure cannot be skipped by a test
filter. It is the same shape as `AgentConfigSchema`'s
`HOST_ONLY_AGENT_FIELDS` subtraction one package over, and for the same reason:
every field here is optional, so an omission is valid TypeScript and presents as
a working server quietly ignoring part of its own configuration.

Two things about it worth knowing. It is checked in BOTH directions — a
`StaleExcuse` (an entry naming a member `RuntimeOptions` no longer has) and a
`RedundantExcuse` (one the door now forwards) each fail the same way, and the
first direction caught THREE wrong entries on its first run: a draft excused
`name`, `greeting` and `hostBaseAgent`, none of which is a `RuntimeOptions`
member at all. And the enforcement really is `tsc` rather than the suite — the
spec beside it is type-level, so a gap reports three passing tests; that file
says so rather than implying otherwise.

`uploadBroker` came with the three above; the remaining absences are now
DECISIONS, each with a reason at its deny-list entry rather than in this guide.
`name` and `greeting` are derived, which is the whole point.
And of `RuntimeOptions`' twenty, the fourteen unreachable ones are the testing
and sandbox seams (`executeTool`, `toolSchemas`, `createWebSocket`,
`createOpenaiRealtimeWebSocket`, `runCode`, `fetch`, `onToolResult`,
`toolGuidance` — `@internal` or platform-harness only), the provider triple
`stt`/`llm`/`tts` (which the agent declares), and the three tuning numbers
(`s2sConfig`, `sessionStartTimeoutMs`, `shutdownTimeoutMs`). Forward one of those
when somebody needs it, not before.

## Subagents: `ctx.delegate` is a second tool loop

`subagent.ts` implements the `ctx.delegate` capability (`sdk/subagent.ts` in
`@alexkroman1/aai` holds the contract). A subagent is the AI SDK's own subagent
pattern — a `ToolLoopAgent` invoked from inside a tool's `execute` — with the
three things that pattern leaves to the author supplied by the runtime instead,
and each of the three is a bug an author would otherwise write:

- **The model** resolves through the same `resolveLlm` registry as the pipeline
  and `ctx.generate`, credentials from the agent env. A hand-built
  `new ToolLoopAgent({ model })` in a tool body has no way to reach that env, so
  it reads `process.env` — on a platform where every provider key is
  user-provided and `process.env` holds none of them.
- **The tools** go through `executeToolCall` like every other tool call, so a
  subagent's tools get argument coercion, Standard Schema validation, the
  per-call deadline, a real `ToolContext`, and failure-shaped-as-a-tool-result.
  The alternative is a second, thinner tool runtime inside the first.
- **The step budget** spends its last step with `toolChoice: "none"`, via the
  same `forceFinalAnswer` the voice pipeline and `createTextAgent` use, so a
  capped subagent ANSWERS rather than stopping mid-chain — which for a subagent
  is worse than for a turn, because its final message is the ONLY thing that
  crosses back.

**The runner is handed a tool call's own option bag, not a list of
dependencies.** `SubagentRunner` (declared in `tool-executor.ts`, beside the
bag) takes `ToolCallDefaults` — `Omit<ExecuteToolCallOptions, "tool">`, derived
by subtraction — because a delegated run's tools are ORDINARY tool calls and
re-enter `executeToolCall` with that same bag. So what the runner needs from a
tool call is exactly what a tool call already has, and a capability added to a
tool context cannot be silently missing from a delegated one. The two types are
mutually recursive for the same reason, which is why one of them is declared
next to the other rather than beside its implementation.

**A subagent's context is the parent's, minus the conversation.** Its tools see
the same `env`, slots, `db` and `sessionId` — it is the same session, and a
subagent that could not read the cart would be a worse tool than the one that
delegated to it. What it does not see is `ctx.messages`: the isolation a
subagent exists FOR is the context window, and one handed the transcript has
given that back. `DelegateOptions.task` is what carries anything from the
conversation, which is why the contract insists it be a complete brief.

**Delegation is one level deep.** A subagent's own tools get a `ctx.delegate`
that rejects with `NESTED_DELEGATE_MESSAGE`, naming the rule. A subagent that
may delegate can delegate to itself, and nothing at this seam can see the
recursion — a depth counter would bound the bill without making it quotable,
which on a phone call is the number that matters. The refusal REPLACES the
runner rather than dropping it, so the message says why rather than reporting a
capability that happens not to be wired here.

**What crosses back is the answer plus a cost report, never a transcript.**
`DelegateResult.toolCalls` carries the CALLS and not their results: the results
are what stayed inside the subagent's window, and a caller handed them back has
undone the delegation. The calls are enough for a voice agent to say something
true about the wait ("I checked four sources"), which is what the field is for.

Wired in three places, all of them the same two lines: `setupSubagents` in
`runtime-tools.ts` (both the sandbox and self-hosted paths) and
`createTextAgent`. `createSubagentRunner` memoizes its models per descriptor
OBJECT like `createGenerateFn`, so a subagent declared at module scope reuses
one client across a session's delegations.

**The worked example is the `briefing-desk` template**, which exists for this
and is arranged so the three reasons to pay a subagent's latency are each
visible in one place: a context window the caller does not pay for (a researcher
reads whole pages; what crosses back is its final paragraph), parallelism
(`tools/research_topic.ts` fans every angle out at once, so the caller waits for
the slowest rather than the sum — `allSettled`, because a caller on the phone
would rather hear three angles and an apology than an error), and tools isolated
by capability (`researcher` searches AND browses on six steps, `factChecker`
only searches, on two, on a cheaper model). Compare `web-researcher`, which puts
the search builtins on the agent ITSELF — right for one lookup, wrong the moment
a question has four sides. Two things it states in place because they are how a
subagent disappoints: its instructions END with "your final message is the only
thing the desk receives", and every angle is written as a COMPLETE brief, since
a subagent has not heard the call. This account lives here rather than in
`packages/aai-templates/CLAUDE.md` because that guide is at its 120,000-char
cap; the row there points back.

**Testing it does not mean running a model.** `createScriptedOneShotModel`
(`_fake-llm.ts`) answers a script one entry per `doGenerate`, which is what a
non-streaming tool loop needs; on the SDK side `stubDelegate`
(`@alexkroman1/aai/testing`) fakes the capability itself, routed by subagent
name. Both exist because the alternative — a spec that asserts on a subagent's
steps — is a spec asserting on a provider's choices.

## Driving an agent from text is a published surface

`@alexkroman1/aai-runtime/eval` and `/eval/vitest` are how an agent is measured
rather than merely tested: `openEvalSession` stands up a REAL session — this
runtime, the pipeline transport, the LLM on a live key, the tool executor, `ctx`
and its slots, history trimming, the step budget, the event stream — with the two
speech stages replaced by fakes, and hands back a `say()` that returns the TURN
it provoked.

**It was `aai-evals/session-target.ts` + `fake-speech.ts`, and publishing it is
what the templates forced.** That harness could answer the one question nothing
else in the repo could ("given this utterance, did the agent do the right
thing"), and it could only ever answer it about agents living in this repo. A
user's project — and every template, which IS a user's project — had no way to
ask it at all, and the alternative was each project reimplementing the two
documented harness bugs `eval/fake-speech.ts` and `eval/session.ts` record in
place (a fake TTS that forwards silence turns every case after the greeting into
a barge-in; a `say()` that waits for "a reply" settles on the PREVIOUS one).
`aai-evals` now imports it, so there is one copy of both.

Four decisions worth not relitigating:

- **`say()` returns an `EvalTurn`, not void.** "On that turn" is most of the
  meaning of almost every claim an eval makes, and the run-wide view has a trap
  in it: `agent()` injects a default GREETING, which is a real turn, so
  `said()` already has an entry before a case has spoken. The first draft's own
  unit test caught that.
- **The assertion VOCABULARY is not published, and the READERS are.** `saidIn`,
  `toolCallsIn` and `TURN_ENDS` are facts about an event list; `aai-evals`'
  matcher surface (`calledTool`, `toolOrder`, `saidSomething`, the recording
  runner behind them) is a promise about a NOISY instrument and stays private
  until the variance work in that package's guide exists to measure it with. A
  vitest `expect` over a turn is what a template needs, and it is what a
  template gets.
- **`TURN_ENDS` crossed the boundary with the session**, because the two must
  agree by construction: it is what `say()` waits for AND what partitions a run
  into turns for the assertions. It was written out twice once, and a third
  terminator added to one copy makes `say()` return mid-reply while the
  assertions still think the turn is open — the agent reads as misbehaving.
- **An S2S agent is REFUSED by name.** The vendor owns the whole turn there, so
  there is no text seam to drive, and silently running it as a pipeline agent
  would evaluate a configuration nobody deployed.

### A template eval imports from `/eval` and `/eval/vitest`, and NOWHERE else

The root `@alexkroman1/aai-runtime` barrel drags this runtime's node-reaching
module graph into the template's own TypeScript program — three errors in
runtime files no eval ever calls. So `/eval` re-exports what an eval needs to
name, `RunCodeExecutor` among them, rather than letting a template reach past
it for a type.

That rule used to be written down only inside a JSDoc block copied verbatim into
four template evals, and deduplicating those onto `createVmRunCode` is
what left it with no home. Which is the general hazard in a dedupe: the copies
carry prose as well as code, and the prose is the half a diff does not miss.

### A workflow app is evaluated by RUNNING it

`describeWorkflowEval` / `openEvalWorkflows` are the other half, and they exist
because a `workflowApp()` template — six of the shipped ones — has no session for
`openEvalSession` to open, no microphone and no model in its config. Its whole
product is a durable run, and nothing in the SDK could evaluate one: a page
starts a run over HTTP against a DEPLOYED agent, and a spec drove the exported
steps one at a time. `app.run(def, input)` answers an `EvalWorkflowRun` — status,
output, error, plus what the run NARRATED (`reported`), emitted, and slept.

**The engine is the real client over a real key store.** `eval/workflow-engine.ts`
implements the existing `WdkAdapter` seam in memory and `openEvalWorkflows` hands
it to `createWorkflowClient` over `createMemoryKeyStore()` — so the schema
validation, the def→name mapping, the correlation-key index, the snapshot union
and `lastLine`'s tail-first rule are all production code rather than a fake's
approximation of it.

**It is NOT a durability test, and that sentence is load-bearing.** A
`"use workflow"` body is durable only after the DevKit's builder has transformed
it, and an eval imports it through a test runner with no bundler in the path — so
the body runs as an ordinary async function. No journal, no replay, no
suspension, and a step's `maxRetries` is INERT, which has a measured consequence:
a provider 429 that a deployed run would ride out FAILS an eval run (it happened,
on a sixth live run inside three minutes). `sleep()` is RECORDED rather than
taken, which is what lets a case assert `podcast-digest`'s schedule without
waiting a day. Four `WorkflowClient` methods have no honest answer here and say
so. Do not describe a case written on this as covering replay, resume or retry —
`aai-cli`'s `dev-workflow.scenario.test.ts` is the tier that does.

**Three things a workflow eval CANNOT reach, each costing a real case.**
`createHook()` throws untransformed and — unlike `sleep()`, whose slot the
engine publishes into — offers no seam to fill (`@workflow/core`'s
`create-hook.js` throws unconditionally), so `recap-workflow`'s retention gate,
its headline port of Temporal's `expense`, is unevaluable and its eval says so
rather than asserting around it. `wakeUp` answers `0`, so a "send it now" tool
can only ever report that nothing was waiting. And because `sleep` is recorded
rather than taken, an in-flight run is observable only by HOLDING a provider
response — a `Promise.race` against a durable sleep resolves instantly here, so
a case that wants to see a run mid-flight scripts a slow step instead of
sleeping. A `vi.mock("workflow", …)` factory owned by this package, and an
`openEvalWorkflows({ sleeps: "block" })`, are the two shapes that would close
the first and third; neither is built.

**A workflow app's credential gate is a different question**, hence
`evalWorkflowCredentials`: `requiredProviderEnvVars` returns `[]` for a
`page: "static"` agent, so asked alone it reports every workflow app "ready" and
a keyless run goes live and 401s three layers down inside a step. It reads
`requiredEnv` too, which is the only place a workflow app declares what it needs.

### A keyless run gets a SCRIPTED model, not a skip

`describeEval` (on `/eval/vitest`, which is what pulls the optional `vitest`
peer) resolves one of two modes and ANNOUNCES it on every run:

| | model | what it proves |
| --- | --- | --- |
| credential present | live | the agent's BEHAVIOUR — a noisy measurement (see `packages/aai-evals/CLAUDE.md`: identical code has scored 0.56 and 0.60) |
| none, or `AAI_EVAL_STUB` | scripted (`eval/stub-llm.ts`) | the WIRING — `agent.ts` boots, tools resolve, the session reaches a reply, the eval file drives something |

The third state is the interesting one, because the two obvious states leave a
skipped suite indistinguishable from a BROKEN one. A stub run is deterministic,
free, ~1s, and takes the same code path as a live run below the model — the
descriptor is the only thing swapped, and it goes in through `registerLlmKind`
like any provider. That is what makes it worth gating on, and CI does:
`check.yml`'s integration-and-scenario job runs the template evals with
`AAI_EVAL_STUB=1`, set EXPLICITLY so a key reaching that environment cannot turn
a required check into a paid, flaky one. The live eval tier still gates nothing.

`AAI_REQUIRE_EVAL` is the opposite instruction — a missing credential FAILS
rather than downgrading — for a pipeline that means to measure. A case whose
claim no script can honestly satisfy carries `{ live: true }` and is skipped in
stub mode; anything else carries a `stubReply` chosen so the case still passes,
because a case that fails against its own stub measures nothing.

What the stub gate CATCHES, stated because "wiring" is vague: a template whose
`agent.ts` stopped booting, whose `tools/` stopped resolving, whose provider
config no longer validates, or whose eval file stopped driving a session — every
one of which a suite that skips reports as green. `templates/simple` is the
worked example (`packages/aai-templates/CLAUDE.md`), and the two things that
belong to a template rather than to this harness are there: the unit-tier
exclusion for the `.eval.` infix, and a template reading the ENVIRONMENT for a
credential and never a developer's CLI config.

**A template that ships an eval owes two things**, and both are config whose
absence is silent. Its package's unit-tier `exclude` needs the `.eval.` infix —
`aai-templates`' `include` is `templates/*/*.test.ts`, which MATCHES an eval
file, so without it `pnpm test` drives a live model on every developer's key
under a 5s budget it cannot meet. And a template's eval must read the
ENVIRONMENT for a credential and nothing else: no fallback to
`~/.config/aai/config.json`, which `aai-evals`' own gate has, because a template
ships to users and may not read a developer's CLI config — `aai eval` supplies
the key out of the project's `.env`, which is also why `ASSEMBLYAI_API_KEY` is
declared in `check:eval`'s `env` in `turbo.json` (strict env mode strips an
undeclared variable silently, leaving every case scripted with a key exported
right there in the shell).

**Four seams a case can fill, each one paid for by a template that could not be
evaluated without it.** `runCode` backs the `run_code` builtin, which otherwise
refuses exactly as it does off-platform — correct, and it meant the three tutor
templates' headline feature (the arithmetic the builtin owns) could be asserted
as a CALL and never as an answer. `fetch` keeps a case off the network, because
a scripted `visit_webpage` really visits. `toolTimeoutMs` reaches the session's
per-call deadline, which was unreachable from any caller: a graded retrieval loop
measured at 22-30s against ~10x gateway variance times out at 30s and the case
then measures the deadline instead of the agent. `workflows` supplies
`ctx.workflows`, without which a tool that starts a run cannot execute at all.

**`ctx.generate` answers from the script too**, and that was a hole rather than
a limit: `generateText` calls the fake model's `doGenerate`, which used to
throw, so every tool that reasons with a model — a grader, a planner, a
rewriter, i.e. the central tool of two shipped templates — answered "doGenerate
not implemented" in a scripted run and read as the agent being broken.

Two things in `describeEval`'s SIGNATURE are decided by a linter rather than by
taste, both A/B'd against Biome 2.5 and both invisible until a user's own project
reddens on a file this SDK told them to write: the callback parameter is named
`test` (`noMisplacedAssertion` matches the CALLEE IDENTIFIER, so an `expect`
inside `evalTest(…)` is an error), and a case body takes a DESTRUCTURED context
(`noDoneCallback` reads the first positional parameter of an async test callback
as jest's `done`, so `async (session) => …` is an error where
`async ({ session }) => …` is vitest's own fixture shape). Do not "tidy" either.

## Tool discovery off the platform

`withToolsDir(def, dir)` (`tools-dir.ts`) is the only thing in the repo that
turns a DIRECTORY into a tool registry, and it is here rather than beside
`toolRegistry` in the SDK for the ordinary reason: `node:fs/promises` plus a
dynamic `import()`, and `@alexkroman1/aai` has to stay loadable in a browser.

The gap it closes was real and specific. A tool is registered by EXISTING —
`agent()` refuses a `tools` argument with a type whose text names the file to
create — so somebody has to read the directory, and on the two paths that ship
an agent that somebody is a bundler (the CLI's generated worker entry; a spec's
`import.meta.glob`). A plain Node process serving `agent.ts` has neither, which
made the SDK's central idiom UNREACHABLE on exactly the path with the fewest
moving parts: `examples/self-hosted-server` shipped a README promising "adding a
tool is adding a FILE" beside code that could not do it, and the only way to
give that agent a tool was the hand-written `name → import` map the type error
exists to prevent.

**It adds a source, never a second set of rules.** The name grammar, the
co-located-spec skip, the nested-file error, the default-export checks and the
collision message stay in `toolRegistry`, and the attach stays in `withTools`;
this reads a directory and calls them. `sdk/tool-registry.ts`'s module doc is
the statement of that invariant — every source arrives as `path → module`, which
is what stops a second builder from growing a second behaviour.

Two mechanics worth not rediscovering. The module keys are relative to the
directory scanned, because `toolRegistry` derives a name from the segment after
the last `tools/` and an absolute key under a directory NOT literally named
`tools` reads as a nested file — the right diagnostic for the wrong reason. And
the scan is recursive so a file one directory deep reaches that nested-file
error instead of being silently absent, which is the failure the whole mechanism
replaces. A MISSING directory throws for the same reason.

## Rendering this package is a docs decision, and it cannot be half-made

There is no `typedoc.json` here, and the absence is measured rather than an
oversight: a package-local config alone turns the docs gate red, and the answer
today is no. **[`docs/CLAUDE.md`](../../docs/CLAUDE.md), "Rendering
`aai-runtime` is a docs decision"** has the five files one change must touch
together, what a real render measured, and what would change the answer.

## A run's journal has THREE homes, and the order between them is a decision

`selectJournal` (`workflow-runtime.ts`) picks the replay engine's journal:
**platform, then postgres, then memory**, and the boot line names whichever won.

- **platform** — `createPlatformJournal`, one `POST /:slug/workflow-journal` per
  operation, beside the queue, session state and upload records that already work
  this way. The statements run on the platform's own database
  (`aai-server/platform-workflow-journal.ts`), which mirrors
  `workflow-journal-schema.ts` with a `slug` added to every key.
- **postgres** — `createPostgresJournal` over the agent's own `DATABASE_URL`,
  which is what a self-hosted deployment has and the platform never provisions.
- **memory** — a `Map`, for trying a workflow out before provisioning anything.

**The order is what closed the bug, and it is not "most specific wins".** A
deployed guest could reach NEITHER durable backend: the platform provisions no
tenant database, so every deployed run journaled into a sandbox that self-exits
after `AGENT_IDLE_EXIT_MS`. A step's result, its attempt count and an open
approval window died with it — and nothing reported it, because from inside the
system a step whose result was lost is indistinguishable from one never reached.
The run sat suspended looking healthy, so "durable" was true of the interface and
false of every deployment.

Platform BEFORE postgres for a second reason: a deployed guest may also carry an
author-supplied `DATABASE_URL`, and its runs belong beside its session state
rather than split across two databases with the wake sweep able to see only one
of them.

**The platform pair is read from THIS PROCESS's environment**
(`platformGuestOptions`), never the agent's — the distinction that already cost
a deployment, and the safer read besides: an agent may set any `AAI_*` key as a
secret, so under the tenant spelling an agent would choose the base URL and
bearer its own journal was sent to. The section below on `AAI_PLATFORM_BASE_URL`
carries the rest.

**Memory is last and the boot line SAYS so.** A durability tradeoff absent from
the log reads as a bug, and this is the one an author is most likely to hit by
accident.

### The journal's test topology and its decided contract points

Three things that are REFERENCE rather than rules to keep resident, and they are
in **[`JOURNAL-CLAUDE.md`](JOURNAL-CLAUDE.md)** beside this file: what each of
the four tiers of journal test can see and why none substitutes for another; why
the FOURTH conformance arm (the platform's own SQL, over a real route and a real
Postgres) lives in `aai-server` and the shipped bug it caught; and the three
`JournalStore` contract points the suite refused to decide — `setStatus`'s
ADDITIVE patch, the four methods left under-specified for a run that does not
exist, and `readSteps`'s tie order. Read that file when you are changing a
backend or the conformance table; nothing in it is needed to work elsewhere in
this package.

### A journal read is a round trip, and four shapes issued it N times

**The ~840 ms is DECOMPOSABLE now, and was a total for as long as it was
quoted.** Every RPC carries a W3C `traceparent` (`_trace-context.ts`) and logs
its own elapsed at debug; `aai-server`'s `withReserved` logs `waitedMs` and
`workMs` under the same id. So `elapsed - (waited + work)` is the hop, and
"was it our pool" is answerable from two log lines rather than from a guess —
which matters because `ADMIN_POOL_MAX` had already been widened once on the
assumption that it was. One span per CALL: a run's whole walk is not one trace,
which would need the trace minted at the delivery and carried through
`workflow-run-context.ts`.

Every platform-arm `JournalStore` call is one `POST /:slug/workflow-journal`,
measured at **~840 ms of server time**, on a route holding one of
`ADMIN_POOL_MAX` connections for the whole request — so these are the pool a
run's own WRITES queue behind. `use-transcript-workflow` sustained ~2 a second
on ONE run: a fan-out's `settledSince` re-reads the WHOLE journal once per step,
the overlapping walks above each do it again, and a delivery's opening was three
SEQUENTIAL round trips, then two, and is now ONE.

`_journal-shared-reads.ts` collapses the first two — `getRun`, `readSteps` and
`readSleeps` being the reads that are pure functions of a run id — and its
module doc carries the argument. The one thing to know first: it is a
**COALESCER, not a cache**, so a caller arriving mid-flight gets a TRAILING read
and none is answered from a read that started before it asked. `settledSince`
exists to rely on exactly that; a cache would silently defeat it.
`ReplayOptions.steps` is the third — the step read is issued BESIDE the
`running` compare-and-set — and `ADMIN_POOL_MAX` was widened with them (the
admin pool note under "Stateless server", `packages/aai-server/CLAUDE.md`).

**The record read joined them, and `setStatus`'s `expect` is what made that
possible.** `execute` opened with `await journal.getRun(runId)` and only then
issued the rest, so a delivery cost two round trips before a body could run;
folding the read in leaves one, nothing in the opening depending on the record.
Two things are load-bearing, both argued at the call site: a run this delivery
may not walk answers `false` rather than moving, so an eager set can neither
resurrect a terminal run nor undo an `abandon`; and a LOST eager set is
**re-asked, never believed** — issued beside the record read it can reach the
store ahead of a racing `start`'s `createRun` and decline a run that is alive,
which `workflow-concurrent-delivery.test.ts` shrinks to a step the body needed
and nothing ever ran. `workflow-engine-opening.test.ts` states both. The
speedup also moved where a cancel lands, which is why law 1 relaxes its
per-name floor for a cancelled run and `cancelsMidWalk`'s floor was
re-measured.

The FOURTH is a WAIT, and it was the worst of them because it grew with the
number of DELIVERIES rather than with the body: a settled step was answered from
the walk's snapshot and every elapsed `ctx.sleep` was still a `claimSleep` round
trip, so a polling run's traffic was quadratic. `JournalStore.readSleeps` and
[`JOURNAL-CLAUDE.md`](JOURNAL-CLAUDE.md), "A wait was outside the whole-read
guarantee", carry the measurement and the rule for using the snapshot.

### An attempt is a LEASE, and it EXPIRES

`claimAttempt` charges an attempt before a step's body runs — a crash therefore
burns it, which is the whole reason the charge precedes the body — and the
number it answers is **how many attempts are outstanding right now**, not how
many times the step has been tried.

Two things about it are worth knowing before touching the engine, and the whole
account is in [`JOURNAL-CLAUDE.md`](JOURNAL-CLAUDE.md), "An attempt is a LEASE,
and it EXPIRES": a charge names its HOLDER, so a re-claim by the walk that has
one answers the same number; and a charge older than `ATTEMPT_LEASE_MS` does not
count, which is what stopped a dead walk's charge standing forever and refusing
a healthy step for the life of the run.

### A clock, a random number and a uuid are AFFORDANCES

`ctx.now()`, `ctx.random()` and `ctx.uuid()` journal what they read — one value
per reach, keyed `now!0` / `random!0` / `uuid!0` in a POSITIONAL space of their
own, appended through `appendStep` so no `JournalStore` method was added and every
backend carries them already. They are the shape two shipped templates were
hand-rolling (`transcription-workflow`'s `startClock`, `call-audit`'s two `now`
reads), and `guard-invariants` rule 30 stays the lexical backstop with its remedy
naming them.

**`workflow-replay-determinism.ts`'s module doc is the argument**, and the three
decisions it records are the ones not to relitigate: their own key space (per
KIND, so inserting one shifts no other); NO attempt lease (a lease bounds
abandonment and these have no body to abandon); and one float per `random()` call
rather than a seeded sequence. A fourth thing it settles is why they RECORD a
divergence reach and never raise one — an unrecorded reach fails the next step on
a healthy resume, and raising is unsound without `claimAttempt`'s corroboration.

**Inside a `ctx.step` they are REFUSED**, by the same `currentRun()?.step` test
and for the same key-shift reason as the section below.

### A wait is keyed by NAME, and `ctx.sleep` takes a label for it

`ctx.sleep(label, until, options?)` and `ctx.waitFor(token, options?)` journal
their waits as `sleep!<label>#<occurrence>` and `hook!<token>#<occurrence>` —
name plus occurrence, exactly like `ctx.step`. The occurrence counters are PER
NAME, so a loop is one label and N rows, and inserting a wait shifts nothing.

They were two bare ordinals, and then a body reaching a different NUMBER of waits
read its predecessor's record. Two shapes, both legal code with no author mistake
in them beyond a condition:

```ts no-check
if (somethingAboutTheClock) await ctx.sleep("early", 1000);
await ctx.sleep("schedule", WEEK_MS); // sleep!1 on walk 1, sleep!0 on walk 2
```

Positionally, walk 2 read the elapsed `early` record and the week-long wait
resolved instantly, reporting `completed` with the clock unmoved. The hook
version is worse: the body is handed the other wait's PAYLOAD.
`workflow-replay-wait.test.ts`'s "a body that reaches a different NUMBER of
waits" pins all three cases and A/Bs green against positional keys.

Three things not to relitigate:

- **`label` is REQUIRED, and `Literal<Label>` types it.** The same constraint
  `ctx.step`'s name carries, for the same reason — an identity computed at run
  time is the hazard the whole scheme exists to remove. It was a breaking
  signature change, taken while there are no external consumers.
- **`correlationId` is NOT defaulted from `label`.** They answer different
  questions: `label` decides which journal ROW this wait is, `correlationId`
  decides which waits one `wakeUp` ends. A polled schedule wants one label and one
  id across every iteration; two independent waits want two labels and may
  want a shared id.
- **The three determinism reads stay positional** (`now!0`, `random!0`,
  `uuid!0`). They take no argument to name, and they journal through `appendStep`
  so a reach is at least recorded for the divergence check. `sdk/workflow-ctx.ts`
  carries why requiring a literal there is the worse trade.

What is left is one shape, and it is strictly better than what it replaced: a
label or token that is ITSELF non-deterministic mints a key no walk has reached,
so the run registers a fresh wait and PARKS on something nobody can signal. That
hangs rather than answering wrongly, and nothing detects it —
`workflow-replay-divergence.ts` states the residual and why the NEW-key report
that would catch it is not built. `waitTokenDiverged` there is the nearest thing:
it compares the token `claimHook` hands back against the one the walk reached, so
it is an assertion about the KEY SCHEME (unreachable while a key names its token)
rather than about the body, and it is what caught the positional case.

### A step body may not WAIT, and the engine refuses one that does

`ctx.sleep` and `ctx.waitFor` belong to the body. The closure `ctx.step` is
handed CAPTURES `ctx`, though, so `ctx.step("napper", () => ctx.sleep("nap",
2000))` is one line away at every call site, and until `workflow-replay-wait.ts`
existed the engine ran it — silently, and wrongly in three separate ways. Two of
them are measured below and both still stand; the third was the key slide, which
naming the waits closed independently (see "A wait is keyed by NAME").

- **The step body re-ran from the top on every delivery.** The suspend unwinds
  out of the step, the attempt charge is released (correct — a suspend settles
  nothing), so the step is never journaled and the next delivery re-runs the
  closure. A one-step body logged its effect **twice** across two deliveries and
  reported `completed`. For a step that calls a paid provider that is a duplicate
  charge, which is how this was found.
- **And every LATER wait in the run READ the wrong record.** That half is CLOSED,
  and not by this check — see "A wait is keyed by NAME" above, which carries the
  transcript. It is listed here because it was one of three reasons for the
  refusal rather than the whole of it, and because `workflow-replay-wait.ts`'s
  own doc is still the clearest statement of what positional keys cost.

So both methods now refuse when `currentRun()?.step` is set — which is true for
the whole of a step's execution, including inside every helper it awaits, since
`withStepContext` narrows the run context rather than a lexical scope. The
refusal is a `FatalError` (a redelivery cannot make a body legal) recorded
through `replayRun`'s `refused`, so a body that catches broadly cannot turn it
into `completed` — the third verdict on that channel, beside a divergence and an
abandoned step.

**It cannot be a TYPE**, and it is not worth making RESUMABLE either;
`workflow-replay-wait.ts`'s module doc argues both (a captured binding is not an
argument, and TypeScript has no effect system; "work, then wait, then more work"
is already two steps with the wait between them).

**What the refusal cost, recorded because it is a real loss.** The property
grammar's `nestedWait` node (`_workflow-resume-program.ts`) generated exactly
this shape and was the 10-out-of-10 regression for the lease fix above. It is
gone: it can no longer generate a legal body. The arm it defended — a suspend
GIVING BACK its charge — is gone too, and needs no replacement: a suspension is
no longer a THROW, so nothing unwinds through a step's attempt loop and there is
no charge to hand back (`workflow-replay-suspend.ts`). The half of the lease
still reachable through `ctx` — a charge NOT given back when an attempt dies —
is held by `flaky`. Removing the node also lowered two coverage floors in
`workflow-resume-equivalence.test.ts`, re-measured over 20 runs with the old
ranges kept beside the new ones.

**And the refusal now guards LIVENESS as well.** A wait parks on a promise that
never settles and quiescence means "no engine operation in flight", so a wait
inside a step is a step awaiting something that cannot settle, holding the walk
open against the check that would suspend it — `replayRun` would never return.
A/B'd: with the check disabled, all eight cases in `workflow-replay-wait.test.ts`
stop failing and start timing OUT. That module's own doc carries it.

**That residual is REACHABLE, and the estimate beside it was measured wrong.**
It read "far past what one dispatcher per deployment produces". One dispatcher
produces up to FIVE, whenever a single step exceeds 60 seconds: the platform's
`QUEUE_DELIVERY_TIMEOUT_MS` (60s, `aai-server/workflow-queue-deliver.ts`) closes
the delivery's HTTP response but does **not** stop the walk, so every redelivery
adds a CONCURRENT walk of the same run in the same guest — measured at 61.15s
then 65.23s against a live dev server, i.e. the ceiling plus
`RETRY_BACKOFF_MS[0..1]`. Each of those walks charges the same step key, so a
step running longer than roughly 2.2 minutes takes a fourth charge against a
budget of three and is REFUSED. A slow-but-healthy step is exactly the case the
lease was supposed to protect.

Worse, the duplicate walks were not merely wasteful: `replayRun` reads the
journal ONCE per walk, so a walk that starts before an earlier one has journaled
anything re-executed **every** step. Measured on the transcription template, a
second walk re-ran `normalizeRecording`, `splitRecording`, four
`transcribeSegment` calls against the real provider and `mergeTranscript` on a
run already marked `completed`.

**That half is CLOSED, by `settledSince` in `workflow-replay-step.ts`.** A
snapshot can only be stale about a key somebody ELSE reached, and `claimAttempt`
already answers exactly that: `1` means this attempt is the only one
outstanding, so nothing has been missed. So a miss in the snapshot re-reads the
journal **only when the charge says another walk touched this key**, and a
settled entry answers the step instead of running it — which also makes a
settled step answer from the journal rather than take the `StepAbandonedError`
the blown budget above would otherwise produce (the two checks are ordered on
that ground). The happy path pays nothing: a first walk reaching a fresh step
sees `1` and never re-reads. `workflow-concurrent-delivery.test.ts` measured the
effect — generated `duplicateSteps` fell from **44-107 to 6-21**, and its floor
came down with a re-measured range — and
`workflow-replay-stale-snapshot.test.ts` pins the two interleavings by hand.

What is NOT closed is the race it was never about: two walks reaching a step
NEITHER has settled still both run it, which is the engine's stated
at-least-once cost, and the delivery door still starts walks it cannot stop. Both
want a heartbeat on the RUN so a ceiling cannot abandon a walk that is alive.
The platform's own half — a slow delivery starving every OTHER tenant's claim —
is fixed separately in `aai-server/workflow-queue-budget.ts`.

### A run record names the CODE it was started against

`RunRecord.codeVersion` is `AAI_BUNDLE_SHA256`, recorded at `start` and compared
at each walk, and it exists for one reader: the divergence message. That message
states two causes — a redeploy mid-flight, or a non-deterministic body — and then
hands the reader a test to run against their own source, because a journal holds
what a value WAS and never how it was produced. The version settles half of it:
an inequality states the redeploy and names both bundles, an equality ELIMINATES
it. The fork stays in the text either way, being what says what to look for.

**A DIAGNOSTIC, never a gate**, and read from THIS PROCESS's environment rather
than the agent's — an agent may set any other `AAI_*` key as a secret, so a
tenant read would let it pin its own version and have the message assert as a
fact the one cause it had ruled out. Absence therefore means UNKNOWN in both
directions and may never read as "unchanged"; only a deployed guest has a hash.
`workflow-code-version.ts` carries the rest, including why an inequality does not
refuse the run.

### A failure of the JOURNAL is not a failure of the RUN

`replayRun` propagates a store failure rather than marking a run failed on a
database blip — and that was true only of `readSteps` until
`workflow-replay-journal-failure.ts` existed. **The account, its one
`JournalConflictError` exemption, and the two blind test arms it found are in
[`JOURNAL-CLAUDE.md`](JOURNAL-CLAUDE.md)**; that module carries the argument.
This guide is at its cap.

### A step body can read its own ATTEMPT

`stepInfo()` on `@alexkroman1/aai/step` answers
`{ name, key, attempt, maxAttempts, isLastAttempt }` inside a step and
`undefined` everywhere else. The engine already tracked the number and nothing
could read it, so the one decision a retry policy cannot make for an author was
unavailable: degrade rather than fail. **`sdk/step-attempt.ts` carries the
argument** — the two differences from the DevKit's `getStepMetadata()`, and why
`maxAttempts` has to travel with the attempt rather than be restated at the body.

What is this package's: `installWorkflowSupport` publishes the reader
(`createStepInfoReader` in `workflow-report.ts`) into a `Symbol.for` slot like
`report()`'s, because the answer lives in this package's `AsyncLocalStorage` and
`/step` rides the browser bundle. It derives `isLastAttempt` with `>=` and not
`===`, since a burned boot can push the count past the ceiling and that is
exactly the try a body most wants to degrade on. And the EVAL engine fills the
slot with a first-and-only attempt rather than leaving it empty — unfilled means
`undefined`, which a body reads as "no run", so a step that degrades on its last
attempt would be measured on that branch.

### A step entry records when it STARTED

`StepEntry.startedAt`, so `finishedAt - startedAt` is what the step cost. An
entry carried `attempts` and `finishedAt` and no start, so the only elapsed time
derivable from a run's history was the gap between one step's finish and the
next's — which is the previous step's cost PLUS whatever the body did between
them, and is nothing at all for the first step of a run or the first after a
wait. The park-curve section below is the evidence: its production numbers
(`walkingForSeconds: 285`, "~45 behind it at 12 a minute") came off a log line,
because the journal could not be asked.

An absolute instant rather than a duration — the difference is derivable and the
instant is not, and a gap between one entry's `finishedAt` and the next's
`startedAt` is DELIVERY latency, a different question from step cost and the one
that tells a slow step from a slow queue. It spans the whole reach, retries and
backoff included, and excludes time queued behind `StepGate`; the field's own doc
argues both.

**OPTIONAL, and absence means the row predates the column.** The journal is
append-only over tables that already hold rows, so a reader owes an absent start
"unknown" and never zero — which would report a long step as instant. The
conformance table pins that in both directions, including that a start of `0` is
KEPT: an arm reading `startedAt ?? undefined` would satisfy the absence case
while silently dropping a real value.

**No reader surfaces it yet**, and that is worth saying rather than implying: the
public workflow API carries a run SNAPSHOT and no step history, so this is
queryable from the database and from nowhere else. A route and a CLI verb over
`readSteps` are the obvious next move and are not built.

Two things the change found, both about the DDL-parity gate. It read the ONE
migration that CREATES these tables, so a column added by a later one was
uncompared — which made it blind to exactly the drift it exists to catch, and
had already hidden `workflow_runs.reconciled_at` plus two reconcile indexes. It
reads every migration in filename order now, applies `alter table … add column`
on both sides, and scopes the parse to the five tables the pairing derives. And
its column-ORDER assertion had to go: a column added by an `alter` lands last, so
the two sides diverge in position the moment either adds one. Sets are compared
instead; every claim that matters is asserted by name.

### A parked delivery asks to come back PROPORTIONATELY

`workflow-queue-dispatch.ts` refuses a delivery whose run is already being
walked, and `workflow-queue-park.ts` decides what to answer it:
`clamp(walkingForSeconds / 8, 5, 120)`, reported on the same curve — one park is
one line and one reschedule, so `reportPark` ANSWERS the delay it printed rather
than either half computing it twice.

It was a flat 5, argued as "self-limiting by construction" because the first park
lands ~61s into a walk and a healthy run parks zero times. True, and the
conclusion was not: after that it is a 5s LOOP, and each turn is a full queue
round trip doing no work plus one of the replica's
`WORKFLOW_QUEUE_DELIVER_CONCURRENCY` slots. Production, on a 660 MiB upload:
`walkingForSeconds: 285` with ~45 behind it at 12 a minute; ~170 for a 15-minute
one. The curve makes the count logarithmic — **13 to reach 285s, 24 to reach
900s**.

Three things not to relitigate, each argued at its own constant: the floor stays
5 for a brief RACE between two deliveries (it binds only under 40s of walk); the
ceiling is 120s against the four numbers it must stay under
(`QUEUE_DELIVERY_TIMEOUT_MS`, `RETRY_BACKOFF_MS`'s longest, `STALL_GRACE_MS`,
`TRANSCRIBE_UPLOAD_TIMEOUT_MS`); and the LEVEL is a pure function of the elapsed
walk rather than "the first one is different", which needs per-run state and
hides the falling rate that says nothing new is wrong.

**A park spends no attempt and the platform caps nothing** — `reschedule` writes
`locked_at` and `available_at` only, and `parkedFor` takes any finite
non-negative number. So only the first delivery's 60s abort costs one of
`QUEUE_MAX_ATTEMPTS`, and a walk of any length parks at attempt 1 forever.

**The GUEST's liveness signal is a separate defect with the same cause**, and it
is the sharper one: `packages/aai-guest/CLAUDE.md` under "Lifecycle is
guest-owned" — the idle reaper counted HTTP responses, so the 60s abort read as
an idle guest and a step longer than the idle window never completed. Parking is
what made that reachable, because before it the redundant walks were the thing
holding the guest open.

## An upload's bytes are OBJECTS, and its record has two homes

**An upload ID is checked at the ROUTER, for every `/uploads/:id` route.** The
grammar check (`UPLOAD_TOKEN_RE`, 1-64 of `[A-Za-z0-9_-]`) used to sit inside the
two writes that take a caller-chosen id, so the other three handed a bad id to the
store — where `assertUploadToken` throws a plain `Error`, `sendUploadFailure` can
only classify the store's five typed failures, and the router's catch turned a
plainly bad request into `500 Internal server error` with the reason in the log
and nowhere else. One class of mistake, two statuses: `POST …/not..valid/parts`
answered 400 and named the grammar, `GET …/not..valid/info` answered 500. It is
`uploadIdOr400` (`workflow-api-uploads.ts`) for all five now, which also keeps the
grammar a BOUNDARY — an id that would escape the store never reaches one, whichever
verb asked. A well-formed id nothing stored is still a 404: "malformed" and
"reclaimed" are different answers and a client acts differently on each.

One store (`_upload-store-blobs.ts`) over two interfaces — `UploadRecords`
for the record, `UploadBlobs` for one object per `UPLOAD_PART_BYTES` window — and
it names neither's home. It used to hold the bytes itself, a `bytea` row per
megabyte or a file per upload under `aai dev`, and **`_upload-blobs.ts`
carries the four costs that got them out of Postgres** — storage price, WAL and
backup amplification, the app's own queries sharing their pool, and the
platform's forward reading a slow drain as a dead guest.

**The pairing follows the WORLD, off the same `DATABASE_URL`: an upload must
be at least as durable as the runs that read it.** With a database the record
goes in it and the bytes need a bucket — no bucket is the ONE refusal left,
since those runs outlive this container and a directory here cannot serve one
resuming elsewhere. With none the world is LOCAL, so both go in its data
directory (`_upload-files.ts`): per-process in a guest, the project's
`.workflow-data` under `aai dev`, where a restart re-enqueues the runs it finds
and finds their uploads. Same shape as the deleted file backend, opposite of
its bug — which was pairing a directory with runs in POSTGRES — and it is what
gives a databaseless studio agent uploads at all. `installWorkflowSupport`
ANNOUNCES the local home once: a tradeoff absent from the log reads as a bug.

**A FINISHED upload is immutable, at both layers.** A part write is keyed by its
OFFSET and the merge replaces whatever window was there, so
`PUT …/parts?offset=` against a completed upload used to answer 200 and rewrite
the bytes under it — `size` and `complete` unchanged, so a step reading that
window had nothing to notice; a SHORTER replacement collapsed `size` and flipped
`complete` back to `false`; a LONGER one recorded two overlapping windows, after
which a `read` of two megabytes returned three. Upload ids are the caller's to
choose and the workflow API is unauthenticated unless `AAI_WORKFLOW_API_TOKEN`
is set, so none of it needed a credential. `UploadCompleteError` (409) is the
refusal, `assertUploadOpen` is the check, and two things about it are decisions:
the KIND refusal is checked FIRST (a finished streamed upload keeps its 400 "not
a parts upload" rather than changing status when its body ends), and a re-sent
CLAIM naming only windows the record already holds at the same lengths is a
NO-OP rather than a 409 — a claim is re-sent on a dropped response, so the
request that COMPLETED an upload is exactly the one whose answer can be lost,
and 409 is in neither `RETRYABLE_STATUS` nor the resume vocabulary. The BYTE
route refuses in parallel and independently
(`aai-server/upload-handler.ts`'s `assertUploadOpen`): a rewrite there changes
no record at all, so the store's refusal cannot see it.

**A STREAMED upload's first windows are CUT SMALL**, and that is a progress fix
rather than tuning. Nothing in a window is readable — and therefore nothing is
published as `size` — until the whole window is stored, so at a flat
`UPLOAD_PART_BYTES` a stream under 8 MiB reported `size: 0` for its entire life
and then the whole file at once. `size` was honest throughout (it is the
contiguous READABLE prefix), which is why the fix is the CUT and not the number:
a `size` counting bytes that merely arrived would send a reader to a window that
is not there. `windows(body, limit, grow)` doubles from `UPLOAD_CHUNK_BYTES` to
`UPLOAD_PART_BYTES` — 1, 2, 4, 8, 8, … MiB — so a maximal upload gains three
windows and `platform-uploads.ts`'s O(N²) `parts` tripwire is untouched, where a
flat 1 MiB cut would have been eight times the windows. `grow` is exactly
`publish`: only a published window's arrival is observable, and only a published
cut may be non-uniform, because `create` derives its boundary list from
`windowList`, which assumes the grid.

**Neither direction takes turns with the socket.** A whole-file write puts
`UPLOAD_WINDOW_CONCURRENCY` windows while the next one is still arriving, and the
byte route reads `UPLOAD_READ_AHEAD` chunks ahead of what it has written — both
`mapStream` (below), which is where the ordering, the memory bound, and the
whole-window buffering that keeps a failed write re-sendable are argued.

## Every call this runtime makes of its OWN goes through a POOL, and there are two

`_egress-fetch.ts` holds both: `rpcFetch` for a platform route (a kilobyte of
JSON, one per step transition) and `blobFetch` for a window's bytes. They were
one pool, so a claim's 32 concurrent probes competed for the sockets a journal
write queued behind — and one `allowH2` answer served both, though the
measurement behind it is about multi-megabyte bodies exhausting a flow-control
window and a kilobyte cannot exhaust one. Both still default to HTTP/1.1;
`AAI_EGRESS_RPC_HTTP2` is a switch on the pool where the answer is unmeasured,
and the byte pool deliberately has none. `_egress-pool.ts` builds them, and
`step-fetch.ts` takes a third. **`globalThis.fetch` is banned here by
`guard-invariants` rule 29**, whose remedy carries the argument.

`sdk/step-fetch.ts` measured the problem and fixed it for a STEP's outbound call:
undici 8 — the copy backing `globalThis.fetch` from Node 26 — defaults `allowH2`
to `true`, so N concurrent requests to one origin are multiplexed onto ONE TCP
connection sharing one flow-control window, and a capacity limit then arrives as
a stream reset carrying no HTTP status. 14 of 16 concurrent 17.66 MB requests
landed on the global against 16/16 on HTTP/1.1.

**What that left behind is that the RUNTIME's own calls are the same shape**, and
five of them were still on the global: the upload broker's byte operations
(`_upload-blobs-brokered.ts`), the operator-bucket ones beside them
(`_upload-blobs-http.ts`), every platform RPC (`platform-rpc.ts`), and the
run-event STREAM read in the DevKit-era `workflow-platform-storage.ts` — which
was the worst case of all, a read meant to stay open on the same window as a
burst of byte probes. That module is gone with the DevKit's storage RPC; the
rule it motivated is not, and `platform-rpc.ts` is what every journal, queue,
session-state and upload-record call goes through now.

Observed on a deployed transcription workflow uploading ~64 MB in 8 MB windows:

```text
Workflow run event read failed { runId: 'wrun_…', error: 'fetch failed', failures: 2 }
Workflow API request failed { error: 'fetch failed' }
PUT …/workflows/uploads/<id>/parts -> 500 Internal Server Error (execution: 37.9 s)
```

Three things in that log are ONE fault, which is the tell. The failures are
simultaneous across UNRELATED routes — a claim's bucket probes and the event
stream's storage reads — because those requests shared a connection. The error is
`fetch failed` with no status, which is what a reset looks like from `fetch`. And
`BYTE_OP_ATTEMPTS`' ~750 ms of retry could not help, because re-issuing in
lockstep onto the connection that just reset IS the failure rather than the cure.

Four things about the pool worth not rediscovering:

- **It is per PROCESS, where the step pool is per `AgentServer`.** That pool is
  rebuilt on every `aai dev` file save; this one is addressed by the process's own
  environment and serves callers with no server to hang a lifetime off —
  `platformPost` is reached from four clients holding nothing but a base and a
  bearer. So it is a lazy singleton, and `closeEgressFetch()` RESETS it rather
  than poisoning it: a caller holding `egressFetch` across a close gets a fresh
  pool on its next request.
- **undici's timeouts are LEFT ALONE at their 300s defaults, which are TIGHTER
  than the step pool's.** Here the callers bound the REQUEST
  (`BYTE_OP_TIMEOUT_MS`, `PlatformCall.timeoutMs`) and nothing bounds draining
  the body afterwards — exactly what a window `read` does — so undici's
  body-inactivity timeout is the only limit that path has. The step pool RAISES
  both to `STEP_FETCH_INACTIVITY_MS` (10 min) because a step's body can be
  gigabytes; it had them OFF, on an argument half of which ("or the DevKit's step
  budget") was retired with the DevKit, so a user-written `stepFetch` passing no
  signal was bounded by no layer at all. Both undici timers are
  inactivity/phase timers rather than total-duration ones, which is what lets one
  number serve a JSON call and a 660 MiB upload alike — the constant carries the
  undici mechanics and the arithmetic.
- **The `fetch?:` seam stays optional.** Only the DEFAULT was the bug, and making
  it required is a breaking change: `createHttpUploadBlobs` is a published export
  a self-hoster calls.
- **Bodies must be plain.** This goes through `pinnedFetch`, so `host/_undici.ts`'s
  rule applies — a `FormData`, `Blob`, `Headers` or `Request` from the GLOBAL
  undici brand-checks against the wrong classes and is silently stringified. Every
  caller here passes a `Uint8Array` or a string, which is what made the swap safe.
  `providers/_openai-stream-repair.ts` is the rule's one baselined occurrence for
  the mirror-image reason, recorded at the line.

### A transport failure is a 503, and it used to be an opaque 500

The amplification half, and its own bug. `fetch` rejecting with
`TypeError: fetch failed` reached the router as an unnamed rejection, so
`answerHandlerFailure` answered `500 { error: "Internal server error" }` with no
`Retry-After` — six times on one claim, ~40 s each, the browser re-sending 8 MB
windows it had already stored into the same fault. `workflowApiErrorStatus` had
a table entry for a full disk (507) and a saturated pool (503) and none for the
hop OUT, which is the same finding those two entries record: a client cannot
back off on a 500, an operator cannot triage it, and a load balancer cannot shed
on it.

`isTransportFailure` (`workflow-api-http.ts`) walks the `cause` chain — the code
is almost never on the value that was thrown — against a closed vocabulary, and
answers 503 with `Retry-After: 1`. Three properties are decisions:

- **`ENOTFOUND` is deliberately absent.** A hostname that does not resolve is a
  misconfiguration, and "retry shortly" hides a permanent fault behind a client's
  loop forever. `EAI_AGAIN`, the temporary DNS failure, is in for the mirror
  reason.
- **It is checked LAST of the 5xx entries.** A full disk and an exhausted pool
  both surface transport-shaped codes on their way out, and each has advice this
  one cannot give.
- **It is not `isCallerGone`**, which reads `ECONNRESET` off the TOP-level value
  and is checked first. An inbound socket that closed must not get a 503 written
  to it.

## A deployed guest has TWO copies of this package

The harness bundles its own `aai-runtime` and calls `createServer` from it; the
agent's runtime is built by the BUNDLE's `__aaiCreateRuntime`, so a deployed
agent runs the SDK version it was tested against
(`packages/aai-guest/CLAUDE.md`, "User-shipped runtime"). Both are loaded in one
process, and **anything this package uses to rendezvous between them has to be
keyed on `globalThis`, not on a module-level value.**

The instance that got this wrong was the workflow run context, and its own doc
had already stated the failure — "two stores would each see only their own
`run()` calls, so a `report()` reaching the wrong one would silently find no
context and degrade to log-only" — while taking a module-level
`new AsyncLocalStorage()`, which is one store per COPY rather than one per
process. So the reporter `installWorkflowSupport` published belonged to the
harness's copy and the run context belonged to the bundle's:

```text
Workflow: Transcribing 45:00–46:32. {}
```

The empty context object is the whole symptom, and it reads as cosmetic. It is
not: the same lookup decides whether a narration line is STREAMED, so a
fifty-minute transcription reported no progress to a watching page at all, and
the attempt suffix that tells a reader a fan-out is retrying could never appear.
Every other signal was healthy, the log line being unconditional.

**It survived the DevKit because the arms this replaced resolved once.**
`getStepMetadata` and `getWritable` came from the `workflow` package, which the
guest image resolved from its own `node_modules` and both copies shared.
Removing those arms made the store's own warning come true — which is the
general shape of this whole removal: a seam the DevKit's world covered, inherited
without being enumerated.

The store is `Symbol.for`-keyed now, the same mechanism the step reporter slot
one module over already used, and for the same reason. **`vi.resetModules()` is
a second copy**, which is what makes this testable in one process —
`workflow-run-context.test.ts` loads two and asserts a context entered through
one is visible through the other. A/B'd: both cross-copy cases fail against the
module-level form.

## A callback URL comes from `publicWebhookUrl`, and the route is on `createServer`

`ctx.workflows.publicWebhookUrl(token)` mints the one workflow URL that LEAVES
the system — `RuntimeOptions.publicUrl` plus `WORKFLOW_WEBHOOK_PREFIX`, the same
constant the router parses, so the URL handed out and the path that answers it
cannot drift. It exists because the DevKit's own `hook.url` was **guest-local**:
composed from `getWorkflowMetadata().url`, i.e. `http://localhost:<port>` off
the running process, which names the inside of a sandbox that has self-exited by
the time a payment provider calls back.

**The route is mounted in `createServer`, and that is a correction rather than a
detail.** It used to be mounted by `createWorkflowSurface`, which returns early
unless the bundle carries both `workflowCode` and `stepCode` — the DevKit
transform's output. When the replay engine replaced the DevKit those strings
stopped being produced and the route mounted on NO door, so every callback a
deployed run had handed out answered 404 permanently.

Nothing in the system could see that. A run waiting on a hook that never arrives
is indistinguishable from a payer who never paid, so it reports as healthily
suspended and the failure lands weeks later on somebody else's server, on a URL
nobody can re-issue. Two properties keep it closed:

- **It hangs off `createServer`**, which every front door goes through — `aai
  dev`, a self-hosted `server.mjs`, a deployed guest — so it cannot come to
  depend on a build artifact again.
- **It reads `runtime.workflows` through a LAZY getter**, like the workflow API
  beside it, because the guest builds its runtime on the first request that
  needs one; a captured value is `undefined` for the life of the server.

`WorkflowClient.signal` is the delivery, and a `false` from it is a **404, never
a 5xx**: the caller is a third party whose retry loop reads 5xx as "come back",
so a miss used to be retried against an error forever. 404 stops it, and it is
stable — a closed hook does not reopen. `workflow-webhook.ts` owns that
reasoning; `workflow-http-adapter.ts` is why the failure status is a parameter
(a queue callback wants the 500 the world retries, and this route must never
emit one).

Three properties of the URL itself are load-bearing:

- **`publicUrl` is an OPTION, never sniffed.** Each deployment supplies it — the
  platform bakes `AAI_PUBLIC_BASE_URL` into the guest's exec env and the harness
  passes it through, `server.mjs` reads `PUBLIC_URL`, `aai dev` passes its own
  BACKEND origin (Vite proxies the browser surface and not the `/.well-known/`
  routes, so the port a developer opens would 404 a delivery).
  Reading an `AAI_*` variable here would make the SDK depend on the vocabulary of
  one of its three deployments.
- **Unconfigured THROWS**, naming the option. A `localhost` URL would be the
  same bug with the failure moved days later and onto somebody else's server.
- **It takes the token, because a hook's token is the caller's.** Derive it in one
  exported helper the body and the tool both import — the rule {@link signal}
  already states. `createWebhook()`'s own token is random and body-side only,
  so a URL that has to be minted from a TOOL wants `createHook({ token })`.

CLOSED for a BODY and its steps too, through the slot this note predicted:
`stepWebhookUrl(token)` on `@alexkroman1/aai/step` reads a `Symbol.for` slot
that a host fills with a MINTER — `publishWorkflowWebhookUrl(publicUrl)` in
`workflow-serve.ts`, beside `workflowWebhookUrl`, which is the one place base +
prefix + encoded token are composed. The minter, rather than the origin, is what
is published: the route belongs to the package that ANSWERS it, so the SDK never
spells this path and the two cannot drift. The guest publishes at bundle load
(before the surface is built, so a boot-time queue delivery cannot race it) from
the `AAI_PUBLIC_BASE_URL` in its exec env — which is why `requireStepEnv` could
not have done this job: that variable is the SPAWNER's and never reaches the
agent env. Unfilled, the reader THROWS naming the configuration; `aai dev` does
not publish one yet, and a laptop origin would not be reachable anyway.
`workflow-client.ts`'s own inline composition is the copy still owed a fold onto
`workflowWebhookUrl`.

## `AAI_PUBLIC_BASE_URL` is what a THIRD PARTY dials, not what the guest dials

`resolvePlatformQueue` (`workflow-platform-world.ts`) resolves the base every
platform client in this package POSTs to — run storage, the queue, session state,
upload records — and it reads **`AAI_PLATFORM_BASE_URL`**, falling back to
`AAI_PUBLIC_BASE_URL`. Those were one key, and the two claims can require
OPPOSITE values:

| | `AAI_PUBLIC_BASE_URL` | `AAI_PLATFORM_BASE_URL` |
| --- | --- | --- |
| Claim | "a third party reaches this agent here" | "the platform is dialable here" |
| Reader | `publicUrl` → `publicWebhookUrl` (above) | `resolvePlatformQueue` |
| Must resolve from | the internet | **inside the sandbox** |

Under the platform's `microsandbox` backend they are different strings, and the
collision was total rather than partial: the guest's port and the platform's are
both 8080, so `127.0.0.1:8080` inside a microVM is the guest's own harness rather
than a closed port. Every platform call was POSTed to the caller itself and
answered by `server.ts`'s own 404 handler —

```text
guest [microsandbox:64953] stderr: POST /<slug>/workflow-storage 404
Workflow API request failed { error: 'storage runs.list answered HTTP 404' }
```

— so every durable run in a studio preview died at its first `events.create`, and
session state fell to memory beside it. The public key must NOT be rewritten to
the microVM's host alias (a webhook URL minted from it is unreachable for exactly
the caller it is for), which is why one key could not serve both and why the
platform derives the second one separately (`agentPlatformBaseUrl` in
`aai-server/public-origin.ts`, from the server's OWN port in local dev, so a
preview needs nothing configured).

**The fallback is not politeness.** An agent sandbox runs the harness image PINNED
at deploy time, so a guest older than this key receives only the public one and
would otherwise lose its platform world entirely — durable runs silently onto the
DevKit's local world, session state silently onto memory, which are the two
failures `platformGuestOptions` exists to stop being silent. On every backend but
`microsandbox` the two values are identical, which is what makes the fallback
restore that guest's exact prior behaviour rather than merely quiet it.

**What let it ship is worth more than the fix, and all three are still debt.** A
unit test PINNED the bug (`expect(x).toBe(unrewritten)` is sound only while `x`
has one reader, and the comment beside it named the one it knew about); the
platform's real-microVM scenario tier names this bug class three times in its own
doc and regression-tests one of them, the bundle URL; and
`AAI_REQUIRE_MICROSANDBOX` is declared in `turbo.json` and exported by
nothing, so the only tier that sees real microVM behaviour has never gated a
merge.

## S2S property test

**A fast-check PROPERTY TEST covers the S2S stack**
(`integration/s2s-fuzz.integration.test.ts` plus `_s2s-fuzz-model.ts`,
`_s2s-fuzz-harness.ts`, `_s2s-fuzz-commands.ts`; same command, also keyless).
**The spec's own module doc and `_s2s-fuzz-model.ts`'s carry the design** — why
the SOCKET is the only fake (every S2S spec that predates it stubs a
neighbouring layer, and the bugs it found live in the seams), why nothing here
uses a TIMER (the hand-rolled walk it replaced could not re-run a
counterexample, and this one runs in ~150ms), and the ledgers the oracles read.
Four things worth knowing before adding to it:

- **Model-based COMMANDS, where the pipeline fuzz generates a script.** Legality
  lives in each command's `check()` against a model that IS the provider state
  machine, so an illegal frame is never generated and a counterexample contains
  only the commands that ran — reverting the three fixes reproduces them from
  `[session.error(rate_limited)]`, `[drop.transient, openSocket,
  session.error(session_not_found)]` and `[drop.transient]`.
- **Three properties, differentiated by a per-run `faultBudget`** (0 / 2 / 3):
  turns, reconnects, retirement. One combined property cannot serve both ends —
  at 2 faults per 40 commands a tool call rarely survived to be answered (the
  central oracle ran 7 times out of 80 executions), and at 0 there are no
  resumes to redeliver across.
- **A finding is only reachable if the run does not excuse it first.** The
  tool-answer exemptions (interrupted turn, client reset, retired session, link
  not ready, a SIBLING call of the same reply still running — results flush per
  reply as a BATCH) are broad enough to silence the oracle completely, so each
  increments a `skip:<why>` counter and the floors are on the CHECKED counts.
  `toolAnsweredAcrossResume` has been near zero through three separate
  mistakes; it is the floor that stands between a live oracle and a decorative
  one. `S2S_FUZZ_COVERAGE=1` prints the table. Note a resumed session inherits
  the dead socket's unanswered tool calls — that is what `session.resume` MEANS,
  and it is the premise the tool-answer oracle rests on.
- **The fakes' fidelity is where the false findings came from**, every time.
  Three drafts blamed the transport for behaviour their own fake had invented:
  an `executeTool` ignoring its abort signal (the real one settles promptly via
  `pTimeout({ signal })`, so `stop()` looked like it hung forever), one ignoring
  an ALREADY-aborted signal (what a `tool.call` after a client cancel receives),
  and one that rejected where the real executor always RESOLVES with a
  `serializeToolFailure(...)` string. Check the real collaborator's contract
  before believing a finding.

## A hook's write needs a commit, and a guard

`agent({ events })` handlers may WRITE session state — `SessionEventContext`
carries `slots`, and the authoring half of that line is in
`packages/aai/CLAUDE.md`, "A session event hook WRITES state, and still cannot
SPEAK". What this package owes it is two mechanics, both in
`session-emitter.ts` and both wired rather than documented and hoped for:

- **The COMMIT.** `slot.update` is synchronous by contract and cannot flush
  itself, and the only other commit point in the runtime is the tool executor's
  `finally` — so a hook write on a session that then ran no tool never reached
  the backend, and its `syncState` projection never repainted. `runHooks` runs
  the same pair (`syncStateToClient`, then `stateStore.flush`) through
  `ToolSetup.commitSessionState`, fire-and-forget because the emit path is
  synchronous and a live call must not wait on a round trip.

  **Paid only by a batch that WROTE**, which is what `watchWrites` is for: it
  wraps the session's `SlotStore` for the duration of one event's handlers and
  reports whether `write` was called. A pass-through wrapper rather than a flag
  on the store, because that store is shared with the tool executor and a flag on
  it could not tell a hook's write from a tool's. The overwhelming majority of
  handlers log a line or bump a counter, and a flush per event would put a
  backend round trip on the transcript path of every turn.

  An `async` handler's write lands after the synchronous pass, so a second commit
  is chained onto the pending promises and skipped when nothing further was
  written.

- **The re-entry GUARD.** A commit emits `state.updated`, so a handler for that
  event which wrote would emit another, forever. `announcing` is set while hooks
  run AND while a commit made on their behalf runs; a nested emit is still
  recorded and still sent to the client, and announces nothing. A hook observes
  the SESSION, not the other hooks. This is not defensive — removing the flag and
  running `session-emitter.test.ts` fails with `RangeError: Maximum call stack
  size exceeded`, and that A/B is what the test exists to keep.

`commitSessionState` is absent on the SANDBOX tool path for the same reason
`pushStateSnapshot` is — the runtime holds no state there. A hook's write still
lands in the store; what it loses is the commit.

## The session takes two VOCABULARIES, not nineteen callbacks

`SessionCore` takes a `command(cmd)` — one `SessionCommand`, what the CLIENT asks
for — and a `report(event)` — one `TransportEventBody`, what the TRANSPORT
observed. `TransportCallbacks` is the same `report` from the other side. That is
the whole inbound surface, plus the two audio paths. It used to be one method per
thing, the same names declared on both sides with a forwarding table between them
and a stub in every harness: **157 `on*` declarations across eleven files, 78 of
them test scaffolding**, none of which decided anything.

Three rules, and `guard-invariants` rule 16 checks the first per file:

- **A callback survives exactly when there is NO EVENT for it** — binary audio,
  `onReplyStarted` (the wire has no `reply.started`, and minting one is a protocol
  change), `onSessionReady`, and the socket-lifecycle hooks a caller must ACT on.
- **Report `agent-transcript.committed` or `.updated`, never a boolean.** Those
  two names carry exactly what `onAgentTranscript(text, interrupted)` plus a
  separate partial callback used to; only the committed one enters history.
- **`reply.completed` is the PROVIDER's claim, not the turn's end** — the one
  report whose name and emitted event can come apart. See `session-reply-done.ts`.

**Audio is not joining the hook surface, and not for cost reasons.** A handler
runs synchronously off `emit` and an async one is never awaited
(`session-emitter.ts`), so no subscriber can add latency to a turn. What keeps
audio out is MEMBERSHIP: `playback_progress` is a client→server command and audio
frames are binary, so neither is in the event vocabulary and neither can be a hook.

**Read `transports/types.ts`** for the boundary and the full argument;
`session-core.ts` and `session-commands.ts` own the two dispatchers.

## `speech_started` means "the agent is yielding", on BOTH transports

The two transports derive this event differently and a client cannot tell them
apart, so pipeline mode holds it back to match S2S rather than emitting what it
happens to know. In S2S the service fires its speech-started the moment it stops
generating, so the event coincides with a real interruption. Pipeline mode has
no VAD and derives the edge from the STT transcript stream, where the FIRST
non-empty partial opened it — one word of a cough, a backchannel, or a phrase
the caller addressed to someone else in the room. `minBargeInWords` and
`interruptionMinDurationMs` correctly declined to abort the reply for those, so
the agent kept talking; the client had been told it stopped.

**That divergence is not cosmetic, because clients act on it.** tau2-bench's
harness DISCARDS its entire agent playout buffer on `speech_started` and has no
`cancelled` handler at all, so the one event that really means "the agent
stopped" is ignored and the one that did not is treated as authoritative — a
reply still being spoken was thrown away mid-sentence. (`aai-ui` reads the event
as informational and stops playback on `cancelled`, which is why this never
showed up in the browser.) Measured by replaying the benchmark's own recorded
caller audio against a live pipeline agent, on the run's 10 conversations
richest in these signals: **184 `speech_started` against 87 `cancelled` — 53% of
the events the client acted on were not interruptions at all.** The agent
yielded to non-directed speech on 12 of 12 occasions and then sat silent a
median 5.9s (real barge-outs, not inter-sentence gaps: only 2.5% of natural gaps
between agent segments are ≤0.6s).

So while the agent holds the floor the edge is HELD, and released only when a
barge-in really fires (alongside `cancelled`) or when the agent stops speaking
on its own; while the agent is silent it passes straight through, because there
is no floor to yield. Live captions are unaffected either way —
`user-transcript.updated` is emitted independently of the gate.
**`transports/pipeline-speech-edges.ts` owns the mechanism**, and its two
layers are deliberately separate: `createSpeechEdgeTracker` decides WHEN an utterance
starts and ends (pipeline mode has no VAD, so this is derived from partials and
finals, with a watchdog for utterances that never commit), and
`createGatedSpeechEdges` decides WHETHER the client is told. The turn
orchestration consuming both is `transports/pipeline-user-speech.ts`.

The property to preserve — and what the specs in `transports/pipeline-voice-events.test.ts`
pin — is that **the score no longer depends on how the client reads the event**.
Across the panel, the spread between a client that truncates on
`speech_started` and one that truncates on `cancelled` collapsed from up to
**66.7 points** (R_Y 89.7% vs 46.7%; S_BC 33.3% vs 100%) to **≤2.7 points**
(R_Y 44.1% both ways). Note which direction R_Y moved: the benchmark's
flattering 90% yield rate was an ARTIFACT of the same bug that wrecked
selectivity — truncating on a signal that arrives ~470ms after the first partial
makes yields look instant. A correct client's yield rate against the old code
was already 46.7%. Do not read the drop as a regression, and do not "fix" it by
reverting the gate.

## A rollback at the cap used to cost a real turn

`transports/pipeline-history.ts` keeps two capped views, and
`dropTrailingUser` — what rolls back an injected prompt (a false-interruption
resume, a silence nudge, `injectTurn`) whose turn left no trace — POPPED where
the push had already TRIMMED. So a rollback landing at
`DEFAULT_MAX_HISTORY` undid the append and not the eviction the append caused:
push at 200 trims the oldest message and lands at 200, the pop leaves 199, and
one real conversation turn was gone for the rest of the call. **Nothing in the
system could see it** — both views are the right shape afterwards, one turn
shallower — and it survived two complete unit suites because every depth
anybody writes by hand is well under 200.

A push now records what it evicted and a pop that undoes THAT push unshifts it
back. Three properties of the bookkeeping are load-bearing and are argued at
`PushUndo`: one slot PER VIEW (a turn pushes the user message into
`conversation` and then into `llm`, so a shared slot would be invalidated by
the second half of the pair that filled the first), recorded only for a push of
exactly ONE message, and consumed by IDENTITY rather than by content. `capLlm`'s
healed tool-pair halves count as part of the eviction, so a restore hands back
the array the push found rather than a prefix of it.

`integration/pipeline-history-rollback.integration.test.ts` is the oracle — a
fast-check property over generated fill scripts, driving both the module's door
and the real one (`persistBargeIn` with a `syntheticPrompt`), whose oracle is a
snapshot of the two views taken before the push. It was written RED and shrinks
to a one-element script; two deterministic pins sit beside it in
`pipeline-history.test.ts`. The defect was originally recorded, and deferred, in
`session-history-replay-equivalence.test.ts`'s module doc; that property
compares TAILS for an unrelated reason that still holds (the two sides trim
different sequences), and its `liveTrims` floor stands after re-measurement.

## History records what was HEARD, not what was generated

An interrupted reply lands in history as the words the caller is estimated to
have actually heard, marked `[interrupted]` — not everything the model produced.
A reply cut before anything was audible records **nothing at all** (its
completed tool steps still do). That is LiveKit's rule, and it exists because
TTS runs behind the text: a barge-in discards whatever is still in the
provider's buffer, so the old record told the model it had delivered
information the caller never got, and the model then never repeated it.

**One cursor, one owner** — `transports/pipeline-heard.ts`
(`createHeardTracker`). It answers exactly one question: given this reply's TTS
text and its forwarded audio, which characters did the caller hear? History
truncation and the false-interruption resume anchor (`buildTailResumePrompt`)
are two READERS of that one answer, which is what keeps the resume prompt from
quoting words the record denies. It also owns the playback clock, so the
barge-in gate reads the same object.

Two tiers of accuracy, decided at RUNTIME rather than by a capability flag: a
provider that reports word timings (AssemblyAI TTS's `WordBoundaries` frames,
parsed in `providers/tts/assemblyai-words.ts`) gives a cursor at the last word
whose audio WHOLLY elapsed; Cartesia and Rime both HAVE a timing frame that is
not wired up, so they degrade to a proportional estimate snapped to a word —
exactly what was there before, so nothing regresses, and the zero case needs no
timings at all. Both roundings err toward UNDER-keeping, deliberately:
over-keeping is the measured failure, while under-keeping costs a word or two of
redundancy that the resume prompt's "without repeating what they already heard"
absorbs.

**The proportional estimate is CLAMPED, because `spoken.length / audioMs` is
not a speech rate** (`MAX_SPEECH_CHARS_PER_MS` in
`transports/pipeline-heard.ts`). Text runs ahead of synthesis by however far the
LLM is ahead of the voice — widest mid-reply, which is exactly when a barge-in
happens — so the raw ratio reads
text nobody has spoken yet as heard: an LLM streaming ~200 chars/s against a
provider synthesizing at 1x hands over a 300-character reply inside 1.5s, so
five seconds in the ratio claims all 300 characters against the ~75 the caller
actually heard. No causal bound fixes that, because the gap is PROPORTIONAL
rather than additive. The rate has to come from the language instead: English
narration runs 14-18 characters a second, so the ceiling sits at the top of that
band and the estimate takes the MIN of it and the observed ratio — a voice
slower than the ceiling is still tracked. The constant's doc carries the
arithmetic.

**The lag is `HEARD_AUDIO_LAG_MS` (750), and it is DERIVED rather than
measured** — its row in the defaults table in `packages/aai/CLAUDE.md` carries
the decomposition and why it is a second constant; do not restate it here.

**The client's committed transcript and the history entry now diverge on
purpose.** The caption still shows everything that reached TTS, because it was
published as interims while the audio was being synthesized. It CANNOT be
corrected after the fact to match the shorter record: emitting an
`agent_transcript` after `cancelled` is the measured 19-of-73 double-transcript
bug (`persistInterruptedTurn` in `transports/pipeline-history.ts` — read it there).

Two mechanisms this leans on: the audio gate (a cancelled turn's late audio AND
its late word timings are both dropped by it, so no second epoch was invented),
and `emitText`'s `record` flag, which now decides what may be truncated into
history as well as what reaches `onDelta` — filler is audible, so it moves the
heard POSITION, and is never recordable. The TTS coalescer flushes when that
flag flips so no batched send ever mixes the two.

**Not covered: a barge-in during the TTS drain.** `runTurn` has already
committed the full text by then, so that case keeps `buildTailResumePrompt` as
its only mitigation (which this change makes word-truthful). Fixing it means
deferring the history commit until after the drain — a change to `runReply`'s
body contract, deliberately separate.

## A `reset` starts a conversation, so it GREETS

The client `reset` frame — aai-ui's "New Conversation" button — discards the
conversation, and a conversation that begins without the agent's declared
opening line is not the one the agent declares. The pipeline transport greeted
only from `onAudioReady`, once per CALL, so every conversation after the first
opened on silence: the caller cleared the transcript and then sat listening to
a live mic with nothing to prompt them. `reset()` therefore ends by calling
`lifecycle.greet()` — queued AFTER `gate.invalidateAll()` so the strand that
kills the pre-reset turns cannot catch it, and on the turn chain so it runs
after the aborted turn unwinds rather than interleaving with it.

**`skipGreeting` deliberately does not reach `greet()`.** It is a RESUME flag
scoped to a connection's start ("this caller already heard the opening line"),
which is the opposite claim from a reset. That is also why aai-ui's `reset()`
drops the resume identity when the socket is already closed: there the redial
IS the new conversation, and a `?sessionId=`/`resume=1` reconnect would rejoin
the old one — server history kept, greeting suppressed.

**Neither S2S transport re-greets, and that is a known gap rather than a
decision.** AssemblyAI S2S has no `reset()` at all (its greeting is dispatched
service-side from the session config, with no protocol verb to replay it), and
OpenAI Realtime has none either — its `sendGreeting()` is a one-shot
`response.create` that could be re-issued, but the service still holds the
conversation a reset is supposed to discard, so re-greeting alone would open a
"new" conversation the model can still see the whole of. Clearing it means
tracking every `conversation.item` id to delete, which is its own change.

## A run can tell the caller it finished

`start(def, input, { key, notify })` makes the session that started a run take an
UNPROMPTED, interruptible turn when it lands — the promise `research-workflow` used
to make ("I'll let you know") and had no way to keep. `Transport.injectTurn` is
the primitive (pipeline only; S2S has no such verb, so there it is a logged
no-op). **See `workflow-notify.ts`'s module doc** for the rest.

## An envelope is only the codec's if the codec WROTE it

`workflow-typed-json.ts` tags binary as `{ __type: "Uint8Array", data }` and a
date as `{ __type: "Date", iso }`, and both revivers recognise one
**structurally** — nothing in the shape says who wrote it. So an author's own
object of that shape went in one end and a `Uint8Array` came out the other, at
any nesting depth, with nothing raised. A run's `input` arrives from
`POST /workflows/runs`, which is public HTTP, so that was type confusion across
a trust boundary: a step declaring `z.object({ __type: z.string() })` received
bytes instead.

**The fix is round-trip TOTALITY, not a guard per shape.**
`workflow-typed-json-escape.ts` renames an author's reserved keys on encode
(`__type` → `___type`, `___type` → `____type`) and back on decode. That map is
injective and nothing maps onto `__type`, so decode inverts it exactly. Three
things about it are load-bearing and easy to undo by accident:

- **A key rename, never a wrapper.** `{ __type: "escape", value: v }` does not
  terminate — `v` still carries the tag, and the reviver runs bottom-up, so it
  would revive the inner envelope before the wrapper could stop it.
- **The pattern is `/^__+type$/`, the whole family.** Escaping only the bare
  `__type` collides an author's own `___type` with somebody else's escape.
- **The rebuild is `Object.fromEntries`, never `out[key] = …`.** `JSON.parse`
  makes `__proto__` a real own property and assignment invokes the prototype
  SETTER: the key vanishes from the copy and the copy's prototype becomes
  author-controlled. Measured on all three spellings; only the assignment loop
  lost it.

Decode still accepts a **bare** `__type` envelope, so `@workflow/world-local`'s
own transport and every row already written are unaffected — which is why the
deployment order is decoder-first.

**Totality is a property of the ESCAPE, not of the envelope set, which is what
makes the set extensible.** `Map` and `Set` joined it — `{ __type: "Map",
entries: [[k, v], …] }` and `{ __type: "Set", values: […] }`, storage codec
only, exactly where the date envelope sits and for the same reason. The escape
never reads the tag's VALUE, so nothing in `workflow-typed-json-escape.ts`
changed. Two rules for a third kind: encode PAIRS and let the replacer recurse
on both halves (a `Map`'s keys are values, not strings), and refuse a malformed
payload rather than let a constructor invent one. The remaining hole is that
this codec still has no unsupported-type GUARD, so any other exotic value
journals as `{}` — a structural check at the step boundary, not a fourth
envelope.

Two related strictnesses came with it, both replacing an invented value with a
throw, and both classified at the callers that already existed for them
(`decodeBody` catches into a 400; the guest fails the step). `Buffer.from(s,
"base64")` DROPS characters outside the alphabet, so a malformed payload decoded
to arbitrary bytes; it is `Uint8Array.fromBase64(…, { lastChunkHandling:
"strict" })` now. And an `iso` that will not parse throws rather than reviving
the `NaN` that stalled every durable run. `iso: null` still revives an invalid
`Date`, because that is the ENCODER's own spelling of one.

**The date asymmetry that remains is deliberate**: the storage RPC emits the date
envelope because both ends are ours, the queue path never does because the
DevKit's `createQueueHandler` is the far end and has no date envelope to read.
After escaping, neither codec REVIVES an author's date-shaped object, so the two
agree on the shape and differ only on what they emit.

### The suite is the point as much as the fix

`workflow-typed-json-property.test.ts` states the round trip over a **generated**
domain, and it is the pattern to copy for the other codecs in this repo. Its
object keys are drawn from a pool containing the reserved family and
`__proto__`, and its strings from one containing `"Uint8Array"`, `"Date"` and
both valid and invalid base64 — so a generated value is an envelope-shaped object
a measured ~300 times per run, which is the case a hand-listed domain cannot
reach: author data that looks exactly like the codec's own output. The 27 named
cases stay beside it as regression pins; a pin says "this value still works", a
property says "no value breaks it".

**A coverage floor earned its place on the first run.** The first draft reached
ZERO complete forged envelopes across 8,000 generated values — a full envelope
needs two particular keys carrying two particular values in one record, which is
too rare to hit by chance — while every round-trip property passed green. Without
the floor the suite would have read as a proof of exactly the property it was not
testing. `envelopeShape` constructs them deliberately; the floors sit at roughly
half the observed minimum over 12 runs, with the ranges recorded in place.

**A/B every mutation, including the test's own inputs.** Five reverts of the fix
are each caught, and two of them — the `__proto__` rebuild and the one-level
escape — are caught by the generated properties rather than by any named case.
Two of the test's own inputs were wrong in ways that would have made them pass
vacuously: `{ __proto__: … }` written as an object LITERAL is the
prototype-setter syntax and creates no own property, and a server-side case using
`runs.get` answered 400 whether or not the fix was in, because a `Uint8Array` is
not a run id. Both are noted where they sit.

## Runtime invariants

`@alexkroman1/aai/internal` publishes `invariant(condition, name, detail?)`,
`InvariantViolation` and `isInvariantViolation`. The seam lives in the SDK
because every package depends on it; the invariants stated against it are
mostly this package's, which is why the argument is here.

**The economics are the point.** A review of ~38 defects fixed in one 48-hour
window found every one at a boundary the test suite owned both sides of — the
suite is almost entirely CONFIRMATORY, pinning fixes after the fact. An
invariant inverts that: state the property once, where it has to be
maintained, and every existing test file, every load run, every `aai dev`
session and production itself becomes a detector for it, including the paths
nobody wrote a test for.

Three rules come with it:

- **It throws; it is never a log.** A logged invariant goes to a stream nobody
  reads, on a request that returned a wrong answer anyway. Every violation is
  a bug in this process by construction — the conditions are ours to maintain,
  and a peer's input is validated by a schema rather than by this. The risk is
  stated rather than hidden: a WRONG invariant turns a working path into an
  outage, so a condition goes in only when it is a property this code
  establishes and nothing else can perturb.
- **`detail` is a THUNK.** It runs only on the failing path, so a violation
  reports the actual numbers for free — the difference between
  `session.page.tail violated: {"startIndex":0,"events":4,"tail":0}` and a
  bare assertion. Its call is wrapped, because a thunk reading the state that
  just went inconsistent is the likeliest place for a second throw, and
  reporting ITS `TypeError` would lose the finding entirely.
- **There is deliberately no SAMPLING.** The obvious design checks always in
  dev and on a fraction of calls in production so an expensive condition can
  stay on. Every invariant here today is O(1) — a comparison between two
  numbers the caller already holds — so a thunk would allocate a closure to
  avoid work cheaper than the closure. A rate nothing needs is a knob nobody
  tunes and a path nobody exercises, the shape this repo has been bitten by
  four times (`.size-limit.json`, the `ls-lint` config, the root coverage
  thresholds, the `.turbo` cache path). It belongs with its first O(n) caller.

**Where one does NOT go: inside an error handler.** A throw there turns a 500
into an unhandled rejection, and an oracle meant to find conditions nobody has
classified yet is the last one you want failing that way the first time it is
right. The workflow API's classification is swept over a pure function
instead — see "Every environmental error is classified" below.

**Stating one wrong is cheap, and that is a feature.** The first draft of
`session.page.tail` said `tail >= startIndex + events.length` with no empty
guard, and two existing specs failed inside eight seconds: a read STARTING
past the tail is legitimate and answers zero events, about which the tail says
nothing. An invariant is exercised by the whole suite the moment it lands.

### The two stated so far

- **`session.page.tail`** (`session-event-stream.ts`) — a page cannot contain
  events its own tail says do not exist. This is the cold-read bug that
  shipped: four events beside `tail: 0`, because the tail came from the
  in-process map and the events from a durable backend. Reverting that fix now
  reports `{"sessionId":"s-1","startIndex":0,"events":4,"tail":0}` from every
  read that reaches it, not only from the spec that walks to it.
- **`capacity.line.terms`** (`aai-server/platform-db-capacity.ts`) — the terms
  a boot line names must COMPOSE the total it prints, never add to it. See
  "The boot line describes the reading it was built from" in that package.

## Every environmental error is classified

`workflow-api-error-status.ts` maps a thrown value to a status, and
`workflow-api-error-classification.test.ts` requires that there be no THIRD
state: every environmental code a Node service here can meet is either mapped
or named in `DELIBERATELY_INTERNAL` with a reason a 500 is right. "Nobody
thought about this code" is what both of the window's
500-that-should-have-been-503 defects were.

The sweep found eight unclassified codes on its first run, none of which had
an incident behind them: `ENETDOWN`, `ENOTCONN` and `EAGAIN` are ordinary
transport failures and joined the table; `EMFILE`, `ENFILE`, `ENOBUFS` and
`ENOMEM` are a FOURTH condition the table had no entry for — this process out
of a local resource, which is neither "the database is at capacity" nor
"could not reach the platform" — and got `isResourceExhausted` and a 503 of
their own, ordered BEFORE the transport entry because a descriptor limit
surfaces on a socket operation and looks transport-shaped on the way out. The
eighth, `UND_ERR_RESPONSE_STATUS_CODE`, is declared internal: a response
arrived, so there is nothing transient to wait for.

**One divergence is pinned as a known gap rather than fixed.** `isCallerGone`
reads `code === "ECONNRESET"` off the TOP-level value and the transport entry
is guarded by `!isCallerGone(err)`, so a reset arriving WRAPPED — how `fetch`
delivers one — is a 503, while the identical condition arriving BARE is read
as the caller hanging up and falls through to 500. For a real inbound hangup
that is harmless and deliberate. The open question is whether anything
OUTBOUND throws a bare top-level `ECONNRESET` here: a `postgres` driver error
carries its code at the top level, unlike `fetch`, in which case a client
waiting on `POST /runs` gets a 500 with no `Retry-After` AND the failure is
logged as "caller went away". Direction is not recoverable from the code
alone; `syscall` is the candidate discriminator, since Node's inbound
`aborted` error carries none. Not guessed at.
