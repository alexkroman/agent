# CLAUDE.md

## Overview

AAI is a voice agent development kit. Users define agents as directories
containing `agent.ts`. The CLI bundles and deploys them to the managed platform.

- **Platform**: `agent.ts` → CLI bundle → deploy to managed server

## Commands

```sh
pnpm install             # Install dependencies
pnpm test                # Run all unit tests (vitest)
pnpm lint                # Run Biome linter (all packages)
pnpm typecheck           # Type-check all packages
pnpm lint:fix            # Auto-fix lint issues
pnpm check:local         # Fast pre-commit gate (single turbo invocation, max parallelism)
pnpm check:affected      # Only check packages affected by changes since main
```

### Test tiers

| Tier | Command | Scope | Timeout |
| --- | --- | --- | --- |
| Unit | `pnpm test` | Fast, mocked, co-located | 5s |
| Integration | `pnpm test:integration` | Real subsystems (Deno sandboxes, HTTP servers) | 30s |
| E2E | `pnpm test:e2e` | Full process spawn + Playwright browser | 300s |
| Templates | `pnpm test:templates` | Template agent example tests | 5s |

### Single-package shortcuts

```sh
pnpm test:aai-core       # Run only aai unit tests
pnpm test:aai-ui         # Run only aai-ui unit tests
pnpm test:aai-cli        # Run only aai-cli unit tests
pnpm test:aai-server     # Run only aai-server unit tests
pnpm test:templates      # Run template agent tests
pnpm dev:aai-server      # Start aai-server in dev mode
```

### Running specific tests

```sh
pnpm vitest run --project aai                   # Single package via --project
pnpm vitest run packages/aai/types.test.ts      # Single file
pnpm vitest run session                         # All files matching "session"
pnpm --filter @alexkroman1/aai test             # Single package via pnpm filter
```

### Full CI check (`pnpm check`)

Runs via `scripts/check.sh` in a single turbo invocation for maximum
parallelism. Turbo handles the dependency graph — tasks with no
dependencies (lint, test, syncpack, sherif) start immediately while
build-dependent tasks (typecheck, publint, attw) wait for build.

`pnpm check:local` uses the same script with `--local` flag, running a
subset: build, typecheck, lint, publint, syncpack, sherif, test — all
in one turbo call with `--continue` (shows all failures at once).

`pnpm check:affected` uses turbo's `--affected` flag to only run tasks
for packages changed since the default branch.

### Quality ratchets

Beyond lint/typecheck/test, `scripts/check.sh` runs two **ratchet gates**
(both also runnable standalone) that hold the line on technical debt by
comparing the branch against its merge-base with `origin/main`:

- **`pnpm check:hatches`** (`scripts/check-escape-hatches.mjs`) — counts
  static-analysis escape hatches (`@ts-expect-error`, `@ts-ignore`,
  `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `as any`) across
  `packages/` and fails on any **net-new** total versus the merge base.
  The baseline only ratchets down — removing a hatch lowers the bar for the
  next branch, and you can't silently add one. Fix the underlying
  type/lint error instead of suppressing it.
- **`pnpm check:file-length`** (`scripts/check-file-length.mjs`) — caps
  source files at 500 lines and test files at 700. Files that already
  exceed the cap are grandfathered in `scripts/file-length-allowlist.json`,
  which records each file's current ceiling; a grandfathered file may not
  grow past its ceiling, and ceilings should only ever be lowered as files
  are split up. New files must come in under the cap. Templates under
  `packages/aai-templates/templates/` are exempt.

These are pure git/fs checks (no build needed), so they run up front and
fail fast. To tighten quality over time, lower the entries in the
file-length allowlist and delete escape hatches — both baselines are
designed to only move one direction.

A third ratchet lives in the vitest configs: **coverage thresholds**.
Each package's `vitest.config.ts` declares per-package coverage floors
(lines/functions/branches/statements) that CI enforces via
`pnpm test:coverage` (the `test` job runs it per package), and the root
`vitest.config.ts` holds combined floors for whole-repo runs. Like the
other ratchets these only move up: when a coverage run shows actuals
comfortably above a floor, raise the floor to ~2-3 points below the
actual. Never lower a floor to make a PR pass — add tests instead.
Coverage measures production source only; test infrastructure
(`_test-utils.ts`, mocks, fixtures, setup files) is excluded via
`sharedCoverageExclude` in `vitest.shared.ts`.

## Architecture

Five workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: manifest, types, protocol, S2S, session, KV |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (Preact): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, deploy, delete, secret |
| `packages/aai-server/` | `aai-server` | Managed platform server (private): sandbox, sidecar, auth, SSRF |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |

**Dependency flow:** `aai-cli`, `aai-ui`, and `aai-server` depend on `@alexkroman1/aai`
(via `workspace:*`) but never on each other.

**Publishable packages must use the `@alexkroman1/` scope.** The unscoped
names `aai`, `aai-ui`, `aai-cli` are taken on npm by other publishers —
publishing under those names returns 404. The `scripts/check-publish-names.mjs`
script enforces this at CI time.

### Package exports

#### `aai` (shared core SDK)

Subpath exports consumed by sibling packages and user agents:

- `.` — `agent()`, `tool()` helpers, `Kv`, types, utils, constants
- `./runtime` — full Node.js runtime engine (barrel → 11 host/ modules)
- `./protocol` — wire-format Zod schemas, `lenientParse()`, `ClientEvent`
- `./manifest` — `parseManifest()`, `toAgentConfig()`, `agentToolsToSchemas()`
- `./stt` — pipeline-mode STT provider factories (e.g. `assemblyAI`)
- `./tts` — pipeline-mode TTS provider factories (e.g. `cartesia`)
- `./kv` — KV provider factories (`memoryKv`, `fsKv`, `s3Kv`, `redisKv`)
- `./vector` — Vector provider factories (`pinecone`, `inMemoryVector`)

#### `aai-ui` (UI)

- `.` — default Preact UI component + session + client helpers
- `./session` — session management (no Preact dependency)
- `./styles.css` — default styles

#### `aai-cli` (CLI)

Binary: `aai` — subcommands: init, dev, test, build, deploy, delete, secret

### SDK structure

The SDK is organized into two directories with a **hard dependency
boundary** — this split is critical for sandbox security:

- **`sdk/`** — shared modules with **zero Node.js dependencies**. Safe to
  run in browsers, Deno, and sandboxed environments. Contains:
  `types.ts`, `kv.ts`, `hooks.ts`, `utils.ts`, `constants.ts`,
  `protocol.ts`, `system-prompt.ts`, `manifest.ts`,
  `ws-upgrade.ts`, `_internal-types.ts`, `define.ts` (`agent()` and
  `tool()` helpers for authoring `agent.ts` files).
- **`host/`** — host-only modules that **require Node.js APIs** (`node:vm`,
  `node:crypto`, etc.). Only runs on the platform server and CLI, never
  inside a guest sandbox. Contains:
  `server.ts`, `runtime.ts`, `runtime-config.ts`, `runtime-types.ts`,
  `tool-executor.ts`, `session-core.ts`, `s2s.ts`, `ws-handler.ts`,
  `transports/` (S2S / pipeline / OpenAI Realtime `Transport`
  implementations), `to-vercel-tools.ts`,
  `providers/` (STT/TTS openers + descriptor→instance resolvers),
  `builtin-tools.ts`, `_run-code.ts`, `unstorage-kv.ts`.

**Rule**: When adding new SDK code, place it in `sdk/` if it has no
`node:` dependencies. Moving code from `sdk/` → `host/` is safe;
moving `host/` → `sdk/` requires removing all Node.js imports first.

The guest harness (`guest/deno-harness.ts`) runs Deno inside each
gVisor sandbox, loading the agent's ESM bundle directly — no import
restrictions apply there.

### Key files

#### packages/aai-cli/

- `cli.ts` — arg parsing, subcommand dispatch
- `init.ts` / `dev.ts` / `test.ts` / `deploy.ts` / `delete.ts` /
  `secret.ts` — subcommand entry points
- `_init.ts` / `_deploy.ts` / `_delete.ts` / `_bundler.ts` — internal logic
- `_dev-server.ts` — dev server for directory-based agents: loads `agent.ts`,
  builds runtime, watches for file changes, optionally runs Vite for client HMR
- `_bundler.ts` — bundles `agent.ts` (and optional `client.tsx`) into
  deployable artifacts
- `_api-client.ts` — platform API client (`apiRequest`, `apiRequestOrThrow`)
- `_config.ts` — auth config, project config, API key management
- `_agent.ts` — agent discovery, dev mode detection, server URL resolution
- `_utils.ts` — shared utilities (`resolveCwd`, `fileExists`)
- `_server-common.ts` — shared server utilities
- `_templates.ts` — template handling
- `_ui.ts` — CLI output helpers (`log`, `fmtUrl`, `parsePort`)

#### packages/aai-ui/

- `index.ts` — main exports, Preact UI component
- `session.ts` — WebSocket session management, message handling, reactive state
- `context.ts` — SessionProvider, useSession, ClientConfigProvider, useClientConfig
- `hooks.ts` — useToolResult, useToolCallStart, useAutoScroll
- `audio.ts` — PCM encoding/decoding, AudioWorklet management
- `define-client.tsx` — client mount helper
- `types.ts` — UI type definitions
- `components/` — UI components (app, chat-view, controls,
  message-list, start-screen, sidebar-layout, tool-call-block, button,
  tool-icons)

#### packages/aai-server/

- `orchestrator.ts` — HTTP + WebSocket routing
- `sandbox.ts` — gVisor sandbox management
- `sandbox-vm.ts` — per-agent sandbox lifecycle (start, teardown)
- `sandbox-pool.ts` — pool of pre-warmed Deno harnesses for fast cold starts
- `sandbox-network.ts` — network proxying for sandbox
- `sandbox-slots.ts` — slot allocation for concurrent sessions
- `gvisor.ts` — gVisor (runsc) OCI runtime integration
- `guest/deno-harness.ts` — Deno guest entry point (runs inside gVisor sandbox)
- `guest/fake-vm.ts` — lightweight fake-VM fallback for macOS dev mode
- `ndjson-transport.ts` — NDJSON-over-stdio transport for host↔guest RPC
- `transport-websocket.ts` — WebSocket transport layer
- `auth.ts` — authentication/authorization
- `credentials.ts` — credential derivation
- `bundle-store.ts` — agent bundle storage (S3/memory)
- `deploy.ts` / `delete.ts` — deployment lifecycle
- `secret-handler.ts` — secret management
- `kv-handler.ts` — KV store HTTP API
- `ssrf.ts` — SSRF protection, URL validation
- `metrics.ts` — Prometheus metrics registry and definitions; mounted at
  `/metrics` (internal-only). Dashboards live in `grafana/`.

### Session modes

Each agent runs in one of two session modes, selected at parse time by
`parseManifest()` based on which top-level fields are present in the
`agent()` config:

- **S2S mode** (default — no `stt`/`llm`/`tts` fields in `agent.ts`) uses
  `createS2sTransport()` in `packages/aai/host/transports/s2s-transport.ts`.
  The host opens a single WebSocket to AssemblyAI's speech-to-speech
  service; STT, the LLM loop, and TTS all run service-side and audio/events
  relay through that one socket. This is the original architecture.
- **Pipeline mode** (triggered when all three of `stt`, `llm`, and `tts`
  are set) uses `createPipelineTransport()` in
  `packages/aai/host/transports/pipeline-transport.ts`. Here the host
  drives the LLM loop itself via the Vercel AI SDK's `streamText`, and STT
  and TTS are pluggable providers imported from the `@alexkroman1/aai/stt`
  and `@alexkroman1/aai/tts` subpath exports.

Partial provider configs are rejected at parse time — `parseManifest()`
requires either zero or all three of `stt`/`llm`/`tts`.

Reference providers shipped today:

- **STT**: one of
  - `assemblyAI({ model: "u3pro-rt" })` — `ASSEMBLYAI_API_KEY`
  - `deepgram({ model: "nova-3" })` — `DEEPGRAM_API_KEY`
  - `elevenlabs({ model: "scribe_v2_realtime" })` — `ELEVENLABS_API_KEY`
  - `soniox({ model: "stt-rt-v3" })` — `SONIOX_API_KEY`
- **LLM**: one of the typed factories below — each returns a pure
  descriptor; the `@ai-sdk/*` package is only imported by the host-side
  resolver (`host/providers/resolve.ts`), never by the agent bundle:
  - `anthropic({ model })` — `ANTHROPIC_API_KEY`
  - `openai({ model })` — `OPENAI_API_KEY`
  - `google({ model })` — `GOOGLE_GENERATIVE_AI_API_KEY`
  - `mistral({ model })` — `MISTRAL_API_KEY`
  - `xai({ model })` — `XAI_API_KEY`
  - `groq({ model })` — `GROQ_API_KEY`
  - `assemblyAI({ model, region? })` — `ASSEMBLYAI_API_KEY`; routes through
    the [AssemblyAI LLM Gateway](https://www.assemblyai.com/docs/llm-gateway)
    (OpenAI-compatible chat-completions endpoint fronting 25+ models) via
    `@ai-sdk/openai`'s `.chat()` client. `region: "eu"` selects the EU
    endpoint. Same factory name as the STT provider — alias one on import.
- **TTS**: one of
  - `cartesia({ voice })` — `CARTESIA_API_KEY`
  - `rime({ voice })` — `RIME_API_KEY`

The provider SDKs (`ai`, `assemblyai`, `@cartesia/cartesia-js`,
`@ai-sdk/*`, …) are regular dependencies of `@alexkroman1/aai`, but they
are only imported by the host-side openers/resolvers in
`host/providers/` — the descriptor factories in `sdk/providers/` are pure
data, so agent bundles never pull provider SDKs into the guest sandbox.

Each provider defines its `KIND` tag and `<PROVIDER>_API_KEY_ENV`
constant once in its `sdk/providers/{stt,tts,llm}/<name>.ts` module.
Adding a provider means: descriptor factory there, an opener in
`host/providers/{stt,tts}/` (built on the shared session shell in
`host/providers/_utils.ts`), and one registry/switch entry in
`host/providers/resolve.ts`.

### S2S voices

S2S mode selects a voice via the `voice:` field on `agent()`. Available
voices on AssemblyAI's S2S API:

| Voice | Accent | Description |
| --- | --- | --- |
| `ivy` | US | Professional, deliberate, smooth |
| `james` | US | Conversational, professional, male |
| `tyler` | US | Theatrical, energetic, chatty, jagged |
| `winter` | US | Empathetic, aesthetic, conversational |
| `sam` | US | Soft, conversational, young |
| `mia` | US | Smooth, conversational, young |
| `bella` | US | High-pitched, chatty |
| `david` | US | Deep, calming, conversational |
| `jack` | US | Smooth, direct, clear, fast-paced |
| `kyle` | US | Chatty, nasal, expressive |
| `helen` | US | Soft, older, calming |
| `martha` | US | Southern, older, warm |
| `river` | US | Slow, calming, ASMR |
| `emma` | US | Lively, young, conversational |
| `victor` | US | Deep, older |
| `eleanor` | US | Deeper, older, calming |
| `sophie` | UK | Clear, smooth, instructive, simple |
| `oliver` | UK | Narrative, conversational |

### Pluggable storage (KV + Vector)

Each session resolves its `Kv` and `Vector` instances at start. If `agent.ts`
declares `kv:` / `vector:`, the descriptor resolves with the agent's env (BYO
Redis, BYO Pinecone, etc.). If omitted, the platform default is used: Tigris S3
for KV, Pinecone (or in-memory) for Vector.

Both are available to tool `execute` functions via `ctx.kv` and `ctx.vector`
(see `ToolContext` in `packages/aai/sdk/types.ts`).

Provider factories are imported from the `@alexkroman1/aai/kv` and
`@alexkroman1/aai/vector` subpath exports (both resolve to `sdk/providers/`
so they carry no Node.js dependencies and are safe in sandboxed environments).

### Data flow

Audio path depends on the session mode (see above):

- **S2S mode**: user speaks → browser captures PCM → WebSocket → server
  relays audio into a single AssemblyAI S2S socket → agentic loop (LLM +
  tools) runs service-side → synthesized audio streams back through the
  same socket → server forwards to browser → user can interrupt at any
  time (cancels the in-flight turn).
- **Pipeline mode**: user speaks → browser captures PCM → WebSocket →
  server forwards audio to the STT provider → transcript fires
  `onUserTranscript` → host runs the LLM loop locally via `streamText`
  (tool calls execute on the host just like S2S mode) → assistant text
  chunks stream into the TTS provider → synthesized audio returns over
  the client WebSocket → interrupts cancel the in-flight LLM stream and
  TTS playback.

## Conventions

- **Runtime**: Node (host/platform server), Deno (guest sandbox runtime)
- **Frameworks**: React (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Linting**: Biome. Auto-runs on staged files via lefthook pre-commit hook.
- **Exports**: In dev mode, package.json exports point to `.ts` source for
  seamless workspace resolution. Update to compiled `.js` dist paths before
  publishing.

### File naming conventions

| Pattern | Meaning | Example |
| --- | --- | --- |
| `_foo.ts` | **Internal module** — not part of the public API. Never import cross-package. Biome's `noPrivateImports` rule enforces this at lint time. | `_utils.ts`, `_bundler.ts`, `_internal-types.ts` |
| `foo-barrel.ts` | **Barrel re-export file** — aggregates exports from multiple modules into one subpath export. Has `biome-ignore` for `noReExportAll`. | `runtime-barrel.ts`, `manifest-barrel.ts` |
| `foo.test.ts` | **Unit test** — co-located with source. Runs via `pnpm test`. | `session.test.ts` |
| `foo.test-d.ts` | **Type-level test** — checked by tsc, never executed at runtime. Uses `expectTypeOf`. | `types.test-d.ts` |
| `_test-utils.ts` | **Test helpers** — each package has its own with different utilities (see below). | `host/_test-utils.ts` |

### `_test-utils.ts` per package (not interchangeable)

Each package has distinct test helpers tailored to its domain:

- **`aai/host/_test-utils.ts`** — `flush()` (microtask yield), `makeTool()`,
  `makeAgent()`, `makeConfig()`, fixture replay helpers for S2S mocking
- **`aai-cli/_test-utils.ts`** — `withTempDir()` (temp dir + cleanup),
  `silenceSteps()`, `fakeDownloadAndMerge()`, `makeBundle()`
- **`aai-ui/_react-test-utils.ts`** — `createMockSessionCore()`,
  `MockAudioContext`, `installAudioMocks()`
- **`aai-server/test-utils.ts`** — (no underscore) `createMockKv()`,
  `createTestStore()` (in-memory BundleStore)

### `@dev/source` custom export condition

Package.json exports use a custom `@dev/source` condition so that
TypeScript source (`.ts`) is resolved during development, while compiled
`.js` dist paths are used in production:

```jsonc
// package.json
"exports": {
  ".": {
    "@dev/source": "./index.ts",     // ← resolved in dev (via tsconfig)
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"      // ← resolved in production
  }
}
```

This is enabled by `customConditions: ["@dev/source"]` in the root
`tsconfig.json`. During dev, imports like `import { X } from "@alexkroman1/aai"`
resolve directly to `.ts` source — no build step needed.

### Import rules

- **Cross-package imports** must use the npm package name (e.g.
  `import { X } from "@alexkroman1/aai/protocol"`), never relative paths between
  packages. Biome's `noRestrictedImports` enforces this.
- **Internal modules** (`_*.ts`) must not be imported from outside their
  own package. Biome's `noPrivateImports` enforces this.
- **Re-exports**: barrel files use `export * from "..."` with explicit
  `biome-ignore` comments. Follow re-export chains to find the original
  source of a type/function.

### Disambiguating "Session" types

Multiple types named `Session` or `Session*` exist across packages —
they are **not interchangeable**:

| Type | Package | File | Purpose |
| --- | --- | --- | --- |
| `SessionCore` | `aai` | `host/session-core.ts` | Server-side session — bridges a `Transport` (S2S, pipeline, or OpenAI Realtime) to the client protocol |
| `SessionCoreOptions` | `aai` | `host/session-core.ts` | Config for creating the server-side session core |
| `SttSession` / `TtsSession` | `aai` | `sdk/providers.ts` | Host-side handle to one open STT/TTS provider stream (pipeline mode) |
| `SessionCore` | `aai-ui` | `session-core.ts` | Framework-agnostic browser session (WebSocket + audio + state) |
| `SessionSnapshot` | `aai-ui` | `session-core.ts` | Immutable snapshot of browser session state (for `useSyncExternalStore`) |
| `SessionError` | `aai-ui` | `types.ts` | Client-side error type with error code |

When searching for "Session", narrow by package to find the right one.

### Subpath export → file mapping

Tracing imports through barrel files can be confusing. Here's the map
of subpath exports in `aai/package.json`:

| Import path | Resolves to | What it contains |
| --- | --- | --- |
| `@alexkroman1/aai` | `packages/aai/index.ts` → 6 modules | Types, KV, utils, constants, `agent()`/`tool()` helpers |
| `@alexkroman1/aai/runtime` | `host/runtime-barrel.ts` → 11 modules | Full Node.js runtime: session, S2S, server, tools, WS handler |
| `@alexkroman1/aai/protocol` | `sdk/protocol.ts` (direct, not a barrel) | Wire-format Zod schemas, `lenientParse()`, `ClientEvent`, `ServerMessage` |
| `@alexkroman1/aai/manifest` | `sdk/manifest-barrel.ts` → 3 modules | `parseManifest()`, `toAgentConfig()`, `agentToolsToSchemas()`, system prompt builder |
| `@alexkroman1/aai/stt` | `host/providers/stt-barrel.ts` | STT provider factories + types (`assemblyAI`, `deepgram`, `elevenlabs`, `soniox`) |
| `@alexkroman1/aai/llm` | `host/providers/llm-barrel.ts` | LLM provider factories + types (`anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`) |
| `@alexkroman1/aai/tts` | `host/providers/tts-barrel.ts` | TTS provider factories + types (`cartesia`, `rime`) |
| `@alexkroman1/aai/kv` | `sdk/providers/kv-barrel.ts` | KV provider factories + types (`memoryKv`, `fsKv`, `s3Kv`, `redisKv`) |
| `@alexkroman1/aai/vector` | `sdk/providers/vector-barrel.ts` | Vector provider factories + types (`pinecone`, `inMemoryVector`) |

### Default values and magic numbers

All numeric constants live in `packages/aai/sdk/constants.ts`. Key
defaults that affect agent behavior:

| Default | Value | Where applied | Notes |
| --- | --- | --- | --- |
| `maxSteps` | 5 (`DEFAULT_MAX_STEPS`) | `constants.ts` | Max tool calls per reply. Prevents runaway tool loops. |
| `toolChoice` | `"auto"` | `manifest.ts:59` | LLM decides when to use tools vs respond directly. |
| `idleTimeoutMs` | 300,000 (5 min) | `constants.ts:26` | `0` or non-finite disables the timer entirely. |
| `maxHistory` | 200 | `constants.ts:52` | Sliding window of conversation messages retained. |
| `builtinTools` | `[]` | `manifest.ts:57` | No built-in tools enabled by default. |

### Fixed release coupling

`aai`, `aai-ui`, and `aai-cli` are in a **fixed release group** (configured
in `.changeset/config.json`). A changeset for any one of them bumps all
three to the same version. Keep this in mind when creating changesets —
you only need to list one package.

### Testing

- **Vitest**. Test files co-located: `foo.ts` → `foo.test.ts`.
- Unit test projects (aai, aai-ui, aai-cli, aai-server) are defined in the
  root `vitest.config.ts`. Use `--project <name>` to run a specific project.
- Slow/integration tests have separate per-package configs
  (`vitest.slow.config.ts`, `vitest.integration.config.ts`) to avoid running
  during `vitest run`.
- In tests, use `flush()` from `_test-utils.ts` instead of
  `await new Promise(r => setTimeout(r, 0))` to yield to microtasks.
- Use `vi.waitFor()` instead of arbitrary delays when polling for async results.
- Type-level tests use `.test-d.ts` files with `typecheck: { only: true }`
  — they are checked by tsc but never executed at runtime. Use
  `expectTypeOf` from vitest to assert on type shapes. Projects:
  `aai-types`.
- **Package validation**: `publint` runs post-build to verify package.json
  exports resolve to real files. `attw` validates export types. Both run
  in the check pipeline.
- **Coverage**: `pnpm test:coverage` (root or per package) runs vitest with
  v8 coverage and enforces the per-package threshold ratchet (see
  "Quality ratchets" above). CI runs it for every package in the test
  matrix, so a PR that drops coverage below a package's floor fails.

#### Vitest config differences per package

| Package | Pool | Environment | Special setup | Notes |
| --- | --- | --- | --- | --- |
| aai | threads (default) | node | — | Excludes pentest, sandbox, integration tests; `restoreMocks: true` |
| aai-ui | threads | **jsdom** | `_jsdom-setup.ts` (stubs `scrollIntoView`) | `globals: true` so `describe`/`test`/`expect` don't need imports |
| aai-cli | threads | node | — | `restoreMocks: true` |
| aai-server | **forks** | node | — | Forks for process isolation; excludes integration/load/adversarial |
| aai-templates | threads | node | — | Only matches `templates/*/agent.test.ts` |

#### Test environment variables

Tests can behave differently based on environment variables set in
package.json scripts (not always obvious from test code alone):

- `VITEST_PROFILE` — switches timeout/retry profiles in
  `vitest.slow.config.ts`: `integration` (30s), `e2e` (300s),
  `docker` (600s), `gvisor` (30s)
- `VITEST_INCLUDE` — filters which test files to include
- `VITEST_POOL` — can override pool strategy at runtime

#### Fixture replay testing (aai/host)

Tests in `packages/aai/host/` use a **hybrid mock** pattern: a real
`Runtime` and tool executor with mocked S2S WebSocket connections. JSON
fixtures in `host/fixtures/` contain recorded AssemblyAI API messages
that are replayed through the real orchestration layer. Key helpers:

- `makeMockHandle()` — creates mock S2S WebSocket using nanoevents
- `replayFixtureMessages()` — dispatches fixture JSON as typed events
- `createFixtureSession()` — wires a real Runtime to mocked S2S

### Changesets

This repo uses [@changesets/cli](https://github.com/changesets/changesets)
to track version bumps. Every PR that changes code in `packages/` **must**
include a changeset file (enforced by the pre-push hook).

**Creating a changeset (interactive — preferred for humans):**

```sh
pnpm changeset          # Prompts for packages + bump type + summary
```

**Creating a changeset (non-interactive — for agents/CI):**

```sh
pnpm changeset:create --pkg @alexkroman1/aai --bump patch --summary "Fix typo in error message"
```

Multiple packages:

```sh
pnpm changeset:create --pkg @alexkroman1/aai --pkg @alexkroman1/aai-ui --bump minor --summary "Add new session API"
```

If the change doesn't need a release (docs-only, config, tests):

```sh
pnpm changeset add --empty
```

**Changeset file format** (`.changeset/<random-name>.md`):

```yaml
---
"@alexkroman1/aai": patch
---

Short summary of the change for the changelog.
```

Valid bump types: `patch` (bug fixes), `minor` (new features), `major`
(breaking changes).

**Fixed packages:** `@alexkroman1/aai`, `@alexkroman1/aai-ui`, and
`@alexkroman1/aai-cli` release together (configured in
`.changeset/config.json`). You only need to list one; the others are
bumped automatically.

**Checking status:** `pnpm changeset status --since=origin/main`

### Related docs

- **Templates**: `packages/aai-templates/templates/` contains agent
  scaffolding templates (simple, web-researcher, etc.). Each is
  self-contained with its own `agent.ts` and optional `client.tsx`.
  `scaffold/` has base project files (package.json, tsconfig,
  etc.) layered underneath.

### Git hooks (lefthook)

- **pre-commit**: runs `biome check --write` on staged files and
  `syncpack lint` when package.json changes.
- **pre-push**: blocks pushes to main/master, **blocks pushes when branch
  is behind origin/main** (must rebase first), checks for merge conflicts
  with main, **verifies changeset exists for changed packages**, and runs
  `pnpm check`.

### Worktree gotchas

- Run `unset GIT_DIR` before `pnpm changeset status` in worktrees
  (lefthook sets GIT_DIR which confuses changeset's repo detection).
- Always use `pnpm install --frozen-lockfile` in worktrees to avoid
  modifying the lockfile. Fall back to `pnpm install` only if frozen
  fails (new deps added on the branch).
- Never edit `pnpm-lock.yaml` directly — always use `pnpm install`.

### gVisor notes

- gVisor integration tests run via: `./packages/aai-server/guest/docker-test.sh`
- No KVM required — uses systrap platform (works on Fly.io, any Linux)
- Docker needs `--security-opt seccomp=unconfined` for gVisor
- On macOS (dev), gVisor is unavailable; sandbox falls back to a plain child
  process with no isolation. This is expected — the security boundary only
  applies in Linux production deployments.

### Updating CLAUDE.md

When you make changes that affect architecture, security model, conventions,
or gotchas, update this file.

## PR workflow

**Default:** When finishing a development branch, always push and create a
Pull Request (don't ask — just do it).

**Before pushing**, rebase on the latest `main` to avoid merge conflicts:

```sh
git fetch origin main
git rebase origin/main
```

The pre-push hook will automatically check for conflicts with `main` and
block the push if any are found. This prevents PRs from being opened with
merge conflicts.

Run `pnpm check:local` **before your first commit** on a PR branch. This
catches the most common issues that historically required follow-up commits:

1. **Syncpack version drift**: When bumping a dependency, also update
   `packages/aai-templates/scaffold/package.json` if it has the same dep.
   `pnpm check:syncpack` catches this.
2. **Test assertion mismatches**: After changing output formats or error
   messages, run `pnpm test` and update affected assertions.
3. **Lint in related files**: Pre-commit only lints staged files. Run
   `pnpm lint` to catch lint issues in files affected by your change.
4. **Type-level tests**: After changing public API types (`parseManifest`,
   `Manifest`, etc.), run `pnpm vitest run --project aai-types`
   to verify type contracts haven't regressed. Update `.test-d.ts` files
   if the change is intentional.

## Security architecture

### gVisor sandbox isolation

Each agent session runs in its own **gVisor sandbox** (runsc OCI runtime).
The guest runs a Deno process executing the bundled agent code
(`guest/deno-harness.ts`). Host↔guest communication is via NDJSON over
stdio.

Key properties:

- **Userspace kernel**: gVisor Sentry intercepts all syscalls in systrap mode.
  No KVM required — works on Fly.io, any Linux.
- **No shared memory between agents**: separate Sentry per sandbox.
- **Minimal rootfs**: only the Deno binary and harness are visible.
  The agent cannot see the host filesystem.
- **cgroup limits**: 64 MB memory, 32 PIDs per sandbox.
- **Deno guest**: the agent's ESM bundle is loaded directly by Deno.
  Deno's permission model provides defense-in-depth: the harness runs
  with `--allow-env --no-prompt` and no net/fs/run permissions.
- **Dev mode (macOS)**: gVisor unavailable; sandbox falls back to a plain
  child process with no isolation.

### Warm sandbox pool

The server can pre-spawn a pool of "warm" Deno harnesses (process running,
NDJSON wired, no bundle loaded) so first-session cold starts skip the
slow `spawn → JIT init → gVisor bootstrap` path. On acquire, the
harness is finalized for the requesting agent by registering KV/fetch
handlers and sending `bundle/load` — a single round-trip.

- **Enable**: set `SANDBOX_POOL_SIZE` to a positive integer (max 16).
  Disabled when unset.
- **Files**: `sandbox-pool.ts` (pool), `sandbox-vm.ts:spawnWarmHarness`
  (backend-agnostic spawn), `configureSandbox` (per-agent finalization).
- **Security**: the pool spawns harnesses with the same OCI spec / dev
  config as on-demand sandboxes. Bundle code and agent env vars are
  injected per-acquire — no agent secrets enter a warm process.
- **Failure mode**: if the pool is empty or returns a dead harness,
  `createSandboxVm` falls back to a fresh spawn (the pre-pool path).

### Platform sandbox (aai-server)

Agent code runs in **per-agent gVisor sandboxes**. Key files:
`packages/aai-server/sandbox.ts`, `sandbox-vm.ts`, `gvisor.ts`,
`guest/deno-harness.ts`, `ndjson-transport.ts`.

**Isolation layers:**

- **Filesystem**: minimal rootfs with only Deno binary + harness. No host
  filesystem access.
- **Network**: no network device in sandbox. All external calls proxy through host.
- **Memory**: cgroup limits (64 MB per sandbox). Separate Sentry per sandbox.
- **Env vars**: agent env is delivered to the guest via the `bundle/load`
  RPC params, never as process environment variables. Platform secrets
  stay host-side.

**Credential separation:**

Each agent provides its own `ASSEMBLYAI_API_KEY` via `.env` (local dev) or
`aai secret put` (production). There is no central/platform-owned key.
`SandboxOptions` has separate `apiKey` (host-only, for S2S connections) and
`agentEnv` (forwarded to guest) fields. The key is extracted from the agent's
stored env at sandbox creation time and kept host-side only.

- **Vector store**: `PINECONE_API_KEY` is platform-owned by default. Agents
  that declare `vector: pinecone(...)` use their own key via
  `aai secret put PINECONE_API_KEY=...`.
- **KV store**: same model — platform default uses platform creds; agent
  descriptors (`redisKv`, `s3Kv`) read from agent env (`REDIS_URL`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).

**Cross-agent isolation:**

- KV keys prefixed `kv:{keyHash}:{slug}:{key}` — agents cannot access
  each other's data.
- Each sandbox communicates via isolated NDJSON over stdio.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

**`run_code` built-in tool (aai/builtin-tools.ts):**

- Each invocation runs in a **fresh `node:vm` context** on the host — isolated
  from other invocations. Note: `node:vm` is not a security sandbox; the
  gVisor sandbox provides the actual security boundary.
- No network, no filesystem access, no child processes, no env vars.
- 5-second execution timeout.
- Context is discarded after execution — no state leaks.

**SSRF protection (aai-server/ssrf.ts):**

- `assertPublicUrl()` uses the `bogon` library for private IP ranges.
- Handles IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`).
- Blocks `.internal`, `.local`, cloud metadata hostnames.

**Auth:**

- API key hashes compared with `timingSafeEqual` (constant-time).
  Keys are SHA-256 hashed and cached; slug ownership is verified
  against stored credential hashes.
- Stored credentials (agent env vars / secrets) are AES-256-GCM
  encrypted with HKDF-derived keys.

### Testing security boundaries

- `gvisor-integration.test.ts` — sandbox isolation e2e: network, filesystem,
  process, env isolation inside gVisor sandboxes. No KVM required.
  Run via: `./packages/aai-server/guest/docker-test.sh`
- `sandbox-integration.test.ts` — sandbox lifecycle and slot management e2e.
  Run: `pnpm --filter aai-server test:integration`
- `builtin-tools.test.ts` — `run_code` sandbox security boundaries
  (network, filesystem, process, env, constructor chain bypass,
  cross-invocation isolation).
- `net.test.ts` / `ssrf-extended.test.ts` — SSRF bypass prevention
  (IPv4-mapped IPv6, cloud metadata, `.internal` domains).

### Known limitations

- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`)
  and `aai-ui` (`.`). Subpath exports (e.g. `./kv`,
  `./protocol`) are not covered by type tests.
