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
| Integration | `pnpm test:integration` | Real subsystems (HTTP servers, WebSockets) | 30s |
| E2E | `pnpm test:e2e` | Full process spawn + Playwright browser | 300s |
| Templates | `pnpm test:templates` | Template agent example tests | 5s |

#### Mutation testing (Stryker)

`pnpm test:mutate` (or a scope: `test:mutate:{sdk,host,server,cli}`, configs
`stryker.*.config.mjs` at the root). Not a gate — nothing in `check.sh` or CI
runs it; reach for it when deciding whether a suite's assertions are real.

**A run EDITS THE WORKING TREE.** TypeScript 7 dropped the JS API Stryker's
tsconfig preprocessor calls, so the base config sets `inPlace: true` to skip
it — mutants are written into the actual source files and restored from
`.stryker-tmp/backup-*` when the run ends. Never run vitest, edit source, or
commit while one is in flight, and never launch one in the background.

### Single-package shortcuts

```sh
pnpm test:aai-core       # Run only aai unit tests
pnpm test:aai-ui         # Run only aai-ui unit tests
pnpm test:aai-cli        # Run only aai-cli unit tests
pnpm test:aai-server     # Run only aai-server unit tests
pnpm test:aai-studio-client  # Run studio front-end unit tests
pnpm test:aai-studio-server  # Run studio service unit tests
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

Turbo runs tasks in **strict env mode**, so proxy/CA variables
(`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, …) are listed in
`globalPassThroughEnv` in `turbo.json` — passed through to tasks but kept
out of cache hashes. Without this, any task that makes real network calls
(the e2e suite's verdaccio→npmjs uplink) silently loses its egress config
in proxied environments and fails with misleading errors (instant
`ERR_PNPM_FETCH_404`s) that only reproduce under `turbo run`, never when
running the underlying script directly.

`pnpm check:local` uses the same script with `--local` flag, running a
subset: build, typecheck, lint, publint, syncpack, sherif, knip, test —
all in one turbo call with `--continue` (shows all failures at once).

`pnpm check:affected` uses turbo's `--affected` flag to only run tasks
for packages changed since the default branch.

Three gates in the full run are easy to miss because they sit outside the
turbo graph and outside the ratchets below:

- **`pnpm check:markdown`** — markdownlint over every `.md` in the repo
  (CLAUDE.md included). In `check.sh`'s full mode and in CI, not in
  `check:local`, so a docs-only edit passes locally and fails on push.
- **`pnpm check:template-types`** — type-checks every template under the
  SCAFFOLD's tsconfig, i.e. what `aai init` really produces, against the
  PUBLISHED types. Runs after build for that reason; the repo's own strict
  config is a different compiler and hides real template bugs.
- **`pnpm check:gateway-models`** — re-probes the AssemblyAI gateway's
  `/v1/models` (both regions) and diffs it against the committed catalog.
  Needs network + a key, so it is standalone, not in `check.sh`. Regenerate
  with `scripts/gen-gateway-models.mjs` rather than hand-editing the list.

### Quality ratchets

Beyond lint/typecheck/test, `scripts/check.sh` **and the CI check job** run
two **ratchet gates** (both also runnable standalone) that hold the line on
technical debt by comparing the branch against its merge-base with
`origin/main`. They must stay wired into BOTH: for a long time they lived
only in `check.sh`, which CI never invokes, so the only thing enforcing them
was the pre-push hook — and `git push --no-verify` skipped them entirely.

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
Every package has floors — `aai-templates` was for a while the one that did
not, so CI measured its coverage and threw the number away. Each package's
`vitest.config.ts` declares per-package coverage floors
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

Eight workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: agent config, types, protocol, S2S, session, Db |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (React 19): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, list, pull, push, publish, delete, login, secret, storage, templates (`deploy` is hidden/internal — the mechanism in-guest Publish runs) |
| `packages/aai-guest/` | `aai-guest` | Guest sandbox harness (private): the Node entrypoint that runs the complete agent inside each Modal Sandbox, built into one self-contained `dist/harness.mjs` |
| `packages/aai-server/` | `aai-server` | Agent service + shared platform core (private): sandbox, auth, SSRF, stores, locks |
| `packages/aai-studio-server/` | `aai-studio-server` | Studio service (private): browser coding agent, workspace builds, combined entry |
| `packages/aai-studio-client/` | `aai-studio-client` | The studio's browser front-end (private): Vite React app served by aai-server |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |

**Dependency flow:** `aai-cli`, `aai-ui`, `aai-guest`, and `aai-server` all
depend on `@alexkroman1/aai` (via `workspace:*`). `aai-server` depends on
`aai-guest` only to resolve its built artifact (`aai-guest/harness` →
`dist/harness.mjs`, baked into the guest snapshot image) — it never imports
guest source, and the guest never imports server code; that hard boundary is
the reason the guest is its own package. The one edge to the CLI is
`aai-server` → `aai-cli`, and only for its three public build-hook subpaths
(`/worker-bundler`, `/client-bundler`, `/typecheck`): the studio builds
workspaces through the CLI's own Vite pipeline (and typechecks them with the
CLI's own gate) rather than carrying a second bundler. Do not widen it —
nothing else in the server may import from the CLI, and the CLI must never
import from the server.

**Publishable packages must use the `@alexkroman1/` scope.** The unscoped
names `aai`, `aai-ui`, `aai-cli` are taken on npm by other publishers —
publishing under those names returns 404. The `scripts/check-publish-names.mjs`
script enforces this at CI time.

### Per-package guides

**This file holds only what is true repo-wide.** Everything package-specific —
key files, invariants, and the failure each one came from — lives beside the
code, and loads when you work in that directory:

| Guide | Covers |
| --- | --- |
| [packages/aai](packages/aai/CLAUDE.md) | SDK structure, session modes, providers, voices, `ctx.db`, `ctx.generate`, guest network access, the defaults table, self-hosted server defaults |
| [packages/aai-ui](packages/aai-ui/CLAUDE.md) | Browser client key files, the client audio path (jitter buffer, pacing, capture) |
| [packages/aai-cli](packages/aai-cli/CLAUDE.md) | CLI key files, credential destinations |
| [packages/aai-guest](packages/aai-guest/CLAUDE.md) | The harness: its modes, and the agent-guests-are-servers contract |
| [packages/aai-server](packages/aai-server/CLAUDE.md) | Platform sandbox, Modal notes, split services, stateless server, sandbox isolation + security-boundary tests |
| [packages/aai-studio-server](packages/aai-studio-server/CLAUDE.md) | The browser studio end to end, one studio sandbox per project |
| [packages/aai-studio-client](packages/aai-studio-client/CLAUDE.md) | The studio front-end's panes |

Cross-file references below name the guide, e.g. *see "Modal sandbox notes"
in [aai-server](packages/aai-server/CLAUDE.md)*. When a section moves, its
inbound references have to move with it — that is the cost of the split, and
the reason to keep sections whole rather than splitting one across files.

### Package exports

#### `aai` (shared core SDK)

Subpath exports consumed by sibling packages and user agents:

- `.` — `agent()`, `tool()` helpers, `Db`, types, utils, constants
- `./utils` — zod-free utilities + platform slug contract (fast CLI startup path)
- `./runtime` — full Node.js runtime engine (barrel → 11 host/ modules)
- `./protocol` — wire-format Zod schemas, `lenientParse()`, `ClientEvent`
- `./manifest` — `toAgentConfig()`, `agentToolsToSchemas()`, config schemas
- `./stt` — pipeline-mode STT provider factories (e.g. `assemblyAIStt`)
- `./llm` — pipeline-mode LLM provider factories (e.g. `anthropic`)
- `./tts` — pipeline-mode TTS provider factories (e.g. `cartesia`)
- `./s2s` — S2S provider factories (`openaiRealtime`)
- `./tools` — keyless network builtins callable from user tool code
- `./internal` — infrastructure shared with sibling packages (epochs,
  owned maps, WS upgrade parsing, schema-issue formatting); not a public
  API, kept off the root barrel so authoring autocomplete stays small.
  The env brands live on `./runtime` instead — they appear in its public
  signatures (`RuntimeOptions`, `withHostCredentialFallback`)

#### `aai-ui` (UI)

- `.` — default React UI component + session + client helpers
- `./styles.css` — default styles
- `./default-client/*` — prebuilt default client assets (`dist/default-client/`)

#### `aai-cli` (CLI)

Binary: `aai` — subcommands: init, dev, test, build, list, pull, push,
publish, delete, login, secret, storage, templates.

**There is no user-facing deploy.** Source always flows through the studio
workspace and production always comes from Publish: `aai push` replaces the
linked project's workspace file map atomically
(`PUT /studio/projects/:project/source`, fast-forward-checked against the
`studioSourceHash` recorded in `.aai/project.json` — a 409 means the studio
edited since the last pull; `--force` overwrites), `aai publish` pushes then
runs the studio's Publish route (the in-sandbox `aai deploy`), syncing
`.env` into the agent's secrets via the standard secret routes (before the
deploy when the slug already exists, after it on a first publish), and
`aai pull <project>` materializes a workspace locally, layering the shipped
scaffold underneath (never overwriting workspace files) so the result runs
under `aai dev`. `aai delete` in a linked directory deletes the STUDIO
PROJECT (`DELETE /studio/projects/:project`), which cascades server-side to
the workspace, chat, and the project's deployed + preview agents — and
CLEARS the link fields from `.aai/project.json`, keeping `serverUrl`. Left
behind, they sent the next push a `baseHash` for a project that no longer
existed: a 409 whose hint said to run `aai pull`, which then failed with
"No studio project named …", so only `--force` recovered. The
hidden `deploy` subcommand remains only because the guest's Publish
(`aai-guest/studio-publish.ts`) executes it; a bare `aai` in a project
offers to publish, and `aai init` publishes after scaffolding.

**A workspace carries UTF-8 text only.** Both snapshots — the CLI's
`collectSourceFiles` and the guest's `snapshotWorkspace` — decode with
`TextDecoder({ fatal: true, ignoreBOM: true })` and SKIP a file that isn't
valid UTF-8, warning by name, exactly as the byte cap does. The file map is
JSON, so a lossy `"utf-8"` read turned a pushed PNG into U+FFFD while
reporting success, and a later `aai pull` wrote the mangled bytes back over
the local original. `ignoreBOM` is load-bearing: the decoder strips a leading
BOM by default, so the check meant to stop corruption would introduce a
smaller version of it. Skipped files also ride the JSON result as `warnings`,
because `log.warn` is silenced in JSON mode and JSON mode is auto-detected on
a pipe — a scripted push otherwise reported plain success while having
replaced the workspace with a truncated tree.

**A `*-preview` project name is refused** (`projectNameFromDir` returns
null). Publishing deploys under the project's own name, so such a project
would claim a slug the orphan-preview sweep reaps hourly — taking the agent,
its app-database schema, and its secrets with it. See the `-preview` note in
"Modal sandbox notes" ([aai-server](packages/aai-server/CLAUDE.md)) for the
matching deploy-boundary rule.

### Dev/prod parity

**The guest IS the dev server — and the runtime IS the user's.** The
harness wraps the same `createServer` (`aai/host/server.ts`) that `aai dev`
runs — health, `client-config`, and `/websocket` sessions — adding (per
mode) the `/manage/*` request hook or the `/ws` control channel, plus a
lazy runtime facade (`lazyRuntime` in `aai-guest/harness.ts`: the runtime
is built on the first session — inspection loads carry an empty env).
The runtime itself comes from the BUNDLE (see "User-shipped runtime"
below), so dev and prod run the identical SDK version: the one in the
user's lockfile. In agent and describe modes the bundle is read from a
file delivered at exec time (hash-verified in agent mode); the studio's
test_agent loads its build in-guest through the same loader. Either way it
loads from a temp-file `file:` URL.

### User-shipped runtime

The worker bundle ships its own SDK runtime. `buildWorker`'s generated
wrapper entry exports `__aaiCreateRuntime` — a factory over the *user's
installed* SDK's `createRuntime`, bundled in with the provider SDKs (an SSR
Vite build: server resolve conditions, `node:` builtins external, dynamic
imports inlined via `codeSplitting: false`) — and the harness builds every
session through it. The harness embeds no runtime at all, so **platform SDK
drift can never break a deployed agent**: it runs exactly the runtime
version it was built and tested against, the same one `aai dev` ran.

- The harness↔bundle contract is deliberately tiny (`CreateGuestRuntime` in
  `aai-guest/harness-types.ts`): `{ env, db?, runCode? }` in,
  `{ startSession, shutdown }` out. Keep it that way — everything else
  (provider resolution, tool dispatch, session state) is the bundle's SDK's
  business, on the bundle's SDK's version.
- A bundle without the factory is rejected at load ("rebuild with a
  current @alexkroman1/aai-cli"); there is no embedded-runtime fallback.
- Deploy artifacts are therefore ~8 MB minified before user code
  (`MAX_WORKER_SIZE` is 30 MB), and `evalWorkerBundle` imports workers via
  a temp `file:` URL — the bundled runtime's CJS interop calls
  `createRequire(import.meta.url)`, which rejects `data:` URLs.
- The dev server passes `runtime: false` to `buildWorker`: it builds its
  runtime in-process from the same installed SDK anyway, and inlining the
  runtime on every watch rebuild would make reloads multi-second.
  `aai build` / `aai deploy` / studio builds always ship it.

**Known remaining asymmetries**, none closable without larger work:

| Divergence | Direction | Why it stands |
| --- | --- | --- |
| Modal memory/CPU limits (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) | works in dev, fails in prod | `aai dev` runs tools in the host process with no caps; a memory-hungry tool OOMs only when deployed. |
| `run_code` | fails in dev, works in prod | The host-side guard refuses rather than evaluating in-process. Fail-closed, so harmless. |
| `withHostCredentialFallback` (`providers/host-env.ts`) | works in dev, fails in prod | Deliberate ergonomic: an exported `ANTHROPIC_API_KEY` should work for `aai dev`. Two guards keep the cliff visible: the dev server warns when a required key resolved from the shell only (`agentEnvWarnings` in `_dev-server.ts` — it won't survive `aai deploy`, which uploads `.env`), and the deploy core preflights required credentials (below), so the failure surfaces at deploy time, not as an auth error at first session. |
| `ctx.db` backing (BYO `DATABASE_URL` in dev vs platform-provisioned schema+role) | prod is stricter | Dev connects wherever the developer points it; prod pins search_path + statement_timeout on a per-app role. |
| Platform sandboxes need Modal credentials in production only | prod is stricter | `aai dev` runs tools in-process; the platform spawns real Modal sandboxes in production (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`), and an isolation-free child process in local dev — see "Modal sandbox notes" in [aai-server](packages/aai-server/CLAUDE.md). |

**Deploy-time credential preflight** (`missingCredentials` in
`aai-server/deploy.ts`). The classic dev/prod credential failure — an agent
that ran locally on shell-exported keys dies at first session start after
deploy with what looks like a provider outage — is caught at the deploy
boundary instead. The required key set is derived from the bundle's
self-described config (never from anything a client sent):
`requiredProviderEnvVars` over the stt/llm/tts/s2s descriptors (the same
registry-backed derivation the runtime resolves keys with) plus the agent's
declared `requiredEnv` (an `agent()` field for custom keys tools read from
`ctx.env`, which no static derivation can see). A key whose merged stored
value is absent or empty fails `POST /deploy` with a 400 naming the keys
(`credentialPolicy: "require"`, the default). The studio deploys with
`credentialPolicy: "warn"` instead — it has no secrets UI, so a hard failure
would leave its user with no path to publish at all; the warning rides back
on the deploy response. The check runs before any side effect, so a rejected
deploy leaves the live sandbox untouched.

**One canonical config schema, deny-list boundaries.** The dropped-field bug
family (`builtinTools` — deployed agents silently lost the default cognitive
builtins; `send`; the provider triple) all came from
allow-list mappers re-declaring the config field list, where every field is
optional and an omission is valid TypeScript. Every such bug presents as a
*working* agent quietly ignoring part of its own config. The design is now
inverted — one canonical serializable schema flows CLI → server → runtime
unchanged, and each boundary subtracts an explicit deny-list instead of
copying fields:

- **`AgentConfigSchema`** (`sdk/_internal-types.ts`) is the canonical shape.
  `toAgentConfig` strips `HOST_ONLY_AGENT_FIELDS` (`tools`, `state`) plus
  undefined values and validates through the schema — no per-field copies.
  `_internal-types.test.ts` asserts the one subtraction:
  `Exclude<keyof AgentDef, keyof AgentConfig | HostOnlyAgentField>` is `never`.
- **`agent()`** derives its parameter shape from `AgentDef`
  (`AgentParams` = `Omit` + `Partial<Pick>` of the defaulted fields) plus
  three author-only conveniences `agent()` normalizes away (`system` as an
  alias of `systemPrompt`, `llm` accepting a gateway model-id string —
  `sdk/providers/llm/from-string.ts` — and `voice` desugaring to
  `tts: assemblyAITts({ voice })`), instead
  of re-declaring it inline — the inline form is how `send` and `state`
  shipped as runtime-working but excess-property errors for authors
  (neither bundler typechecks user code). `define.test-d.ts` locks this.
- **`IsolateConfigSchema`** (`aai-server/rpc-schemas.ts`) is
  `AgentConfigSchema.extend({...})` — the extensions are wire-tolerance
  loosenings, wire defaults, and the wire-only `toolSchemas`; none may drop
  a field. It runs at **deploy time only** (`validateAgentConfig`), on the
  current CLI's freshly extracted config.
- **Stored configs are FULLY OPAQUE on reads** (`StoredAgentConfigSchema` in
  `aai-server/agent-store.ts` — a bare record): the host has NO field-level
  reader left. Even the broker's `name`/`greeting` are PROXIED from the
  guest's own `/client-config` (the bundle's live agent definition,
  interpreted by the bundle's own SDK — see client-config-handler.ts), so a
  platform schema change can never re-interpret a deployed agent. A stored
  config is never re-validated against a newer schema, so tightening
  `IsolateConfigSchema` cannot 404 previously-valid deployed agents.
  Never add fields or refinements to the stored schema — strictness belongs
  at the deploy boundary.
- **The server never maps a stored config onto a runtime agent.** The old
  `toRuntimeAgent` boundary (`sandbox-agent-config.ts`) is gone with platform
  host mode — sessions run the bundle's own SDK on the bundle's own agent
  definition, so there is no server-side config→agent mapping left to drop
  fields at. (Historical context, kept because the bug class recurs: provider
  descriptors must be keyed off their own presence, never the optional
  `config.mode` — a config carrying all three providers with no `mode` once
  hit a `config.mode === "pipeline"` gate and lost every one of them, so the
  runtime resolved S2S and ran a healthy S2S session on the agent's own key,
  nothing logged. `superRefine` still rejects a `mode` that disagrees with
  the descriptors.) `rpc-schemas.test.ts` asserts the remaining subtraction:
  `Exclude<keyof AgentConfig, keyof IsolateConfig>` is `never`.

A new serializable agent field therefore needs exactly two edits — `AgentDef`
(docs + type) and `AgentConfigSchema` (shape) — and the type guards fail
loudly if either half is missing; no mapper edits, and the field reaches the
server, the wire, and the runtime by default.

**Never let S2S be a fallback.** The pipeline-by-default flip closed most of
this structurally: a config that loses its providers now gets the AssemblyAI
pipeline injected (`defaultProviders`), not a silent S2S session, and S2S
requires an explicit `s2s` descriptor. There is no fallthrough left —
`buildTransport` (`host/runtime-transport.ts`) throws on a descriptor-less
config whose pipeline providers didn't resolve (the pre-flip legacy fallback
to `buildAssemblyS2sTransport` was removed). Two rules keep mode
diagnosable: forward providers based on their own presence (above), and
`createRuntime` logs `"Session mode resolved"` once per runtime with the mode
and provider kinds — "which transport is this agent on" must be answerable
from one log line rather than inferred from the shape of the message stream
(`S2S <<` prefixes).

### Data flow

On the platform, the browser's session WebSocket connects DIRECTLY to the
agent's sandbox (`/session` on its Modal tunnel, discovered via the
`GET /:slug/client-config` broker) — "server" below means the process
running the runtime: the guest harness on the platform, the `aai dev`
server locally. Audio path depends on the session mode (see above):

- **S2S mode**: user speaks → browser captures PCM → WebSocket → server
  relays audio into a single AssemblyAI S2S socket → agentic loop (LLM +
  tools) runs service-side → synthesized audio streams back through the
  same socket → server forwards to browser → user can interrupt at any
  time (cancels the in-flight turn).
- **Pipeline mode**: user speaks → browser captures PCM → WebSocket →
  server forwards audio to the STT provider → STT partials stream to the
  client as `user_transcript_partial` (live captions) and drive
  `speech_started`/`speech_stopped` edges → the committed transcript fires
  `onUserTranscript` → host runs the LLM loop locally via `streamText`
  (tool calls execute on the host just like S2S mode) → assistant text
  chunks stream into the TTS provider → synthesized audio returns over
  the client WebSocket → interrupts cancel the in-flight LLM stream and
  TTS playback. A barge-in that never commits a user turn is treated as a
  false interruption and the reply resumes (see
  `falseInterruptionTimeoutMs`).

## Conventions

- **Runtime**: Node everywhere (host, platform server, and guest sandbox)
- **Frameworks**: React (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Linting**: Biome. Auto-runs on staged files via lefthook pre-commit hook.
  **Every package needs a `lint` script** (`biome check .`) or `turbo run
  lint` — and so `pnpm check` — silently skips it; `aai-templates` had none.
  Filename conventions are Biome's job too (`useFilenamingConvention`,
  kebab-case), which replaced a never-invoked `ls-lint` whose config existed
  but which no pipeline ran and which blocked for 30+ minutes at repo root.
  Template tool files are exempted by an override: their names mirror
  snake_case LLM tool names.
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
  `silenceSteps()`, `silenced()`, `makeBundle()`. The dev-server specs share
  their mock scaffolding (fake chokidar, runtime/server mocks) via
  `_dev-server-test-utils.ts`. A `_test-setup.ts` setup file points
  `AAI_CONFIG_DIR` at a per-run temp dir so tests can never touch the
  developer's real `~/.config/aai/config.json` (API key + approved servers).
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
| `@alexkroman1/aai` | `packages/aai/index.ts` → 6 modules | Types, Db, utils, constants, `agent()`/`tool()` helpers |
| `@alexkroman1/aai/utils` | `sdk/utils.ts` (direct, not a barrel) | Zod-free utilities (`errorMessage`, `errorDetail`, …) + the slug contract (`VALID_SLUG_RE`, `RESERVED_SLUGS` from `sdk/slug.ts`). Deliberately dependency-free so the CLI can load it on every invocation without paying zod's startup cost |
| `@alexkroman1/aai/runtime` | `host/runtime-barrel.ts` → 11 modules | Full Node.js runtime: session, S2S, server, tools, WS handler |
| `@alexkroman1/aai/protocol` | `sdk/protocol.ts` (direct, not a barrel) | Wire-format Zod schemas, `lenientParse()`, `ClientEvent`, `ServerMessage` |
| `@alexkroman1/aai/manifest` | `sdk/manifest-barrel.ts` → 3 modules | `toAgentConfig()`, `agentToolsToSchemas()`, `AgentConfig`/`ToolSchema` + their Zod schemas, config-rule asserts. (The subpath name is historical — the old `parseManifest()`/`Manifest` layer was deleted; renaming the published subpath wasn't worth the break.) |
| `@alexkroman1/aai/stt` | `sdk/providers/stt-barrel.ts` | STT provider factories + types (`assemblyAIStt`, `deepgram`, `elevenlabs`, `soniox`) |
| `@alexkroman1/aai/llm` | `sdk/providers/llm-barrel.ts` | LLM provider factories + types (`anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`, `openrouter`, `gateway`) |
| `@alexkroman1/aai/tts` | `sdk/providers/tts-barrel.ts` | TTS provider factories + types (`cartesia`, `rime`, `assemblyAITts`) |
| `@alexkroman1/aai/s2s` | `sdk/providers/s2s-barrel.ts` | S2S provider factories + types (`openaiRealtime`; `assemblyAIS2s` is on the root export) |
| `@alexkroman1/aai/tools` | `host/agent-tools.ts` (direct, not a barrel) | Keyless network builtins callable from user tool code: `fetchJson`, `visitWebpage`, `webSearch` |
| `@alexkroman1/aai/internal` | `internal.ts` → 5 modules | Cross-package infrastructure (`createEpoch`, `createOwnedMap`, `createCoalescingRunner`, `parseWsUpgradeParams`, `formatSchemaIssues`). Not public API, not semver-covered, excluded from the docs |

### Concurrency primitives (use these, don't hand-roll)

The codebase's recurring async-coordination patterns are reified as small
primitives — reach for them before re-inventing the pattern at a call site:

- **`createEpoch()`** (`aai/sdk/epoch.ts`, exported from
  `@alexkroman1/aai/internal`) —
  staleness guard for async continuations: capture `current()` when deferring
  work, check `isCurrent(gen)` when it settles, `bump()` to invalidate.
  Adopted by the aai-ui connection/turn generations and the pipeline turn
  gate. Don't hand-roll `let generation = 0; generation++` counters.
- **`createOwnedMap()`** (`aai/sdk/owned-map.ts`, exported from
  `@alexkroman1/aai/internal`) — a map whose entries are removed by ownership token:
  `claim(key, value)` returns the only release for that claim, so an async
  teardown settling after the key was re-claimed (reconnect resume, redeploy)
  can't evict the successor's entry. `owns()` guards non-delete mutations.
  Adopted by the runtime's `sessions`/`sinkMap`, the WS handler, and the
  platform `SlotCache`. Don't write `if (map.get(k) === mine) map.delete(k)`
  by hand.
- **`createCoalescingRunner()`** (`aai/sdk/coalescing-runner.ts`, exported
  from `@alexkroman1/aai/internal`) — serialize + coalesce repeatable async
  work: at most one run in flight, triggers during a run share ONE trailing
  re-run started after the current settles, rejections never wedge the
  runner. For work that reads latest state when it runs (workspace sync,
  post-write typechecks). Don't hand-roll `inFlight`/`trailing` flag pumps.
- **`createTurnMachine()`** (`aai/host/transports/pipeline-turn-state.ts`) —
  the pipeline transport's turn lifecycle (in-flight reply, spoke flag, TTS
  audio gate) as a discriminated-union machine whose named transitions are
  the only mutation path. New turn-state reads/writes go through it, not new
  closure flags.
- **Timeouts**: use `p-timeout` (a dependency of aai, aai-cli, aai-guest,
  and aai-server) — never a hand-rolled `Promise.race` with a timer; the
  losing branch's late rejection and timer cleanup are exactly what gets
  re-derived wrong. The guest harness is no exception: tsdown bundles its
  npm dependencies (p-timeout included) into `dist/harness.mjs` — only the
  vite/rolldown build toolchain stays external to the bundle.
- **Combining abort signals**: use native `AbortSignal.any([...])` (sources
  held weakly — no unlink bookkeeping); the pipeline transport combines the
  session signal with each turn's controller this way.

### Fixed release coupling

`aai`, `aai-ui`, and `aai-cli` are in a **fixed release group** (configured
in `.changeset/config.json`). A changeset for any one of them bumps all
three to the same version. Keep this in mind when creating changesets —
you only need to list one package.

### Testing

- **Vitest**. Test files co-located: `foo.ts` → `foo.test.ts`.
- **The aai-server test project auto-builds the guest harness**:
  `scripts/ensure-guest-harness.mjs` runs as vitest `globalSetup` (root and
  per-package configs) and builds `aai-guest` when `dist/harness.mjs` is
  missing or older than the guest package's sources — `createSandbox`
  resolves it eagerly, so an unbuilt harness otherwise fails every sandbox
  test. Staleness tracks aai-guest sources only (not the bundled SDK);
  `GUEST_HARNESS_PATH` skips the check. The same script also runs as
  `predev` in aai-server and aai-studio-server (so `pnpm dev:aai-server`
  always boots with a fresh harness for local-dev sandboxes) and
  as `predeploy:modal` in both server packages (a fail-fast before the
  remote Modal image build, which rebuilds the harness itself). Also
  runnable directly: `node scripts/ensure-guest-harness.mjs`.
- **`predev` also rebuilds the studio front-end**: aai-studio-server's
  `predev` ends with `pnpm --filter aai-studio-client build`, so
  `pnpm dev:aai-server` always serves a current client. `studio-static.ts`
  serves whatever is in that package's `dist/` — nothing checks its age —
  so without this a stale (or absent) bundle is served silently and the
  studio looks unchanged no matter what you edit. Unconditional rather than
  staleness-gated like the harness above: the build is sub-second, which is
  cheaper than the check would be worth.
- **Each suite is defined once, in its own package's `vitest.config.ts`.**
  The root `vitest.config.ts` discovers them with `projects: ["packages/*"]`
  and adds only the typecheck-only `aai-types` project. Use
  `--project <name>` to run one; the name is declared in the package config
  (a bare glob would otherwise name the project after package.json, e.g.
  `@alexkroman1/aai`). Do NOT re-declare a suite at the root: it used to
  hold a second inline copy of all eight, and they silently drifted — the
  aai-cli copy lost `_test-setup.ts`, so `--project aai-cli` ran the CLI
  suite against the developer's real `~/.config/aai/config.json`; the server
  copies lost their 20s argon2 timeout; the aai-server excludes named two
  deleted files while missing a live integration test; and the templates
  copy skipped two of its four test files.
- Slow tiers run off the ONE root `vitest.slow.config.ts`, never a
  per-package config: each package declares a `test:integration` /
  `test:e2e` script pointing at it and narrows the files with
  `VITEST_INCLUDE` (plus `VITEST_PROFILE=e2e` for the 300s timeout), and
  exposes it to turbo as `check:integration` / `check:e2e`. That keeps the
  slow files out of a plain `vitest run` without a second config to drift.
- In tests, use `flush()` from `_test-utils.ts` instead of
  `await new Promise(r => setTimeout(r, 0))` to yield to microtasks.
- Use `vi.waitFor()` instead of arbitrary delays when polling for async results.
- Type-level tests use `.test-d.ts` files with `typecheck: { only: true }`
  — they are checked by tsc but never executed at runtime. Use
  `expectTypeOf` from vitest to assert on type shapes. Projects:
  `aai-types`.
- **Package validation**: `publint` runs post-build to verify package.json
  exports resolve to real files. `attw` validates export types. Both run in
  the check pipeline AND in CI, and **all three publishable packages
  (`aai`, `aai-ui`, `aai-cli`) must define both scripts** — for a long time
  only `aai-ui` did, leaving `aai`'s ten subpath exports ungated. That is
  the gap the deleted npm/yarn e2e legs were retired *in favour of* (see
  "The e2e suite is pnpm-only in CI"), so it has to actually hold.
- **Typechecking covers test files**, because every package's tsconfig
  includes them. Turbo's `typecheck` task must therefore keep `**/*.test.ts`
  in its `inputs`: excluding them (as it once did) meant a type error in a
  test could not invalidate the cache, and `turbo run typecheck` replayed a
  green FULL TURBO while `tsc --noEmit` failed.
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
| aai-server | **forks** | node | — | Forks for process isolation; excludes integration tests |
| aai-studio-server | **forks** | node | — | Forks for the same reason as aai-server |
| aai-guest | threads | node | — | Harness/studio-tool suites |
| aai-studio-client | threads | node | — | `.tsx` tests via `react-dom/server` (no jsdom) |
| aai-templates | threads | node | — | Also matches `templates.test.ts` + `template-api-coverage.test.ts` |

#### Test environment variables

Tests can behave differently based on environment variables set in
package.json scripts (not always obvious from test code alone):

- `VITEST_PROFILE` — switches timeout/retry profiles in
  `vitest.slow.config.ts`: `integration` (30s), `e2e` (300s)
- `VITEST_INCLUDE` — filters which test files to include
- `VITEST_POOL` — can override pool strategy at runtime
- `AAI_TEST_PM` — package manager the e2e suite installs the scaffolded
  project with (`pnpm` | `npm` | `yarn`; default `pnpm`). **CI only runs
  `pnpm`** — see below.

#### Studio starter evals (scripts/starter-eval.mjs)

The LLM-judge codegen suite (`studio-eval.test.ts`, vitest-evals) was
removed in favour of a harness that drives the studio's REAL surface —
create project, broker a sandbox session, stream a chat turn to the guest —
rather than calling the codegen path directly:

```sh
node scripts/starter-eval.mjs [--only <substring>] [--repeat N] [--out f.json]
node scripts/starter-eval-report.mjs run.json [baseline.json]
```

It spends real tokens on the caller's own key, so it is not in CI. Three
things it measures that the judge suite did not:

- **Shippable, not just green.** The agent writes its own tests, so "the
  tests passed" is a measure it can satisfy by weakening an assertion. The
  primary verdict is instead whether the built agent covers the capabilities
  the PROMPT enumerated (`scripts/starter-expectations.mjs`), checked
  against the loaded config and agent.ts — neither of which the agent can
  edit to make the check pass.
- **Cost**: tool calls, repair rounds (failed `test_agent` runs), wall
  clock. Repair rounds are the number worth optimizing; they were what the
  starter prompts actually burned their step budget on.
- **A failure taxonomy** — never-verified / verified-broken / missing
  capability / step-capped — because "RED" was hiding three problems that
  want three different fixes.

**Run-to-run variance is large, and single runs cannot adjudicate a prompt
change.** Measured on one starter with an identical config: tool calls
varied 9–14 and repairs 1–4, which is the size of the effect most prompt
edits produce. Use `--repeat 3` and compare arms, and expect a plausible
change to show no effect — one A/B of a TypeScript-idioms preamble block
came back flat and the block was removed rather than kept on the strength
of a single flattering run.

What the deleted suite did that this does not: an LLM judge scoring the
workspace against a reference template for persona, state use, and assets
(`TemplateParityJudge`). Capability coverage is checked; resemblance to a
hand-written template is not.

#### The e2e suite is pnpm-only in CI

`aai init` scaffolds a project that the e2e suite then installs from a mock
registry, so the install step can in principle run under any package
manager. CI used to fan that out (`pm: [pnpm, npm, yarn]` × 2 OSes = 6
jobs); it now runs pnpm alone.

The npm/yarn legs were paying for themselves in flakes rather than bugs:
each one is a full cold install of the published tarballs on a shared
runner, they tripped over resolver-specific quirks unrelated to our code
(hence `--no-lockfile`, `--no-strict-peer-dependencies`,
`NPM_CONFIG_MINIMUM_RELEASE_AGE=0`), and the repo itself is pnpm-only, so
the thing they guarded — "our published `exports` maps resolve under a
non-pnpm resolver" — is better served by `publint` + `attw`, which run on
every build and check the package metadata directly.

The `AAI_TEST_PM` switch in `_e2e-test-utils.ts` stays, so an npm or yarn
install is one env var away when reproducing a user report:

```sh
AAI_TEST_PM=npm pnpm test:e2e
```

Treat those two branches as a debugging tool, not covered ground.

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

### API reference docs (TypeDoc)

`pnpm docs:api` generates the SDK API reference into `docs/dist` with
[TypeDoc](https://typedoc.org), covering the published surface of `aai`
and `aai-ui` (built `dist/*.d.ts`; the aai-cli subpaths are internal
build hooks and deliberately not documented). Entry points live in each
package's `typedoc.json`; a new subpath export needs an entry there too.
`docs/typedoc.json` sets `excludeInternal` — tag a symbol `@internal` to
keep it exported but out of the docs — and `treatWarningsAsErrors`, so a
broken `{@link}` or a type referenced by a public signature but not
exported **fails the build**. The generation runs as the turbo `docs`
task, wired into `pnpm check` and the CI check job as a merge gate; keep
it at zero warnings rather than downgrading the option.
**Code examples in docs compile**: `pnpm check:doc-examples`
(`scripts/check-doc-examples.mjs`, in `pnpm check` and the CI check job)
extracts every ```` ```ts ````/```` ```tsx ```` fence from published-package
doc comments, the scaffold CLAUDE.md, READMEs, and the studio prompt
modules, and compiles each as a self-contained module under the scaffold
tsconfig. A deliberate fragment opts out with `no-check` in the fence info
string (```` ```ts no-check ````). The
`.github/workflows/docs.yml` workflow publishes the site to GitHub Pages
(`https://alexkroman.github.io/agent/`) on every push to `main`. The
docs tooling lives in its own `docs/` workspace package
because TypeDoc needs the JS TypeScript compiler API, which TS 7 (the
native compiler the repo builds with) no longer ships — so `docs/` pins
its own `typescript@6`, and `check:sherif` ignores the `aai-docs` package
to allow that one deliberate version split.

### Related docs

- **Templates**: `packages/aai-templates/templates/` contains agent
  scaffolding templates (simple, web-researcher, etc.). Each is
  self-contained with its own `agent.ts` and optional `client.tsx`.
  `scaffold/` has base project files (package.json, tsconfig,
  etc.) layered underneath.

  **They ship inside the `@alexkroman1/aai-cli` tarball**, copied into its
  `dist/` at build time by `aai-cli/bundle-templates.mjs` — the sources stay
  in `aai-templates`, which still owns their tests, typecheck, and lint;
  this is packaging, not a move. `aai init` used to fetch them at run time
  with giget (`github:alexkroman/agent/packages/aai-templates#main`), which
  required a network for every init and pinned templates to `main`
  regardless of the CLI version installed, so a template written against a
  newer SDK could land in a project resolving an older one. Two consequences
  worth knowing:
  - `packages/aai-cli/turbo.json` adds the template sources to the build's
    `inputs`. They live in another package, so the root task's
    package-relative globs cannot see them — without the override, editing a
    template replays a cached CLI build that predates it.
  - Nothing running in-tree can exercise the shipped path: `getMonorepoRoot()`
    keys off the module's own location, so a CLI built at
    `packages/aai-cli/dist` always finds the workspace root and takes the
    monorepo branch. The e2e suite's `detachedCli()` copies `dist/` somewhere
    with no `pnpm-workspace.yaml` above it for that reason, and `aaiEnv()`
    deliberately sets no `AAI_TEMPLATES_DIR` — that override used to pin
    every e2e run to the workspace sources.

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

### Updating CLAUDE.md

When you make changes that affect architecture, security model, conventions,
or gotchas, document them — **in the guide that owns the code you changed**
(see "Per-package guides"), not here. This file is for what holds repo-wide;
it is loaded into every session, so anything package-specific costs context
in every session that never touches that package.

Two rules keep the split from rotting:

- **Whole sections move, never halves.** A section split across two files
  grows two divergent copies of the same rule — the failure mode the
  canonical-config-schema section describes, applied to prose.
- **A reference across files names the file.** *see "Modal sandbox notes" in
  [aai-server](packages/aai-server/CLAUDE.md)* — a bare "see X below" is
  wrong the moment X lives elsewhere, and nothing checks it.

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
   Note syncpack does NOT check the scaffold (it is excluded in
   `.syncpackrc.json`) — run `node scripts/sync-scaffold-versions.mjs`
   to sync it (or `--check` to verify).
2. **Test assertion mismatches**: After changing output formats or error
   messages, run `pnpm test` and update affected assertions.
3. **Lint in related files**: Pre-commit only lints staged files. Run
   `pnpm lint` to catch lint issues in files affected by your change.
4. **Type-level tests**: After changing public API types (`toAgentConfig`,
   `AgentConfig`, etc.), run `pnpm vitest run --project aai-types`
   to verify type contracts haven't regressed. Update `.test-d.ts` files
   if the change is intentional.
5. **Dependencies orphaned by a deletion**: removing the last consumer of a
   package leaves the `devDependencies` entry and its lockfile tree behind.
   `pnpm check:knip` catches this and is in the local subset for that
   reason — it's the one failure you won't notice while working, because
   deleting code puts your attention on what goes away, not on what the
   removal strands. When a PR deletes a directory, expect a dependency to
   come out with it.

## Security architecture

The threat model and its enforcement live with the code that enforces them:

- **Sandbox isolation, platform sandbox, credential separation, the SSRF
  guard, and the boundary tests** — [aai-server](packages/aai-server/CLAUDE.md).
- **The agent-guest contract** (boot, hash verification, the token-gated
  `/manage/*` surface, guest-owned idleness) —
  [aai-guest](packages/aai-guest/CLAUDE.md).
- **`run_code`, provider credential resolution, and the branded env records
  that keep host credentials out of `ctx.env`** — [aai](packages/aai/CLAUDE.md).
- **Where the CLI is allowed to send an API key** —
  [aai-cli](packages/aai-cli/CLAUDE.md).

Two rules are repo-wide and belong here:

- **There is no platform-owned AssemblyAI key.** Every key on the platform is
  a user's own; anything that would let an agent borrow a platform credential
  is a bug, not a convenience.
- **The container is the boundary.** No in-process sandbox (`node:vm`, an
  import allowlist, an egress policy) is treated as one — each was tried and
  removed. Don't reintroduce one and reason as though it holds.

### Known limitations

- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`)
  and `aai-ui` (`.`). Subpath exports (e.g. `./protocol`) are not covered
  by type tests.
