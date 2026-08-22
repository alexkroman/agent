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
