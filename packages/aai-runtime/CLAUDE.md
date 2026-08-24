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
the root `AGENTS.md` — and what it means here is that a signature change on any
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

**Every capability owes a frozen, compiling TEMPLATE** under
`contracts/compatibility/<capability>/v1.ts`, and `pnpm typecheck` is what
enforces it. Editing one to make an error go away defeats the mechanism — the
error IS the finding.

**A template rather than an example, and the distinction is the point.** `aai`
and `aai-ui` freeze snippets an author READS: an `agent.ts` is a short file and
the useful artifact is a fragment of one. This package's consumers embed it —
they stand up a host, a carrier codec, a state backend — so the useful artifact
is a starter they COPY and edit, composed front to back, with the edit points
marked and no design commentary in the way (that material is in this guide,
which is where a reader can find it without opening twelve files). Each is the
starter as it was written AT THAT EPOCH; the way to change an API is a new epoch
carrying a new template, never an edit to a frozen one.

**A template exercises 98 of the 125 names, and that is not a hole in the
gate.** The epoch hash covers the capability's REPORT, which carries every name
the entrypoint selects — so a signature change on `SweepSkip` moves `db`'s hash
and demands a classification whether or not any template mentions it.
Classification coverage is 125 of 125; what the other 27 lack is a compile-time
exercise. The gap is deliberate and per name: `createServer`/`createHostServer`
are a different artifact from the bootstrap (embedding into an existing runtime,
and a multi-tenant host-mode server); `SweepSkip` has no public producer, so a
host can never be handed one; `partKey`/`partsOf` would need a `delete` that
`UploadBlobs` does not have; `telnyxCodec`/`twilioCodec` are the shipped
carriers a third-carrier template exists to be an alternative to. Contorting a
starter to touch all 125 is how these files became catalogues the first time.
Where a name's absence is a finding rather than a choice, it is in the list
below.

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
  the thirteen capabilities select. A name here has an epoch, a report, and a
  frozen compiling template behind its capability. Nothing on it is
  `@internal` — that is what the zero means, and the ratchet is what holds it.
- **`@alexkroman1/aai-runtime/internal` (`internal.ts`)** is the cross-package
  infrastructure `aai-server`, `aai-cli` and `aai-guest` need: the session-state
  backends and their tables, the workflow serving half (surface, world, flow
  path), the wake hint, the queue-lock sweep, the step-env publisher, the upload
  store, and the shipped `consoleLogger`. No capability, no epoch, no semver
  promise.

  **A name is on it because something IMPORTS it.** Both tranches were assembled
  by moving whole `@internal` blocks off the root barrel, which is why the
  subpath opened at 99 names of which **33** were imported anywhere in the repo.
  The other 66 were not a smaller version of the ratchet problem: for a name
  already tagged `@internal` at its DECLARATION, simply not re-exporting it is
  cheaper than publishing it somewhere quieter — intra-package use is relative
  imports, so nothing breaks, and a name reachable from no subpath cannot be
  autocompleted, reported on, or depended upon. They are gone, and adding a
  clause here in anticipation of a consumer is a surface with no reader. The
  three exceptions are structural: `WakeHintOptions`, `WakeHintPublisher` and
  `WorldKind` are unimported and named by the signature of something that is.

Where a capability's TYPE is contracted and its CONSTRUCTOR is not, the two are
deliberately on different pages and each clause says so: `SessionCore` on the
barrel and `createSessionCore` on `/internal`, `SessionStateBackend` against
`createPostgresStateBackend`, `UploadStore` against `createUploadStore`,
`WorkflowClientOptions` against `createWorkflowClient`, `SweepSkip` against
`claimPoolPresenceAndSweep`. That asymmetry is a finding, not a shape to copy —
see "What writing the templates found" below.

**Making one of them public is not a re-export.** The `@internal` tag comes OFF
at the declaration site and the name joins a capability under
`contracts/entrypoints/`, which is what buys it an epoch and obliges a template.
Adding it to `runtime-barrel.ts` with the tag still attached puts it straight
back on the ratchet, and the ratchet may only shrink — a `/** @internal */` on
the re-export clause does not help, for the API Extractor reason above.

### What writing the templates found

Four things the surface cannot currently demonstrate about itself. None is a bug;
each is a decision worth making rather than inheriting.

- **`uploads` publishes a store TYPE and two blob implementations with no
  contracted way to join them** — `createUploadStore` and `resolveUploadBlobs`
  are `@internal`, so they are on `/internal` and the template has to take the
  store as a parameter. Honest for an embedder handed one by `createServer`, and
  it means the capability cannot show its own end-to-end wiring.
- **`workflow` is the same shape one level up**: `WorkflowClientOptions` is
  contracted and `createWorkflowClient` is on `/internal`, so a template can
  assemble the bag and not hand it to anything. Its `logger` field is required
  and both shipped `Logger` values (`consoleLogger`, `createConsoleLogger`) are
  on `/internal` too — only the `Logger` type is contracted.

  It is at **epoch 2** for a reason worth knowing, because it is the SIBLING
  version of the `TextTurnResult` hazard below: the export list did not move and
  neither did a signature, only the PROVENANCE line in the rollup —
  `WORKFLOW_API_PREFIX` reaches this package from `@alexkroman1/aai/internal`
  now rather than `/workflow-api`, since the prefix is the server's half of that
  API. Epoch 1 is retained and `contracts/compatibility/workflow/v1.ts` compiles
  unchanged, which is the evidence a host that takes the constant from
  `@alexkroman1/aai-runtime` — every host — sees nothing.
- **`WdkAdapter` is nine methods with no partial-implementation affordance**, so
  the honest template is fifty lines of skeleton and anything in the wild will either
  be that long or reach for a cast. A `createStubWdkAdapter(overrides?)` — the way
  `aai` publishes `createToolContext` — would remove the incentive to launder it.
- **`TextTurnResult` is `ReturnType<typeof streamText<ToolSet>>`**, so this
  capability's contract hash moves when the `ai` package's `StreamTextResult`
  moves. An upstream minor can force an epoch classification here with no change
  of ours.

And one real defect the templates caught, now FIXED: **`PassthroughServerOptions`
could not be spread into `ServerOptions`.** Its fields were optional WITHOUT
`| undefined`, so under `exactOptionalPropertyTypes` `{...hooks}` widens each to
`T | undefined` and `createServer` rejected it (TS2379) — while the three wrapper
doors exist precisely so one hook bag can reach all of them. The fix is on the
TARGET side, which is where an A/B locates it: `ServerOptions`' `logger`,
`upgrade` and `request` accept `undefined`, and `createAgentServer` spreads the
bag. Do not narrow them back. The workaround stays frozen into
`contracts/compatibility/server/v1.ts`, where it is a record of how epoch 1 was
written and not a shape to copy.

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

`uploadBroker` came with them; the remaining gaps are deliberate.
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

There is no `typedoc.json` here, and its absence is now a measured decision
rather than an oversight. Two things make it one.

**A package-local config alone turns the suite red.**
`packages/aai-templates/docs-markdown-gate.test.ts` globs `packages/*/typedoc.json`
and asserts that every package holding one has committed markdown under
`docs/api/` — so the file cannot land before the render that produces its page.
The coupling is deliberate and it is wider than that one test: flipping this on
means `docs/typedoc.json`'s `entryPoints`, the `include` in
`docs/tsconfig.typedoc.json`, the `dependsOn` + `inputs` of turbo's `docs` task,
the retraction of `UNDOCUMENTED_SUBPATHS["aai-runtime"]["."]` in
`scripts/docs-markdown.mjs` (which errors on a subpath that is both documented
AND excused), and the regenerated `docs/api/` — one change, or a red gate.

**And the answer today is no.** `docs/CLAUDE.md` argues it: a ~220-export
surface aimed at somebody EMBEDDING an agent, rendered beside the SDK, rebuilds
the two-thirds-of-a-combined-reference the runtime split undid. The deny-list
entry says what would change the answer — "revisit if embedders ask for a
rendered page, then it gets its own, not a share of the SDK's".

What is worth not rediscovering is that the config is a five-line file plus two
options, both earned by a warning an actual render produced, and that with them
this package renders CLEAN — zero warnings under `treatWarningsAsErrors`, one
~7,100-line `@alexkroman1/aai-runtime.md`, against `aai` and `aai-ui` in the
same project:

- `entryPoints: ["dist/runtime-barrel.d.ts"]` — the only documentable subpath,
  since `./internal` is deny-listed for the reason its own module doc gives.
- `intentionallyNotExported: ["EventsNamed"]` — the `Extract` helper
  `TransportEventBody` is written as. Same call as `DistributiveOmit` in
  `packages/aai/typedoc.json`: a reader gets the resolved union in the rendered
  signature and can never name the helper.
- `externalSymbolLinkMappings` for `ai`'s `LanguageModel`, which `resolveLlm`
  returns and `LlmRegistryEntry.create` builds.

Rendered in ISOLATION it reports seven more, all `{@link Db}`-shaped links into
`@alexkroman1/aai`. Those are an artifact of the SDK not being in the project,
not a defect in these comments — do not "fix" them by deleting links.

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

**Neither direction takes turns with the socket.** A whole-file write puts
`UPLOAD_WINDOW_CONCURRENCY` windows while the next one is still arriving, and the
byte route reads `UPLOAD_READ_AHEAD` chunks ahead of what it has written — both
`mapStream` (below), which is where the ordering, the memory bound, and the
whole-window buffering that keeps a failed write re-sendable are argued.

## A callback URL comes from `publicWebhookUrl`, never from `hook.url`

`createWebhook()` sets `hook.url`, and it is **guest-local**: the DevKit composes
it from `getWorkflowMetadata().url`, which is `http://localhost:<port>` off the
running process (its only other branch is `https://$VERCEL_URL`). Deployed, that
names the inside of a sandbox which has self-exited by the time a payment
provider calls back. So the SDK mints its own:
`ctx.workflows.publicWebhookUrl(token)` — `RuntimeOptions.publicUrl` plus the
same `WORKFLOW_WEBHOOK_PREFIX` the guest's own router parses, so the URL handed
out and the path that answers it cannot drift.

Three properties are load-bearing:

- **`publicUrl` is an OPTION, never sniffed.** Each deployment supplies it — the
  platform bakes `AAI_PUBLIC_BASE_URL` into the guest's exec env and the harness
  passes it through, `server.mjs` reads `PUBLIC_URL`, `aai dev` passes its own
  BACKEND origin (Vite proxies the browser surface and not the DevKit's
  `/.well-known/` routes, so the port a developer opens would 404 a delivery).
  Reading an `AAI_*` variable here would make the SDK depend on the vocabulary of
  one of its three deployments.
- **Unconfigured THROWS**, naming the option. A `localhost` URL would be the
  same bug with the failure moved days later and onto somebody else's server.
- **It takes the token, because a hook's token is the caller's.** Derive it in one
  exported helper the body and the tool both import — the rule {@link signal}
  already states. `createWebhook()`'s own token is random and body-side only,
  so a URL that has to be minted from a TOOL wants `createHook({ token })`.

Not yet closed: a `"use workflow"` BODY, and a step it hands `hook.token` to,
have no `ToolContext` and so no way to reach `publicUrl` — a run that must EMAIL
its own callback URL still composes it from a value the author supplies.
`stepEnv`'s `Symbol.for` slot is the shape that would close it.

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
