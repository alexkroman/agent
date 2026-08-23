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

## The published surface is versioned in epochs

Thirteen capabilities under `contracts/`, each a named slice of what an
embedder writes against: `server`, `runtime`, `session`, `session-state`,
`providers`, `telephony`, `uploads`, `db`, `keys`, `workflow`, `logging`,
`text`, `tools`. The
mechanism is the repo's — see "The authoring surface is versioned in epochs" in
the root `AGENTS.md` — and what it means here is that a signature change on any
of the 125 public names is CLASSIFIED (`--bump … --retain` or `--drop "<reason>"`)
rather than discovered by whoever's build breaks.

`tools` is the newest and the smallest — one name, `withToolsDir` — and it is
its own capability rather than part of `runtime` because it assembles the
DEFINITION a runtime is handed rather than any part of the engine. See "Tool
discovery off the platform" below.

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

`uploadBroker` came with them; the remaining gaps are deliberate. The host-mode
pair (`ServerOptions.env`, `hostBaseAgent`) belongs to `createHostServer` — a
server whose sessions run agents their callers supply is a different door, not an
option on this one. `name` and `greeting` are derived, which is the whole point.
And of `RuntimeOptions`' twenty, the fourteen unreachable ones are the testing
and sandbox seams (`executeTool`, `toolSchemas`, `createWebSocket`,
`createOpenaiRealtimeWebSocket`, `runCode`, `fetch`, `onToolResult`,
`toolGuidance` — `@internal` or platform-harness only), the provider triple
`stt`/`llm`/`tts` (which the agent declares), and the three tuning numbers
(`s2sConfig`, `sessionStartTimeoutMs`, `shutdownTimeoutMs`). Forward one of those
when somebody needs it, not before.

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
