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

Twelve capabilities under `contracts/`, each a named slice of what an embedder
writes against: `server`, `runtime`, `session`, `session-state`, `providers`,
`telephony`, `uploads`, `db`, `keys`, `workflow`, `logging`, `text`. The
mechanism is the repo's — see "The authoring surface is versioned in epochs" in
the root `AGENTS.md` — and what it means here is that a signature change on any
of the 122 public names is CLASSIFIED (`--bump … --retain` or `--drop "<reason>"`)
rather than discovered by whoever's build breaks.

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

**A template exercises 95 of the 122 names, and that is not a hole in the
gate.** The epoch hash covers the capability's REPORT, which carries every name
the entrypoint selects — so a signature change on `SweepSkip` moves `db`'s hash
and demands a classification whether or not any template mentions it.
Classification coverage is 122 of 122; what the other 27 lack is a compile-time
exercise. The gap is deliberate and per name: `createServer`/`createHostServer`
are a different artifact from the bootstrap (embedding into an existing runtime,
and a multi-tenant host-mode server); `SweepSkip` has no public producer, so a
host can never be handed one; `partKey`/`partsOf` would need a `delete` that
`UploadBlobs` does not have; `telnyxCodec`/`twilioCodec` are the shipped
carriers a third-carrier template exists to be an alternative to. Contorting a
starter to touch all 122 is how these files became catalogues the first time.
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

So `@alexkroman1/aai-runtime/internal` carries the 31 platform-infrastructure
names (the builtins resolver, the SSRF-safe fetch pair, the four step-slot
publishers, the upload byte constants and id grammar), and
`NON_AUTHORING_SUBPATHS` in `scripts/_api-contracts-tree.mjs` names it so a name
arriving there joins no capability. `aai-server`, `aai-cli` and `aai-guest`
import from it — which is honest, since they are the cross-package consumers the
seam exists for.

**The 17-name OPENER CONTRACT deliberately stayed on the root barrel.**
`registerSttKind`/`registerTtsKind` live there, and moving their parameter types
(`SttOpener`, `SttOpenOptions`, `SttSession`, and the Tts twins) would make a
custom provider — the documented use, and what `aai-evals/fake-speech.ts` really
does — import from two subpaths, one of them labelled not-semver-covered. The
block's own comment already called those names one contract; the split respects
it. Do not "tidy" them onto `/internal` later.

`contracts/internal-surface.json` opens at **68** and may only shrink: exports
tagged `@internal` that are nonetheless reachable from the root barrel. That is
the same ratchet that took `aai` from 74 to 0.

### What writing the templates found

Four things the surface cannot currently demonstrate about itself. None is a bug;
each is a decision worth making rather than inheriting.

- **`uploads` publishes a store TYPE and two blob implementations with no public
  way to join them** — `createUploadStore` and `resolveUploadBlobs` are
  `@internal`, so the template has to take the store as
  a parameter. Honest for an embedder handed one by `createServer`, and it means
  the capability cannot show its own end-to-end wiring.
- **`workflow` is the same shape one level up**: `WorkflowClientOptions` is
  `@public` and `createWorkflowClient` is `@internal`, so a template can assemble
  the bag and not hand it to anything. Its `logger` field is required and both
  public `Logger` values (`consoleLogger`, `createConsoleLogger`) are `@internal`
  too.
- **`WdkAdapter` is nine methods with no partial-implementation affordance**, so
  the honest template is fifty lines of skeleton and anything in the wild will either
  be that long or reach for a cast. A `createStubWdkAdapter(overrides?)` — the way
  `aai` publishes `createToolContext` — would remove the incentive to launder it.
- **`TextTurnResult` is `ReturnType<typeof streamText<ToolSet>>`**, so this
  capability's contract hash moves when the `ai` package's `StreamTextResult`
  moves. An upstream minor can force an epoch classification here with no change
  of ours.

And one real defect the templates caught: **`PassthroughServerOptions` cannot be
spread into `ServerOptions`.** Its fields are optional WITHOUT `| undefined`, so
under `exactOptionalPropertyTypes` `{...hooks}` widens each to `T | undefined`
and `createServer` rejects it (TS2379) — while the three wrapper doors exist
precisely so one hook bag can reach all of them. The frozen template forwards
`logger`/`upgrade`/`request` one at a time to compile. Either those fields carry
`| undefined` or the wrappers take the bag as a nested field; the workaround is
frozen into `contracts/compatibility/server/v1.ts` until one of those happens.
