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

### Single-package shortcuts

```sh
pnpm test:aai-core       # Run only aai unit tests
pnpm test:aai-ui         # Run only aai-ui unit tests
pnpm test:aai-cli        # Run only aai-cli unit tests
pnpm test:aai-server     # Run only aai-server unit tests
pnpm test:aai-studio-client  # Run studio front-end unit tests
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
under `aai dev`. **package.json is MERGED rather than skipped**
(`mergeScaffoldManifest` in `aai-cli/_templates.ts`): the scaffold fills in
top-level fields the pulled manifest lacks, and for `dependencies` /
`devDependencies` / `scripts` it fills in per ENTRY. Skip-if-exists was wrong
here because a studio workspace's manifest declares its runtime deps and NO
toolchain — correct in the guest, where the toolchain is baked (see
`ensureProjectShape`), and fatal on a laptop, where `pnpm install` then
fetched no `vite`, `@vitejs/plugin-react`, or `@tailwindcss/vite` and
`aai dev` died resolving the vite.config.ts the same layering had just
written. Per-entry matters both ways: the workspace's exact pins survive the
scaffold's carets, and one agent-added devDependency can't shadow the whole
toolchain block. `aai delete` in a linked directory deletes the STUDIO
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

**A LONG-RUNNING command's diagnostics go through `notify` (`_ui.ts`), not
`log`.** `silenceOutput()` no-ops every `log` method so JSON mode's contract —
exactly one result line on stdout — holds. That is right for a
request/response command and wrong for `aai dev`, which writes its JSON line at
startup and then keeps running: every later message was silenced for the rest of
the process, including "Restart failed: … (previous server still running)", the
watcher's ENOSPC/EMFILE error, and the `unhandledRejection`/`uncaughtException`
handlers whose entire purpose is diagnostics. Since JSON mode is AUTO-DETECTED
on a pipe, that is the NORMAL case — `aai dev > dev.log`, a process supervisor,
a container — so a syntax error left the previous agent being served with
nothing anywhere saying why edits had stopped taking effect (verified: stderr
empty, stdout one line, old version still served). `notify` keeps the styled
clack output in human mode and writes a plain line to STDERR once silenced, so
the stdout contract survives while a human tailing the log still sees the
failure. Any new post-startup output in a long-running command owes the same
treatment.

**A `*-preview` project name is refused** (`projectNameFromDir` returns
null). Publishing deploys under the project's own name, so such a project
would claim a slug the orphan-preview sweep reaps hourly — taking the agent,
its app-database schema, and its secrets with it. See the `-preview` note in
the Modal sandbox section for the matching deploy-boundary rule.

### SDK structure

The SDK is organized into two directories with a **hard dependency
boundary** — this split is critical for sandbox security:

- **`sdk/`** — shared modules with **zero Node.js dependencies**. Safe to
  run in browsers, Deno, and sandboxed environments. Contains:
  `types.ts`, `db.ts`, `hooks.ts`, `utils.ts`, `constants.ts`,
  `protocol.ts`, `system-prompt.ts`,
  `ws-upgrade.ts`, `_internal-types.ts`, `agent-config.ts` (the canonical
  serializable config + `toAgentConfig`), `schema.ts` (Standard Schema
  acceptance: `inputSchema` validation + JSON Schema conversion),
  `define.ts` (`agent()` and `tool()` helpers for authoring `agent.ts`
  files).
- **`host/`** — host-only modules that **require Node.js APIs** (`node:vm`,
  `node:crypto`, etc.). Only runs on the platform server and CLI, never
  inside a guest sandbox. Contains:
  `server.ts`, `runtime.ts`, `runtime-config.ts`, `runtime-types.ts`,
  `runtime-transport.ts` (transport selection/construction for the runtime),
  `tool-executor.ts`, `session-core.ts`, `s2s.ts`, `ws-handler.ts`,
  `transports/` (S2S / pipeline / OpenAI Realtime `Transport`
  implementations, including `pipeline-turn-outcome.ts` — the three ways a
  pipeline turn ends: interrupted by barge-in, failed, or spoken), `to-vercel-tools.ts`,
  `providers/` (STT/TTS openers + descriptor→instance resolvers),
  `builtin-tools.ts`, `postgres-db.ts`.

**Rule**: When adding new SDK code, place it in `sdk/` if it has no
`node:` dependencies. Moving code from `sdk/` → `host/` is safe;
moving `host/` → `sdk/` requires removing all Node.js imports first.

The guest harness (`packages/aai-guest/harness.ts`) runs **Node** inside each Modal
Sandbox — the same runtime as the host and `aai dev` — loading the agent's
ESM bundle directly; the Modal sandbox (not a language runtime permission
model) is the security boundary.

### Key files

#### packages/aai-cli/

- `cli.ts` — arg parsing, subcommand dispatch
- `_cli-common.ts` — shared citty plumbing (`sharedArgs`, `setup`,
  `runCommand`); `_studio-commands.ts` — the list/pull/push/publish command
  definitions
- `init.ts` / `dev.ts` / `test.ts` / `deploy.ts` (internal) / `delete.ts` /
  `secret.ts` — subcommand entry points
- `studio.ts` / `_studio.ts` — the studio round-trip: pull/push/publish
  executors over the `/studio/projects` routes, the local source walk
  (guest-snapshot ignore rules + cap mirrors, `.env`/lockfiles never sync)
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

- `index.ts` — main exports, React UI component
- `session-core.ts` — WebSocket session management + reactive snapshot
  (`createSessionCore`); split across `session-core-messages.ts`
  (message/history handling) and `session-core-types.ts`
- `context.ts` — SessionProvider, useSession, useSessionCore,
  useSessionSelector, ThemeProvider, useTheme
- `hooks.ts` — useToolResult, useToolCallStart, useEvent
- `audio.ts` — PCM encoding/decoding, AudioWorklet management
- `define-client.tsx` — client mount helper
- `default-client.tsx` / `build-default-client.ts` — the default UI shipped
  to agents with no `client.tsx`, and its build step
- `types.ts` — UI type definitions
- `components/` — UI components (console-shell, chat-view, controls,
  message-list, start-screen, sidebar-layout, tool-call-block, button,
  aai-logo, tool-config-context)

#### packages/aai-server/

- `orchestrator.ts` — HTTP + WebSocket routing
- `sandbox.ts` — agent sandbox lifecycle: `sessionUrl()` (the public tunnel
  endpoint the broker hands to clients), `drain(deadlineMs?)` (retirement's
  one request), `shutdown()`. DEPLOYED AGENTS RUN AS SERVERS — the host
  holds NO channel to them (see "Agent guests are servers" below)
- `sandbox-vm.ts` — `spawnAgentServer` (the agent-server dispatch over the
  two backends), `describeBundle` (deploy-time bundle inspection as a
  ONE-SHOT describe-mode exec — no channel), and the studio-side
  `spawnWarmHarness` control-channel machinery
- `sandbox-backend.ts` — backend selection policy (`SANDBOX_BACKEND` override,
  production → `modal`, local dev → `subprocess`) plus the reason string
  the boot log prints, so "which backend am I on, and why" is one log line
- `warm-harness.ts` — backend-independent guest wiring shared by both backends:
  dial-with-retry, stdio draining, free-port allocation, `WarmHarness` exit and
  cleanup semantics
- `sandbox-slots.ts` — the per-slug slot cache: `{ slug, version?, sandbox? }`
  plus the slug lock. NO idle machinery — idleness is the guest's own job
  (agent-mode self-exit), and its exit detaches the slot via `onSandboxLost`
- `modal-sandbox.ts` — Modal Sandbox backend: creates remote sandboxes from
  a harness-baked snapshot image (built once per harness version, published
  under a content-addressed tag), execs the Node harness with a per-sandbox
  bearer token, and dials its WebSocket through the sandbox's Modal tunnel
- `packages/aai-guest/` — its own private workspace package: the Node guest
  entry point (runs inside a Modal Sandbox) that runs the COMPLETE agent.
  ONE BINARY, TWO MODES, selected by the spawner via `AAI_GUEST_MODE`
  (behavior selection, never a security boundary — capability is what the
  host delivers):
  **agent mode** (deployed agents — see "Agent guests are servers") boots
  from files delivered at exec time and serves only the public session
  surfaces plus the token-gated `/manage/status` + `/manage/drain` pair
  (`harness-agent-mode.ts`); a third ONE-SHOT **describe mode**
  (`AAI_DESCRIBE_BUNDLE_PATH`) imports a bundle and prints its
  self-described config as the last stdout line CARRYING THIS EXEC'S NONCE
  (`AAI_DESCRIBE_NONCE`; "last line" alone is not a defense — the bundle is
  imported into that process, so a `process.on("exit")` handler prints after
  the harness. The harness deletes the nonce from `process.env` before
  importing, so bundle code cannot read the value it would have to forge) —
  deploy-time config
  extraction with no server, no token, no channel; **studio mode** serves
  `/ws` (bearer-token host control channel — JSON-RPC
  `workspace/deploy` (Publish's in-guest `aai deploy`), `status`,
  `studio/session-init`; guest→host
  `studio/sync-workspace`, `studio/persist-chat` — bundle loading and tool
  trials are harness-internal now, driven by the in-guest coding agent,
  not RPC),
  `/session` (PUBLIC client voice sessions, connected directly by
  browsers — the embedded SDK runtime drives STT/LLM/TTS in-guest), and
  `/studio/chat` + `/studio/tools` (the studio coding agent's PUBLIC chat
  surface, bearer-gated by the broker-minted per-session chat token — see
  "Browser studio"), plus `POST /studio/session-init`, the HTTP twin of the
  `studio/session-init` RPC gated by the per-sandbox HOST token, for the
  replica that does not hold this guest's single control socket (see "One
  studio sandbox per project, fleet-wide").
  `harness.ts` (servers + dispatch), `harness-agent-mode.ts` (agent-server
  boot, manage surface, idle/drain lifecycle), `trial.ts` (run_code
  executor + one-shot tool trials), `harness-rpc.ts` (guest→host request
  proxy), `studio-session-init.ts` (the HTTP install route + the guest's own
  (scope, project) identity pin), `studio-http.ts` (shared CORS + bounded
  body read for both `/studio/*` surfaces),
  `studio-chat.ts`/`studio-tools.ts`/`studio-edit.ts`/`studio-grep.ts`
  (the in-guest coding agent), `studio-build.ts` (in-guest workspace
  builds through the aai CLI bundlers), `studio-publish.ts` (Publish =
  the literal `aai deploy` CLI, run in-sandbox), `limits.ts` (import-free constants
  mirroring the SDK's). The harness embeds NO agent runtime — every worker
  bundle ships its own (`__aaiCreateRuntime`, see "User-shipped runtime"
  below) — and tsdown bundles the harness (server shell + studio coding
  agent) into the single `dist/harness.mjs` the server resolves via
  `aai-guest/harness` and bakes into the snapshot image, keeping the build
  toolchain (`@alexkroman1/aai-cli`, the client-build plugins) EXTERNAL:
  it resolves at runtime from the node_modules next to the harness
- `modal_deploy.py` — Modal deployment of the agent service
  (`@modal.web_server` wrapping the node process);
  `pnpm --filter aai-server deploy:modal`
- `platform-lock.ts` — cross-replica per-slug mutation lock (see "Stateless
  server" below): a Postgres ADVISORY lock on a reserved connection in
  production, the in-process keyed lock in dev/tests
- `agent-store.ts` — the agents table (`aai_platform.agents`; memory in
  dev/tests): one row per agent — slug, credential hashes, the bundle's
  self-described config, content hashes of the worker/client blobs, and a
  deploy `version` that doubles as the cross-replica invalidation signal
  (see "Split services" below)
- `sandbox-resolve.ts` — slot-based slug→sandbox resolution +
  `watchAgentInvalidation`, the event-driven sandbox invalidation (split
  from sandbox.ts, which owns one sandbox's lifecycle)
- `sandbox-broker.ts` — `brokerSessionUrl`: slug → the public session URL a
  client dials, with the one failure taxonomy `GET /:slug/client-config` and
  the `/:slug/websocket` upgrade share. The platform's ONLY routing point
- `sandbox-directory.ts` / `sandbox-peers.ts` — the fleet-wide answer to "is
  some replica already serving this deploy?", which is a Modal sandbox NAME
  (`agent-<hash(slug)>-v<version>`) rather than a lease table — see "No
  horizontal sandbox scaling" below
- `platform-events.ts` — `PlatformEvents`: cross-replica change
  notifications (`watchAgents`, `watchWorkspace`, `watchChat`,
  `watchScopeProjects`) as SIGNALS (handlers re-read rows, never trust
  payloads); memory emitter + store decorators for dev/tests
- `realtime-events.ts` — the production `PlatformEvents`: Supabase Realtime
  `postgres_changes` on `aai_platform.agents` / `studio_workspaces` /
  `studio_chats` over `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, plus
  the boot-time `supabase_realtime` publication setup
- `pg-cron.ts` — janitorial sweeps as pg_cron jobs (dead rate-limit windows,
  orphaned `-preview` agents + their app database schema/role and Vault
  secrets), installed idempotently at boot. `cron.schedule` upserts by name,
  so a job DELETED from `PLATFORM_CRON_JOBS` keeps firing on any database that
  already has it — and `guarded()` makes that silent. Boot therefore DIFFS:
  every `aai-sweep-*` job in `cron.job` that the code no longer declares is
  unscheduled, so `PLATFORM_CRON_JOBS` is the whole truth about what the
  platform runs and retiring one cannot be forgotten (the hand-maintained
  retired list this replaced had exactly one failure mode — omission)
- `studio-proxy.ts` / `app-middleware.ts` — the split deployment (see
  "Split services" below): the agent service's reverse proxy to the studio
  service, and the apps' shared base middleware
- `rpc-transport.ts` — WebSocket JSON-RPC transport for host↔guest RPC.
  Connections are typed by a per-direction method map (`RpcSchema`); the
  sandbox link's concrete map is `GuestRpcSchema` in `rpc-schemas.ts`, so
  method names and outgoing request params are compile-checked at every
  call site while results/incoming params stay `unknown` (untrusted wire
  data — Zod at the receiving site is the contract)
- `transport-websocket.ts` — WebSocket transport layer
- `auth.ts` — authentication/authorization
- `credentials.ts` — credential derivation
- `bundle-store.ts` — deploy persistence: content-addressed, immutable
  blobs (`blobs/<sha256>` — worker + client files) committed
  by the agents-row upsert, which is the deploy's ATOMIC publish point.
- `blob-storage.ts` — where those blobs live: Supabase Storage through
  `@supabase/storage-js` in production (authenticated with the SAME
  `SUPABASE_SERVICE_ROLE_KEY` as Realtime — Storage has no credential of its
  own), memory in dev/tests. The surface is deliberately `getItem`/`setItem`
  and nothing else. It replaced unstorage's generic S3 driver plus a local
  override of that driver's `getKeys` (which lists the whole bucket and reads
  only the first 1000-key page): once workspaces moved to Postgres NOTHING
  lists keys, so the override guarded a call no longer made, and the
  `SUPABASE_S3_*` endpoint/region/key set was a third credential for a
  project already reachable two other ways. A miss (404) MUST resolve `null`
  while any other failure throws — the bundle store caches misses under a
  sentinel and retries failures, so conflating them makes a live deploy read
  as absent.

  **`SUPABASE_SERVICE_ROLE_KEY` must be a SECRET key (`sb_secret_…`), and boot
  refuses a publishable one** (`assertServiceRoleKey` in `_boot.ts`, called
  once from `buildServiceConfig` — the only caller of both consumers, so the
  guard cannot be half-applied). A publishable key authenticates fine and then
  carries `anon` authority, which breaks both things that share the variable,
  neither of them legibly. **Storage**: a `blobs/<sha256>` write dies on
  `storage.objects` RLS with `new row violates row-level security policy`,
  reading as a broken bucket policy rather than a wrong key — and the
  `SUPABASE_S3_*` path this replaced went through Supabase's S3 gateway, which
  bypasses RLS entirely, so the same wrong key was INERT until deploys stopped
  using it. **Realtime** is worse: nothing surfaces at all. Filter columns are
  validated against the subscriber's role and the platform schema grants
  `select` to `service_role` only, so every filtered subscribe fails
  server-side with `invalid column for filter` and realtime-js retries the
  join forever — the service boots healthy and merely stops invalidating
  resident sandboxes on redeploy and stops pushing studio SSE. Only the two
  definitely-wrong forms throw (the `sb_publishable_` prefix, and a legacy JWT
  whose `role` claim is `anon`); anything unrecognizable is left to Supabase,
  which rejects it with a better message than a shape check can. Note
  `SUPABASE_PUBLISHABLE_KEY` (browser sign-in, `supabase-auth.ts`) is a
  separate setting and stays publishable.

  Agent env lives in Supabase Vault through the injected `SecretStore`.
  Orphan blobs from superseded/deleted deploys are accepted (content
  dedupes; a shared blob must not die with one referrer).
- `deploy.ts` / `delete.ts` — deployment lifecycle
- `secret-handler.ts` — secret management
- `secret-store.ts` — `SecretStore` interface: Supabase Vault
  (`createVaultSecretStore`, over the `SUPABASE_DB_URL` Postgres
  connection) in production, in-memory for local dev/tests. Holds agent
  env (`agent-env:<slug>`) and app-database credentials (`app-db:<slug>`)
- `app-database.ts` — per-app Postgres schema/role provisioning in the
  platform Supabase database (`provisionAppDatabase`,
  `deprovisionAppDatabase`, `openAppDb`)
- `storage-handler.ts` — `GET/POST/DELETE /:slug/storage` (owner-auth'd)
  toggling the app's database
- `packages/aai-studio-server/` — the browser studio server side, its own
  package/service (see "Browser studio"):
  `studio-routes.ts` (HTTP surface), `studio-session-broker.ts` (per-project
  coding-agent sandboxes: boot via the shared `spawnWarmHarness` machinery, session
  install, guest RPC handlers, `buildWorkspace` for Publish, idle
  eviction), `studio-session-registry.ts` (the cross-replica row that makes
  a project's sandbox one fleet-wide, not one per replica),
  `studio-session-adopt.ts` (installing a session into a PEER's guest over
  HTTP), `studio-llm.ts` (gateway model config; the key is always the
  caller's), `studio-workspace-dir.ts` (materializes a workspace to a
  scratch dir — eval-suite only now), `studio-errors.ts`
  (`StudioBuildError`), `studio-deploy.ts` (guest build → validate config →
  deploy), `studio-database.ts` + `studio-database-routes.ts` (the project
  database switch across both environments, and the post-deploy hook that
  provisions a newly claimed slug), `studio-workspace.ts` (project file
  store), `studio-prompt.ts`
  (system prompt from the scaffold CLAUDE.md), `studio-static.ts` (serves
  the built client)
- `packages/aai-studio-client/` — the studio's React front-end (Vite +
  Tailwind v4 + `useChat` + TanStack Query + CodeMirror), its own private
  workspace package built into its `dist/` by
  `pnpm --filter aai-studio-client build`. It talks to the server purely
  over HTTP/SSE (no code imports in either direction); aai-server serves
  the built artifact, resolved via `require.resolve` in
  `studio-static.ts` the same way aai-ui's `dist/default-client` is.
  Panes: `chat.tsx` (chat + composer), and the three the top bar's
  segmented control switches between — `preview.tsx`, `code-view.tsx`,
  `settings.tsx`.

### Browser studio (aai-studio-server)

Loading the platform server root (`GET /`) serves the **studio** — a
browser-based coding agent (TypeScript agent loop on the Vercel AI SDK,
the same `streamText` stack pipeline mode uses) that builds and deploys
voice agents without the CLI:

- **Workspaces** are small server-side file trees stored one row per
  project in Postgres (`aai_platform.studio_workspaces`, over the same
  platform `SqlExec` Vault uses; in-memory store in dev/tests —
  `workspace-store.ts`, same two-implementation pattern as
  `SecretStore`). Blob `Storage` serves only deploy artifacts. Rows carry an
  optimistic `version`: writes go through `createWorkspace` /
  `mutateWorkspace` (`studio-workspace.ts`), which retry a conflicted write
  once — the in-process keyed lock (`studio-workspace-lock.ts`) still
  serializes local writers, so a conflict means another replica. `scope` is
  a *deterministic* SHA-256 (`studioScope`) — stable so a caller can find
  its projects again. Browser sessions scope by the studio USER id
  (`user:<uid>` — stable across AssemblyAI key rotation); a raw-key caller
  whose key some account stored via `PUT /studio/account/key` resolves to
  the SAME `user:<uid>` scope (the `key-user:<sha256(key)>` reverse mapping
  in `resolveBearer` — this is what makes a linked `aai` CLI and the
  browser see one project list); only a raw key NO account has claimed
  (evals, programmatic callers) scopes by the key itself (`requestScope` in
  `studio-routes.ts`).
- **The CLI round-trips workspaces** (`aai list/pull/push/publish/delete` —
  see the aai-cli section): `GET /studio/projects/:project` returns
  `sourceHash` (the stamped files hash) as the pull's fast-forward token,
  and `PUT /studio/projects/:project/source` (`syncWorkspaceSource` in
  `studio-workspace.ts`) replaces the whole file map atomically — upserting
  on first push (reserved-name + create-rate-limit gated), 409ing when
  `baseHash` no longer matches the stored files, no-oping (no version bump,
  no preview churn) when the pushed files are byte-identical. A push that
  DID change something schedules a preview deploy **and refreshes the
  project's live coding-agent sandbox** (`refreshSession` on the broker): a
  guest materializes its workspace once, at install, so a session brokered
  before the push keeps serving the pre-push tree — and its next end-of-turn
  `studio/sync-workspace` writes that stale tree back OVER the push. The
  refresh reuses the local sandbox, or installs into a peer's over HTTP
  (`fleet.adopt`), and deliberately never SPAWNS: with no live sandbox there
  is no stale tree to fix, and a CLI push must not boot a coding agent.
  The token is
  deliberately the FILES hash, never the row version: preview/Publish stamp
  metadata (bumping the version) right after every settled edit, so a
  version token would go stale on almost every push while the files were
  untouched. `DELETE /studio/projects/:project` deletes THE PROJECT —
  workspace, chat, and its deployed + preview agents via the shared
  `deleteAgentResources` core, each slug gated by `verifySlugOwner` so a
  workspace naming a foreign slug is never a deletion oracle.
- **Projects are created from the chat, not a dialog.** The client has no
  new-project modal: typing the first message (the home hero's prompt box,
  `home.tsx`) posts it as `prompt` to
  `POST /studio/projects`, and the SERVER mints the name — prompt-derived
  base + random suffix, v0-style (`contact-form-x7k2mq`), via the same
  `aai-server/slug-generate.ts` generator slugless CLI deploys use (those
  seed from the agent's config `name` instead). Each project lives at a
  shareable `/studio/chat/<name>` URL: the studio serves the shell for that
  path and the client syncs selection with pushState/popstate. An explicit
  `name` in the create body remains for programmatic callers (evals, tests).
- **Chat runs IN the project's sandbox, and the browser connects to it
  DIRECTLY** — mirroring the voice path. `POST /studio/projects/:project/
  session` (rate-limited; `studio-session-broker.ts`) boots or reuses a
  guest sandbox through the same `spawnWarmHarness` machinery
  deployed agents use, installs the session over the control channel
  (`studio/session-init`: workspace files, the caller's own key, system
  prompt, model config), and returns the sandbox's public chat URL. The
  browser then streams turns straight to the guest's `POST /studio/chat`
  (SSE, the AI SDK UI message stream `useChat` consumes) — chat turns never
  pass through the platform host. The agentic loop (`streamText`, up to
  `MAX_CHAT_STEPS` = 80 steps, and a wall-clock turn budget —
  `aai-guest/studio-turn-budget.ts`) runs in the guest (`aai-guest/
  studio-chat.ts`) with Claude-Code-style tools over a real filesystem
  workspace (`aai-guest/studio-tools.ts`): list/read (windowed, numbered —
  opencode's read semantics)/write/edit/delete, `glob`, `grep`, `bash`
  (real shell in the container, guest token scrubbed from its env),
  `todo_write`, `test_agent`, the template tools
  (`aai-guest/studio-template-tools.ts`: `list_templates` enumerates the
  worked examples bundled in the toolchain's
  `@alexkroman1/aai-cli/dist/templates`, and `use_template` copies a
  template's files VERBATIM into the workspace — same conflict/byte/count
  caps and post-copy type diagnostics as `write_file`, so the agent never
  retypes template code by hand), and the keyless web builtins. Tool CPU —
  regex, diff, whatever `bash` runs — burns the tenant's own sandbox,
  which is why the host-side scan worker was deleted. Every successful
  `write_file`/`edit_file` type-checks the workspace and appends the
  (hint-annotated, capped) diagnostics to the tool result
  (`aai-guest/studio-write-diagnostics.ts`) — TS7's native tsc checks a
  studio workspace in well under a second, so this is a cold spawn per
  settled write burst (concurrent writes coalesce), NOT a resident LSP
  server: opencode's post-edit-diagnostics loop without a ~200 MB
  language-server process in a memory-capped sandbox. The write is never
  rejected on type errors (mid-refactor states are legitimate — the
  syntax gate in `studio-syntax.ts` owns the unrecoverable class), and a
  slow or missing compiler degrades to the plain write result. This
  replaced the standalone `check_types` tool — evals showed agents
  thrashing on it (sixteen checks, zero builds); `test_agent` is the one
  verification tool. The guest chat
  surface is bearer-gated by a broker-minted per-session `chatToken` (the
  tunnel URL is public; the token rides `studio/session-init` to the guest
  and the broker response to the browser, so no long-lived credential ever
  crosses the public surface) and CORS-open; `GET /studio/tools` on the
  same surface serves the user-friendly tool labels (`STUDIO_TOOL_LABELS`)
  the client renders.
  End of turn, the guest pushes state back over the control channel:
  `studio/sync-workspace` (validated like a client file PUT; only
  workspace source files — never node_modules/dist/.git — sync, under the
  same file caps) and `studio/persist-chat` (the settled conversation →
  `aai_platform.studio_chats`, restored on project open via
  `GET /studio/projects/:project/chat`). `test_agent` builds the live
  workspace IN the guest through the aai CLI's own bundlers
  (`aai-guest/studio-build.ts` — the toolchain node_modules are baked next
  to the harness) and loads/trials the bundle in place; Publish runs the
  literal CLI via the host→guest `workspace/deploy` RPC. Sandboxes are per
  (scope, project) FLEET-WIDE — the in-process map is backed by
  `aai_platform.studio_sessions`, so a broker call landing on another
  replica adopts the live guest instead of spawning a second one (see "One
  studio sandbox per project, fleet-wide") — with a 5-min idle eviction
  (matching the agent guest's
  own idle self-exit); a dead one heals on the next
  broker call, and the client re-brokers on ANY rejection from the chat
  surface — a rejected fetch, a 409, or a **401**. That last one matters
  because the guest's chat surface authenticates ONLY the `chatToken`; it
  never sees an account credential, so a 401 there means "stale session",
  not "bad user". Routing it to the app's re-authenticate path signed the
  user out of the studio outright. **The `chatToken` is minted once per
  SANDBOX**, not per broker call, for the same reason: the guest holds
  exactly one, so re-minting on a re-init revoked the token every earlier
  caller still held — and overlapping brokers (a second tab, another
  device, a reload racing an in-flight one) are exactly what the session
  lock below exists for. A replacement sandbox does mint a fresh one.
  **`ensureSession` is serialized per (scope, project), and entries are
  disposed by identity, not by key.** Overlapping brokers for one project are
  routine (a double-click, a StrictMode double effect, a refresh landing on
  an in-flight one); unserialized, both take the cold path and the loser's
  sandbox is ORPHANED — absent from `sessions`, so neither the idle sweeper
  nor `dispose()` can ever reach it. It burns its orphan timeout plus Modal's
  idle window billed, and its `wire()` handlers stay live, so its end-of-turn
  `studio/sync-workspace` keeps writing the project behind the tracked
  sandbox's back. The identity check matters for the same reason
  `createOwnedMap` exists on the agent side: every cleanup runs after an
  await (a rejected re-init, a publish whose sandbox died mid-request), by
  which point the key may hold a replacement that must not be evicted.
- **No MCP.** The studio's coding agent has no MCP integration (the docs
  MCP server it once connected to was removed). The system prompt embeds a
  *snapshot* of the scaffold guide; anything outside it — a voice, a newly
  added gateway model, a provider option — the prompt tells the agent to
  look up with `visit_webpage` (the AssemblyAI docs included) rather than
  guess.
- **Ground truth on disk: the baked toolchain, reachable only with `bash`.**
  The guest's `/opt/aai/node_modules` holds `@alexkroman1/aai` (SDK `.d.ts`),
  `@alexkroman1/aai-ui` (`dist/index.d.ts` plus per-component
  `dist/components/*.d.ts` — the API for `client.tsx`; no `.tsx` source
  ships), and `@alexkroman1/aai-cli`, whose `dist/templates/` carries the
  full template set — five of which have a real `client.tsx`. All of it sits
  ABOVE the session workspace (`<harness>/.workspaces/session-<pid>`), so
  `read_file` (jailed by `resolveInside`), `glob`, and `grep` (which skip
  `node_modules`) cannot see any of it — only `bash` can. Before this, the
  embedded guide pointed the agent at `packages/aai-templates/templates/` —
  a monorepo path that exists in no sandbox, and in no user project either.

  **The GUEST names those paths, not the preamble** (`toolchainPromptSection`
  in `aai-guest/studio-chat.ts`, appended to the host-composed prompt at
  `initStudioSession`). The host cannot: the harness sits at a different
  depth per layout — `/opt/aai/harness.mjs` beside `/opt/aai/node_modules` in
  the baked image, but `packages/aai-guest/dist/harness.mjs` under the
  subprocess backend, whose `node_modules` is a level higher again. A
  relative `../../node_modules` is therefore correct in production and wrong
  in local dev, and unit tests load the module from *source*, a third layout
  where it is accidentally right again — so that bug reads as correct from
  every angle a test can take. `toolchainRoot()` searches upward for
  `node_modules/@alexkroman1/aai` instead of assuming an offset, emits
  absolute paths (the only form that survives a `bash` call with an
  unexpected cwd), and returns `""` rather than naming paths it could not
  resolve. `studio-build.test.ts` asserts every path the section emits
  exists.
- **The workspace manifest declares what the agent may import.**
  `ensureProjectShape` writes a `package.json` whose `dependencies` mirror
  the scaffold's runtime set (`@alexkroman1/aai`, `aai-ui`, `react`,
  `react-dom`, `tailwindcss`, `zod` — drift-guarded against the scaffold in
  `studio-project-shape.test.ts`). It used to declare none, on the reasoning
  that they resolve from the toolchain anyway — true for the *build*, and
  exactly backwards for the *reader*: package.json is the first place a
  coding agent looks to learn what it can import, and an empty one asserted
  the opposite of the truth. Versions are pinned **exact**, read from the
  installed toolchain (`resolveWorkspaceDependencies`), because
  `add_dependency` runs `npm install <spec>` and npm reifies the whole
  manifest — a range would let the workspace materialize a different SDK
  build than the harness resolved, into a workspace-local `node_modules`
  that *shadows* the baked one. Pinned, the local copy is byte-identical and
  the shadowing is merely redundant — **but only while the pins still match
  the toolchain**, which they stop doing the moment the platform ships a new
  SDK. So an EXISTING manifest is the one exception to "existing files win":
  `reconcileWorkspacePins` rewrites the declared toolchain pins to the
  installed versions on every `ensureProjectShape`, leaving agent-added
  dependencies, scripts, and everything else exactly as found. Absent
  entries are NOT added back (npm reifies only what is declared, so an
  absent entry is no shadowing hazard, and re-adding one would override a
  deliberate removal), and an unparseable manifest is left alone for
  `npm install` to report. Toolchain-only packages (vite,
  typescript, the `@types/*`) stay undeclared: the agent never imports them,
  and every entry is one more package that install has to reify. That holds
  only IN the guest, where the toolchain is baked next to the harness — the
  CLI's `aai pull` merges them back in for the local project (see the
  `aai pull` note in the aai-cli section).
- **Guest tools carry their own deadlines** (`aai-guest/studio-tools.ts`):
  every tool is wrapped in a 120s timeout resolving to an error tool
  result, and `bash` has its own wall-clock kill (60s default, 300s max)
  with capped, tail-kept output. The client side of a hung turn is the
  composer's **Stop button** (`chat.tsx`): `useChat().stop()` aborts the
  SSE fetch to the sandbox, whose request-close handler aborts
  `streamText` and in-flight tools in the guest.
- **The composer QUEUES follow-ups typed mid-turn**
  (`aai-studio-client/src/chat-queue.ts`), Claude-Code style: the input stays
  live while the agent works, Enter parks the message in a visible, dismissable
  row above the composer, and it is sent when the turn settles — one turn at a
  time, FIFO. It used to be disabled, which silently swallowed anything typed
  mid-turn.

  **The AI SDK has no queue of its own**, and this is not an oversight to work
  around at the call site: `sendMessage` goes straight to `makeRequest`, which
  resets the chat status and overwrites the live `activeResponse` (its
  `SerialJobExecutor` serializes stream-update jobs, not requests), so a second
  send while a turn is open runs two turns against one guest session and
  interleaves their end-of-turn workspace syncs. `sendAutomaticallyWhen` is the
  nearest native hook but only re-sends the EXISTING message list, and
  appending a user message mid-stream corrupts the transcript (the SDK's
  `write` compares its streaming message against `lastMessage`, so a message
  pushed underneath it gets pushed a second time). Hence a queue held OUTSIDE
  `messages`, flushed on the settle.

  Three rules the reducer exists to hold, each covering a bug that is invisible
  without it: the flush is **latched** from dispatch until the turn is observed
  (`sendMessage` awaits before flipping the status, so a re-render in that
  window sees `ready` with the next item at the head and would start a
  concurrent turn — the same window makes a submit queue and keeps Publish
  locked, which is why `hasPendingWork` is one predicate serving both); a
  **Stop hands the queue back to the composer** rather than firing or dropping
  it (`drainText` — an explicit interrupt must not start the next turn behind
  the user's back, and the composer is a textarea partly so it can hold what
  comes back); and a **failed turn drains the same way**, because an `error`
  status never flushes while every submit joins a non-empty queue — parking it
  there wedges the composer permanently.
- **Web access**: the SDK's keyless `visit_webpage`, `get_page_design`,
  and `web_search` builtins (DuckDuckGo-backed — no key anywhere), mapped
  into the guest tool set (`createGuestWebTools` in `aai-guest/
  studio-chat.ts`). They run in the guest with open egress like all tenant
  code; `safeFetch` still screens the model-controlled URLs, and the tool
  context carries an empty env.
- **The Preview pane shows an auto-deployed PREVIEW agent; Publish is
  production.** Every settled edit — the guest's TURN-COMPLETE
  `studio/sync-workspace` (flagged `done: true`, the analog of opencode's
  `session.idle` / codex's `agent-turn-complete`; mid-turn checkpoints
  share the RPC but never carry the flag, so a half-finished tree is never
  deployed) and editor file PUT/DELETEs — schedules a deploy of the
  workspace to the project's preview slug (`<project>-preview`) through
  the same in-guest `aai deploy` path Publish uses (`studio-preview.ts`).
  **Scheduling is DURABLE**: the edit enqueues a job in
  `studio-preview-queue.ts` (Supabase's `pgmq` in production, in-memory in
  dev/tests) and a per-replica drain runs it, at-least-once — a claimed job is
  invisible for a visibility timeout rather than deleted, so a replica restart
  or a sandbox death mid-deploy no longer drops the work. Past
  `PREVIEW_JOB_MAX_ATTEMPTS` redeliveries a job is archived (that is a crash
  loop, not a slow deploy); a pg_cron sweep prunes the archive. Coalescing is
  not managed: the deploy re-reads the workspace and no-ops when `previewHash`
  matches, and the drain holds a per-project lock, so N jobs for one project
  cost one deploy plus a read each — replacing an in-process map with a dirty
  bit whose whole purpose was to approximate that without durability.
  **A queue row NEVER carries a credential**: it names the studio `userId`,
  and the drain resolves the key from Vault (`user-key:<uid>`), so a job
  redelivered to another replica can still deploy. A raw-key caller's job
  (CLI, evals) has no `userId`, so it runs only on the replica that enqueued
  it and is archived if redelivered elsewhere. Success stamps
  `previewSlug`/`previewHash` on the workspace;
  failure stamps `previewError` for the pane's banner (an auto-deploy has
  no chat turn to carry CLI output). `GET /studio/projects/:project`
  returns `previewSlug`/`previewVersion`/`previewStale`/`previewError`,
  and `GET /studio/projects/:project/events` streams the same payload as
  SSE (`project` frames), pushed on every workspace-row change (Supabase
  Realtime `postgres_changes` server-side — see `platform-events.ts`; the
  events are signals and the route re-reads the row per push), plus `chat`
  frames carrying the settled conversation whenever a turn persists, so
  other tabs/devices stay current. `GET /studio/events` streams the
  caller's project LIST the same way (scope-level workspace changes), so
  the home sidebar updates across devices. The client subscribes on
  project open / while signed in — there is NO polling loop — and keys the
  iframe by `previewVersion`, so a fresh preview reloads the frame exactly
  once; a dropped stream resubscribes with a fixed backoff, and the first
  event is always the current state so nothing is missed between GET and
  subscribe. `hasUnpublishedChanges` (`studio-workspace.ts`)
  still compares `filesHash` against `deployedHash` — the PRODUCTION
  staleness — returned as `unpublished` for the pane's Publish nudge. A
  hash rather than a timestamp for two reasons: deploys themselves write
  the workspace (which bumps `updatedAt`), and editing a file then undoing
  it should not leave the project permanently "stale". The Secrets panel
  mirrors writes to the preview slug best-effort so previews run with the
  same third-party keys. **Landing on a project wakes its preview**
  (`wakeProjectPreview` in studio-preview.ts, hung off the once-per-open
  session broker call): the embedded agent's sandbox is warmed through the
  platform's public client-config broker (`warmPreviewSandbox`) so a preview
  idle-evicted since the last visit is booting before the pane's iframe asks
  for it. It used to ALSO redeploy a stale preview, because scheduling was
  fire-and-forget in-process state that a replica restart could drop, leaving
  the pane on "Updating preview…" until the next edit; the queue owns delivery
  now, so a stale preview means a job is still queued — re-scheduling here
  would be a second mechanism answering the same question, and the weaker one,
  since it only fires when a human opens the project.
  The warm-up doubles as an existence check: a 404 from the broker means
  the agent behind the workspace's preview stamp is GONE (expired, swept,
  or deleted out from under it), so the wake clears `previewHash` and
  regenerates the preview — the stamp says "current" and would otherwise
  never redeploy. Only 404 triggers this; a 503 is a sandbox mid-boot and
  stays retry-only.

  **A stamped `previewError` is retried on open too**, for the same reason the
  404 case exists: a settled failure is the one state with NO queued job behind
  it (the job ran, failed, and left the queue), so nothing short of another
  edit would ever clear it. This deliberately does not try to tell a
  deterministic failure (broken code, which re-fails into the same banner) from
  a transient one — the only signal available is the deploy CLI's output prose,
  and sniffing it is exactly the check that breaks when a message is reworded.
  The trade is asymmetric: being wrong costs one extra deploy per
  project-open, re-stamping the banner already there, while not retrying
  strands a transient failure permanently. That is not hypothetical — a
  platform-side `deploy failed (HTTP 500)` (the anon-key Storage RLS bug) left
  projects pinned on an error banner with a working workspace behind it. The
  stamp is left in place while the retry runs, because only a SUCCESSFUL deploy
  deletes it; the pane keeps showing the last real error rather than flickering
  to "starting". A project whose first-ever preview failed has no
  `previewSlug`/`deployedSlug` and so nothing to warm — it still schedules
  (an early "no slug, give up" return meant exactly those projects could never
  retry).

  **The pane probes before it frames** (`useAgentPageReady` in
  `preview.tsx`): a stamped `previewSlug` is not proof the platform serves
  `/:slug/`. The stamp outlives the deploy behind it (the swept-agent case
  above, which the wake path regenerates) and a first or repeat deploy takes
  seconds to land, and `GET /:slug/` answers a slug with no agents row with
  a bare `{"error":"HTML not found"}` — which rendered as the ENTIRE pane,
  reading as a broken studio rather than a preview on its way. So the pane
  asks the unauthenticated agent health route (existence only — a booting
  sandbox is the framed page's own business, its client re-brokers) and
  keeps its own "Starting your preview" screen up until the page is really
  there, re-probing every few seconds. Readiness is LATCHED per slug:
  nothing re-probes a page that answered once, because dropping back to the
  placeholder would unmount the iframe and kill any voice session inside it
  — a new deploy still reaches the frame through the `previewVersion` key.
  The first probe renders as an empty pane rather than the screen, so an
  already-deployed preview doesn't flash "starting" on every open.
- **The coding agent cannot publish.** There is deliberately no deploy
  tool: going to production is the user's call, made with the Publish
  button (`POST /studio/projects/:project/deploy`) — the only path that
  touches `deployedSlug`. The prompt states this outright so the agent
  doesn't claim to have deployed or invent a production URL (the preview
  auto-deploy is platform-triggered, not an agent capability). Keep it
  that way — an agent that ships to a public URL on its own read of "make
  it live" is a surprise nobody asked for.
- **LLM selection** (`studio-llm.ts`): every studio turn runs on the
  AssemblyAI LLM Gateway **with the caller's own API key** — delivered to
  the guest via `studio/session-init` and resolved there (`resolveLlm` +
  the SDK's `assemblyAILlm` factory); the platform holds no studio LLM
  credential. The *model* (never the key) stays host config: default
  `gpt-5.5`, `STUDIO_LLM_MODEL` overrides,
  `STUDIO_LLM_REGION=eu` region-filters. The guest chat surface's bearer
  is the broker-minted per-session `chatToken` — the key stays an LLM
  credential only and never crosses the public surface.
- **Gateway regions.** `STUDIO_LLM_REGION=eu` selects the EU endpoint,
  which serves only Claude and most Gemini models. The gateway model list
  is therefore region-filtered (`GATEWAY_US_ONLY_MODELS`) and the EU
  default falls to `claude-sonnet-4-6`. Ordering the one
  `ASSEMBLYAI_GATEWAY_MODELS` array is what sets both defaults: the first
  entry surviving the region filter wins.
- **No per-request model switching.** `POST /studio/chat` accepts no
  `model` field (a stray one is stripped by the body schema, never
  honored): every turn runs on the host-configured default —
  `gpt-5.5` on the gateway. **A client can never name a provider or a
  model** — the only request-side credential is the caller's own bearer,
  which selects nothing: keep any future request-side choice validated
  host-side.
- **The coding agent itself runs on production infra**: each project gets
  one sandbox (`studio-session-broker.ts`) through the same
  `spawnWarmHarness` shape deployed agents' spawns use (a remote Modal
  Sandbox). The whole agentic loop lives in that guest — LLM calls dial
  the gateway from the guest on the caller's key, tools run on the guest
  filesystem, and `test_agent` loads the built bundle in place and can
  trial-run its tools (no db — ctx.db reports storage-not-enabled): no
  tenant data and no platform secrets in the guest.
- **Builds AND publishes run IN the guest sandbox, through the aai CLI —
  one path.** There is no host-side, out-of-process, or Modal-Function
  build backend anymore (`studio-build-runner/-entry/-protocol/-cache`,
  `studio-bundle.ts`'s import allowlist, and `studio-client-build.ts` are
  all deleted). Two guest entry points:
  - `test_agent` builds the live session workspace via
    `aai-guest/studio-build.ts`, which dynamic-imports
    `@alexkroman1/aai-cli/worker-bundler` from the **toolchain
    `node_modules` baked next to the harness** (see "Modal sandbox notes");
    workspaces materialize under that root (`workspacesRoot()`) so bare
    imports (`@alexkroman1/aai`, `zod`, `react`, `@alexkroman1/aai-ui`)
    resolve by the normal walk-up, exactly as in a user project. Diagnostics
    are scrubbed guest-side (`formatBuildFailure`) and arrive as
    `buildError` prose the coding agent can act on. The build runs
    **in-process in the harness**: a one-shot child-process variant (#845,
    motivated by Rolldown's native memory staying resident in the
    long-lived harness — ~1.5 GB per build, reclaimed only on process
    exit) was reverted after it didn't work in practice; see that PR for
    the measurements if revisiting.
  - **Publish is the LITERAL `aai deploy` CLI**, spawned in the project's
    sandbox (`aai-guest/studio-publish.ts`, the host→guest
    `workspace/deploy` RPC on the session broker — live sandbox reused,
    else an ephemeral spawn torn down after). The guest completes the
    workspace into a REAL project (`ensureProjectShape` in
    `aai-guest/studio-project-shape.ts`: package.json, tsconfig.json,
    global.d.ts, and vite.config.ts filled in from scaffold-mirroring
    copies when absent — drift-guarded against the scaffold by
    `studio-project-shape.test.ts`; a dir-local `AAI_CONFIG_DIR` carries
    the caller's key; `.aai/project.json` pins the slug) and runs
    `aai deploy --server <origin> --json --allow-missing-secrets`. Build,
    upload, config extraction (`describeBundle` on the platform's standard
    `POST /deploy` route), ownership, reserved slugs, the
    ASSEMBLYAI_API_KEY env floor,
    and the credential preflight are therefore byte-for-byte the laptop
    path. The CLI's output — success, build diagnostics, deploy errors,
    preflight warnings — returns to the client, which **posts it into the
    chat** so the coding agent sees and can fix failures.
    `--allow-missing-secrets` (new CLI flag → `credentialPolicy: "warn"`
    in the deploy body) exists because the Secrets panel needs a deployed
    slug to attach secrets to — a hard preflight failure would deadlock
    first publishes. The public origin comes from `requestPublicOrigin`
    (studio-context.ts — beside the context type, not in studio-routes.ts, so
    route modules under it can resolve the origin without importing their own
    parent) → `resolvePublicOrigin` (aai-server/public-origin.ts).
  A hostile or pathological workspace burns the tenant's own sandbox CPU —
  never the web container's. Covered end-to-end by
  `aai-server/workspace-build-integration.test.ts` (a real harness process
  publishing through the real CLI to a real listening orchestrator).
- **Settings is a PANE, not a dropdown** (`settings.tsx`): the top bar's
  segmented control switches Preview / Code / Settings, all three peers
  rendering full-width beside the chat panel (`StudioTab` in `top-bar.ts`
  is the one union; `app.tsx`'s `tab` state is the only selection). It was
  a floating 384px panel that scrolled itself — three unrelated sections
  (secrets, the CLI round-trip, Delete project) never laid out in that
  width. Nothing on the pane gates on a build or a deploy: Delete project
  has to work before anything has ever been published, so Settings is
  reachable whenever a project is open.
- **Secrets have their own section; storage has none.** Deployed-agent
  secrets are managed in the Settings pane's Secrets card, which talks to
  the platform's own `/:slug/secret` routes — the exact ones `aai secret`
  uses — and posts a note into the chat on every change (key names only,
  values withheld) so the coding agent knows which keys exist.
  **`ASSEMBLYAI_API_KEY` is platform-managed and the pane neither lists,
  deletes, nor sets it** (`PLATFORM_MANAGED_SECRETS` in `settings.tsx`): it
  is seeded at publish from the caller's own account key, so it is not a
  third-party key the user attached, and deleting it takes the agent off the
  air (an empty bearer → `unauthorized` from AssemblyAI) with nothing in the
  pane to put it back. Filtering it out of the list is also what withholds
  its Delete button — there is no row to hang one on. Setting it is refused
  by name rather than accepted: a save that then vanished from the list
  reads as a failed write. Overriding it with another account's key stays a
  CLI action (`aai secret`, or `.env` + `aai publish`), where it is
  deliberate.
- **The Database card switches `ctx.db` on per PROJECT, across both
  environments** (`database-card.tsx` → `GET/POST/DELETE
  /studio/projects/:project/database` → `aai-studio-server/
  studio-database.ts`). The platform primitive is per SLUG (`aai storage
  enable <slug>`, `/:slug/storage`) and a project is two deployed agents, so
  a per-slug toggle here would have made that the user's bookkeeping — and
  "enable the database" that only reached the preview would be a broken
  promise either way. Each environment gets its OWN schema: the preview is
  where half-finished tool code runs, and a shared one would let a preview
  turn drop the production table.
  - **Intent is stamped on the workspace (`databaseEnabled`); provisioning
    follows the SLUG.** The switch is reachable before either agent exists
    (the usual state — a project has a preview long before a publish), and
    provisioning an unclaimed slug would create a schema no cleanup path can
    see (the orphan-preview sweep and `deleteAgentResources` both key off an
    agents row) and that another tenant could inherit by claiming the name
    first. So the flag records the want, the switch provisions the slugs that
    exist, and `reconcileProjectDatabase` provisions the rest as their deploys
    claim them — hung off the ONE hook (`afterDeploy` on the session broker's
    single publisher) that both Publish and the auto preview pass through.
    The invariant: an app database exists only for a deployed, owned slug.
  - **It reaches an agent on that agent's next DEPLOY** — `DATABASE_URL` is
    read from the `app-db:` secret when a sandbox is BUILT, and deploy/delete
    are the only mutations that move sandboxes (the same trade secret changes
    make). So the switch force-redeploys the PREVIEW (clear `previewHash`,
    schedule — the `wakeProjectPreview` pattern), because that is the
    environment the user is looking at, while production waits for a Publish,
    which the card says out loud.
  - **An already-provisioned slug is never re-provisioned**: `provision`
    rotates the role's password on every call, so re-running it would
    invalidate the `DATABASE_URL` a live sandbox is holding.
  - Ownership of each slug is checked against the agents row's credential
    hashes (`verifySlugOwner`), exactly as the project-delete cascade does —
    a workspace naming a foreign slug must not become a lever on, or an
    oracle for, someone else's agent.
- **The Settings pane is also where the CLI round-trip is discoverable**
  (`cli-commands.tsx`, the "Work locally" section): the install / `aai login`
  / `aai pull <project>` / `aai dev` sequence with the project name filled
  in and one copy button each. It renders whether or not the project has
  ever been published — pulling a workspace needs no deployed slug. The
  commands carry **no `--server`**: the CLI targets its own shipped default
  origin (`DEFAULT_SERVER` in `aai-cli/_agent.ts`), which is the platform
  the commands were copied from. A studio served from anywhere else (local
  dev, a preview deploy) needs the flag added by hand — passing it is also
  what APPROVES a non-default origin for credentialed requests
  (`resolveServerUrl`), and the client cannot compare its own origin
  against the CLI's default without importing from aai-cli, which would
  widen the package boundary.
- **Vite must not be allowed to mutate `process.env`.** Vite's `build()`
  sets `NODE_ENV=production` when it is unset — a permanent, global side
  effect on the calling process. Both CLI bundlers therefore wrap the
  build in `withPreservedNodeEnv` (`aai-cli/_vite-env.ts`), which
  snapshots and restores it. Without that, `aai dev`, which rebuilds on
  every file change, flips itself to "production" on the first rebuild.
  Keep any new Vite invocation inside that wrapper.
- **Builds and deploys are TYPE-CHECKED.** `aai build` and `aai deploy`
  run the project's own `tsc --noEmit` (`aai-cli/typecheck.ts`, gated on a
  `tsconfig.json`, `--skipTypecheck` opts out), and the guest's
  `test_agent` build does the same before bundling — the bundlers strip
  types unchecked, which is exactly how the `send`/`state`
  runtime-working-but-wrong bugs shipped. Type errors reach the studio's
  coding agent as build/deploy output it can act on. The dev watch loop
  deliberately does NOT typecheck (editor/CI feedback is faster there).
- **`buildClient` runs with no `client.tsx` → `{}`** → the agent gets the
  default UI.
- **`buildClient` dedupes React** (`resolve.dedupe`), because `aai-ui`
  declares it as a *peer* dependency while the bundler resolves the bare
  `react/jsx-runtime` inside `aai-ui/dist/**` from *that file's* real path.
  Locally aai-ui's own devDependency satisfies it; a pruned production
  install can leave the build root's walk-up copy as the only React —
  reachable from the workspace root but not from `packages/aai-ui/dist`.
  Publishing died with *"Rolldown failed to resolve import
  react/jsx-runtime"* while every local build passed.
  `aai-cli/client-bundler.test.ts` guards this (every non-optional aai-ui
  peer is deduped). The Modal image installs the full workspace (dev deps
  included), so the old pruned-image packaging tests are gone with the
  Dockerfile.
- **Deployed-agent credentials.** The studio has no secrets UI, so a
  published agent would otherwise start with an empty env — its S2S
  connect sends an empty bearer token (`runtime-transport.ts`:
  `env[ASSEMBLYAI_API_KEY_ENV] ?? ""`) and AssemblyAI answers
  `unauthorized`. The bearer token a studio caller authenticates with *is*
  their AssemblyAI key (see `aai-cli/_config.ts`), so it is seeded as the
  agent's `ASSEMBLYAI_API_KEY`. That seeding is the **CLI's** job
  (`aai-cli/deploy.ts`: `env: { ASSEMBLYAI_API_KEY: apiKey, ...env }`), and
  studio Publish runs that same CLI in-guest — so it is an env **floor**, not
  an override: a key the user declared in `.env` targets a different account
  and wins. The server-side `DeployParams.defaultEnv` that used to do this
  was removed once Publish stopped calling the deploy core; `deployLocked`
  now merges only `{...storedEnv, ...env}`. This stays inside the
  credential-separation rule — it forwards *the caller's own* key, never a
  platform-owned one.
- **Client**: `packages/aai-studio-client` is a Vite-built React app;
  `studio-static.ts` resolves its `dist/` via `require.resolve` and serves
  it at `/` with hashed assets under `/studio-assets/`. When it hasn't
  been built, `GET /` serves a fallback page with build instructions
  (unit tests don't require it).
- **Every cross-origin the studio page dials must be in its `connect-src`**
  (`studioCsp` in `studio-static.ts`). There are exactly two, and both were
  omitted at some point with the SAME symptom: the browser refuses the
  request before sending it, so the client shows a bare **"Failed to
  fetch"** and the server logs NOTHING, because no request was ever made.
  (1) the project's guest sandbox — chat + tool labels, keyed by sandbox
  backend so a production policy never trusts loopback; (2) the Supabase
  project, which supabase-js dials for GitHub OAuth sign-in (the session
  restore and the code/token exchange after the redirect — GitHub itself is
  reached by top-level navigation, which connect-src does not govern). Both
  are derived
  from what the server really hands the client (`chatUrlForGuest`'s shape,
  the auth binding's own `clientConfig`) rather than hand-copied literals,
  and both are exact — `https://*.supabase.co` would trust every Supabase
  project on the internet. The sign-in case is the one that hides best:
  the page loads and `GET /studio/auth` succeeds (both `'self'`), so
  everything looks healthy until the button is clicked.
- **Reserved slugs** (`RESERVED_SLUGS` in `schemas.ts`): `studio` and
  `studio-assets` can never be claimed as agent slugs — they would shadow
  the studio routes. Enforced in `validateSlug`, `DeployBodySchema`, and
  the deploy core.

### `ctx.generate` (one-shot LLM generation)

Tool `execute` code gets one-shot LLM generation via `ctx.generate` — a
**runtime capability like `ctx.db`**. One implementation,
`createGenerateFn` (`host/generate.ts`, exported from `/runtime`), runs
wherever the runtime runs — inside the guest sandbox on the platform,
in-process under `aai dev`: descriptors resolve through the same
`resolveLlm` registry as the pipeline model, credentials from the agent env
only. Defaults to the agent's own pipeline `llm`; a per-call `llm`
descriptor (or model-id string — same shorthand as `agent({ llm })`) works
for S2S agents holding that provider's key.

`GenerateOptions.schema` accepts a Zod schema directly (or any Standard
Schema convertible to JSON Schema — `sdk/schema.ts` owns detection and
conversion), converted before the provider call; a plain JSON Schema object
also works. `GenerateFn` is generic, so a Standard Schema call returns a
typed `object`. Note zod 4.4 stamps `~standard` onto its plain
`toJSONSchema()` OUTPUT too — schema detection keys off the `_zod` instance
marker, never the `~standard` interface (`isConvertibleSchema`).
(The pattern-combinator layer that once wrapped this —
`@alexkroman1/aai/patterns`, earlier `@alexkroman1/aai/workflow` — was
removed unused; multi-step orchestration is composed directly over
`ctx.generate`.)

### Session modes

Each agent runs in one of two session modes, selected by `toAgentConfig()`
(run in the generated bundle entry) based on which top-level fields are
present in the `agent()` config:

- **Pipeline mode** (the DEFAULT — all three of `stt`, `llm`, and `tts`
  set, or none of the four provider fields set, in which case the
  all-AssemblyAI pipeline (`assemblyAIPipeline()`) is injected by
  `defaultProviders` in `sdk/providers/_default-providers.ts`) uses
  `createPipelineTransport()` in
  `packages/aai/host/transports/pipeline-transport.ts`. Here the host
  drives the LLM loop itself via the Vercel AI SDK's `streamText`, and STT
  and TTS are pluggable providers imported from the `@alexkroman1/aai/stt`
  and `@alexkroman1/aai/tts` subpath exports.
- **S2S mode** (explicit opt-in — `s2s: assemblyAIS2s()` from the main
  export, or `openaiRealtime()` from `@alexkroman1/aai/s2s`) uses
  `createS2sTransport()` in `packages/aai/host/transports/s2s-transport.ts`.
  The host opens a single WebSocket to AssemblyAI's speech-to-speech
  service; STT, the LLM loop, and TTS all run service-side and audio/events
  relay through that one socket. This is the original architecture, and was
  the implicit default before the pipeline-by-default flip. There is no way
  to reach S2S by omission — only the `s2s` descriptor selects it.

  **S2S has no agent captions on tool-call turns, and this is not our bug.**
  Measured against the live service (2026-08-03) with a standalone WebSocket
  client, no SDK in the path: `transcript.agent` is emitted for every non-tool
  reply with a matching `reply_id`, and for NEITHER reply of a tool-call turn —
  not the one carrying `tool.call`, not the one after `tool.result`. Declaring
  tools changes nothing; calling one does. So a tool-using agent renders blank
  reply text for exactly the turns that do the work, `reply.done` logs
  `agentText: "none"`, and `replyAnomaly` warns "delivered audio with no
  transcript" once per tool turn. There is no client-side remedy —
  `transcript.agent` is the only event in the protocol carrying agent text.
  Anything reading reply text (history, evals, a tau2-style harness scoring
  what the agent *said*) sees silence for a turn the user heard answered.

  Two traps here. The docs contradict each other on whether it is intended:
  the canonical message-sequence page shows `transcript.agent` inside its
  `opt tool call` branch and calls it "Per agent reply", while the
  execution-modes page's `interactive` diagram shows neither tool-turn reply
  emitting it — the service matches the latter. And
  `transcript.agent.delta` is documented in the events reference but **is not
  implemented**: zero frames arrive even for a plain greeting reply that does
  send `transcript.agent`, and it appears nowhere on the canonical page. An
  accumulator for it was added (#a42cdbd3) and removed again once measurement
  showed it could never fire; do not re-add one on the strength of the docs.

The default injection runs at every mode-derivation site — `toAgentConfig`
(so it is baked into deployed configs at build time) and `createRuntime`'s
provider resolution — before `assertProviderTriple`.
Partial provider configs are FILLED, not rejected: `defaultProviders`
supplies the AssemblyAI default for each unset stage of `stt`/`llm`/`tts`
(when `s2s` is unset), so `agent({ llm: anthropic(...) })` means "the
default pipeline with that LLM". The compile-time union (`AgentParams` in
`sdk/define.ts`) matches: any subset of the triple is legal, while `s2s`
combined with a pipeline provider or a pipeline-only tuning field still
fails `tsc` with a message naming the rule (`PipelineOnlyMisuse`) instead
of silently no-opping. `assertProviderTriple`'s partial-triple error now
only guards raw wire shapes that skipped the fill.

- **Tool-call args must be coerced before they hit a wire schema.** The AI
  SDK surfaces an unparsable/unknown tool call as a `tool-call` stream part
  whose `input` is the *raw argument string*, not a parsed object. The
  WebSocket `tool_call` event requires a record for `args`, so every emitter
  routes args through `toArgsRecord` (`sdk/utils.ts`; non-records become
  `{}`), and a failed/invalid call is recorded with an error `result` rather
  than left dangling.

- **The capture worklet** (`worklets/capture-processor.ts`) is the single
  mic-capture processor. It flushes a `slice()` copy and keeps its own
  buffer (re-reading a just-transferred view is how a mic once went
  permanently deaf), with start/stop gating, a stop → flush → `stopped`-ack
  protocol, and the dead-mic probe. Two guards remain load-bearing:
  `instantiateWorklet`'s harness honors the transfer list (`structuredClone`
  with `transfer`, which really detaches) and caps posted messages so a
  runaway loop is a named failure rather than a hang, and
  `worklets/capture-processor.test.ts` exercises the processor source.

- **Pre-connection client config**: the default client page is
  byte-identical for every agent and the CSP bars inline scripts, so the
  agent's display name and greeting reach the browser via a pre-connection
  endpoint: `GET /client-config` (dev server) / `GET /:slug/client-config`
  (platform, unauthenticated — parity with the page and the WebSocket)
  returns `{ name, greeting }` (`sdk/client-config.ts`, re-exported from
  `/protocol`). **Every server builds the body through one helper**,
  `buildClientConfig`; the platform's handler lives in
  `aai-server/client-config-handler.ts` — and on the platform name/greeting
  are PROXIED from the GUEST'S own `/client-config` (the bundle's live
  agent definition; the harness passes the loaded agent's name/greeting to
  `createServer`), never read from the stored config, which is fully opaque
  to the host. A guest that can't answer degrades to `{ sessionUrl }` only.
  In `aai-ui`, `client()`'s config
  tier renders `DefaultRoot`, which fetches the config (any failure degrades
  to the empty default, so older servers keep working) and mounts the chat
  shell; the shell uses the server-declared `name` unless `client({ name })`
  overrides it. A custom `component` ignores all of it. The `aai dev` Vite
  proxy forwards `/client-config` to the backend.

  **The session's per-attempt broker lookup uses `loadClientConfig`, not
  `fetchClientConfig`** — it returns `null` for a lookup that produced no
  answer, keeping that distinct from a server that answered and named no
  `sessionUrl`. Degrading both to `{}` is fine for name/greeting and wrong
  here: `session-core.ts` latches `serverIsBroker = false` on a config with
  no `sessionUrl`, and that latch skips the broker fetch on every later
  attempt. So one 503 — a sandbox mid-boot, or one that failed to start —
  pinned the client to the platform's `/:slug/websocket`, whose WebSocket
  redirect browsers do not follow (sessions go straight to the sandbox now),
  with no route back even after the agent recovered. Only an ANSWERED lookup
  may set the latch.

- **There is no text-only mode.** Every pipeline agent declares a real TTS
  provider, and the default `ChatView` always renders the voice `Controls`.
  The snapshot's `apiUrl` field carries the programmatic WebSocket endpoint,
  shown by `ApiUrlChip`. **It is the LONG-LIVING platform endpoint**
  (`wss://host/:slug/websocket`), never the brokered sandbox tunnel URL the
  session actually connects to — the tunnel URL dies with the sandbox (idle
  eviction, redeploy), so surfacing it hands users a link that rots. The
  platform endpoint stays valid: a plain upgrade on it resolves the live
  sandbox (booting it like the client-config broker) and answers a 302
  redirect to the sandbox's current session URL (`orchestrator-ws.ts`,
  query preserved so `?sessionId=` resumes survive). Programmatic WebSocket
  clients that follow handshake redirects land on the sandbox; browsers
  don't follow WebSocket redirects, which is fine — the browser path is the
  client-config broker.

Reference providers shipped today:

- **STT**: one of
  - `assemblyAIStt({ model: "universal-3-5-pro" })` — `ASSEMBLYAI_API_KEY`
  - `deepgram({ model: "nova-3" })` — `DEEPGRAM_API_KEY`
  - `elevenlabs({ model: "scribe_v2_realtime" })` — `ELEVENLABS_API_KEY`
  - `soniox({ model: "stt-rt-v3" })` — `SONIOX_API_KEY`

  **Never inherit the `assemblyai` SDK's connect deadline.** Its default
  `connectTimeout` is **1000 ms** and covers far more than a socket open: the
  timer is armed before the WebSocket is constructed and only cleared when the
  server's `Begin` message arrives, so DNS + TCP + TLS + upgrade + the
  service's session-start latency all have to fit. A link measuring ~50 ms to
  TLS still blew it — a slow `Begin`, or a host event loop briefly blocked
  (this is a wall-clock `setTimeout`, not an I/O deadline), is enough. All
  three attempts then failed identically and the session died on a fatal
  `stt_connect_failed`, which reads as a provider outage and is not one.
  `host/providers/stt/assemblyai.ts` therefore always sets
  `connectTimeout`/`maxConnectionRetries`/`connectionRetryDelay` from
  `STT_CONNECT_*` in `sdk/constants.ts`, overridable per agent via
  `assemblyAIStt({ connectTimeoutMs, maxConnectRetries })`. The retry policy is
  pinned rather than left to the SDK so the worst-case open time is arithmetic
  we own: it runs inside `session.start()`, so a budget exceeding
  `DEFAULT_SESSION_START_TIMEOUT_MS` could only surface as the less specific
  "session.start() timed out". `assemblyai.test.ts` asserts that sum.
- **LLM**: one of the typed factories below — each returns a pure
  descriptor; the `@ai-sdk/*` package is only imported by the host-side
  resolver (`host/providers/resolve.ts`), never by the agent bundle:
  - `anthropic({ model })` — `ANTHROPIC_API_KEY`
  - `openai({ model })` — `OPENAI_API_KEY`
  - `google({ model })` — `GOOGLE_GENERATIVE_AI_API_KEY`
  - `mistral({ model })` — `MISTRAL_API_KEY`
  - `xai({ model })` — `XAI_API_KEY`
  - `groq({ model })` — `GROQ_API_KEY`
  - `openrouter({ model })` — `OPENROUTER_API_KEY`; routes through
    [OpenRouter](https://openrouter.ai)'s OpenAI-compatible
    chat-completions endpoint, one key fronting hundreds of models
    addressed as `"creator/model"` (e.g.
    `openrouter({ model: "meta-llama/llama-3.3-70b-instruct" })`).
    Resolved via `@ai-sdk/openai`'s `.chat()` client pointed at the
    OpenRouter base URL — no extra `@ai-sdk/*` dependency.
  - `gateway({ model })` — `AI_GATEWAY_API_KEY`; routes through the
    [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), one endpoint
    fronting hundreds of models addressed as `"creator/model"` (e.g.
    `gateway({ model: "zai/glm-4.6" })`). Resolved via `createGateway`
    from the `ai` package — no extra `@ai-sdk/*` dependency.
  - `assemblyAILlm({ model, region? })` — `ASSEMBLYAI_API_KEY`; routes through
    the [AssemblyAI LLM Gateway](https://www.assemblyai.com/docs/llm-gateway)
    (OpenAI-compatible chat-completions endpoint fronting 25+ models) via
    `@ai-sdk/openai`'s `.chat()` client. `region: "eu"` selects the EU
    The client is built with a `fetch` wrapper,
    `repairOpenAiStream` (`host/providers/_openai-stream-repair.ts`): the
    gateway documents streamed responses for OpenAI models only, and its
    Claude streams break two AI SDK expectations. (1) `tool_calls` deltas
    arrive with no `id`/`type`, which makes `StreamingToolCallTracker` in
    `@ai-sdk/provider-utils` throw `Expected 'id' to be a string` and kill any
    turn that calls a tool — the wrapper fills in a synthetic id (stable per
    tool-call index within one response) and `type: "function"`, leaving real
    ids alone. (2) The final usage-only chunk carries `"choices": null` where
    the schema requires an array, so the turn dies with "Type validation
    failed" *after* the reply has streamed — the wrapper rewrites that null to
    `[]` (an absent `choices` stays absent). Every other byte passes through.
    Remove each repair once the gateway emits conformant frames.
- **TTS**: one of
  - `cartesia({ voice })` — `CARTESIA_API_KEY`
  - `rime({ voice })` — `RIME_API_KEY`
  - `assemblyAITts({ voice, language? })` — `ASSEMBLYAI_API_KEY`; AssemblyAI's
    streaming TTS over `wss://streaming-tts.assemblyai.com/v1/ws/`.
    Sharing one key with STT and the gateway means an all-AssemblyAI pipeline
    needs exactly one secret. Two protocol details that are easy to get wrong:
    the streaming sockets authenticate with the **raw** key, not `Bearer`, and
    production sends no `Begin` frame until the client speaks first, so the
    adapter must not block waiting for one (the AssemblyAI CLI does, which is
    why it marks prod streaming TTS unavailable). Turns end on `FlushDone`;
    a rejected key arrives in-band as an `Error` frame, i.e. as
    `tts_stream_error` rather than `tts_auth_failed`.

    A third, and the one that decides whether the agent feels responsive:
    **`Generate` only buffers — `Flush` is what starts synthesis.** Unlike
    Cartesia (`continue: true` synthesizes on arrival), relaying LLM deltas and
    flushing once makes time-to-first-audio the length of the whole turn, since
    the pipeline's only provider-level flush is the end-of-turn drain
    (`flushTtsAndWait`, once per reply — after every LLM step *and* tool call).
    A tool-chaining reply was silent for its entire duration, `holdPhrase` and
    the dead-air cover included, as those are just more buffered text. The
    adapter therefore buffers host-side and emits `Generate`+`Flush` per
    *sentence*: measured, that is ~350ms to first audio instead of the full
    turn, for ~4% more total audio, where flushing every word-granularity delta
    costs 2.6x and sounds disjointed. Two invariants come with it — only the
    turn's **last** acknowledgement may emit `done` (`flushTtsAndWait` resolves
    on it, so a segment's `FlushDone` leaking through advances the orchestrator
    mid-reply), and the end-of-turn flush is never sent empty, so `done` never
    depends on the service acking a contentless `Flush`. See the module doc in
    `host/providers/tts/assemblyai.ts` for the measurements.

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

### Voices

**`ASSEMBLYAI_TTS_VOICES` in `sdk/providers/tts/assemblyai.ts` is the list.**
Read it there; do not restate it here, and do not trust a voice name that
isn't in it.

That instruction is the whole point of the constant. This section used to
carry its own table — `ivy`, `sam`, `mia`, `jack`, `sophie`, `oliver` and a
dozen more — of which every entry was either deprecated or had never
existed, and it claimed a `voice:` field on `agent()` that the SDK does not
have. The provider's doc comment carried a *different* wrong list
(`azelma`, `cosette`, `fantine`, `javert`, …, none published). Two
hand-maintained lists, both fiction, both pointed at by anyone looking for a
voice.

The failure they cause is invisible at authoring time: a wrong voice id is
rejected in-band after the TTS socket opens, so the agent connects, reports
ready, and is permanently silent. Nothing before a live session catches it.
Hence one checkable constant, with the accent alongside each name and the
deprecated set kept separately in `ASSEMBLYAI_TTS_DEPRECATED_VOICES`.

On the default pipeline the voice is the top-level `voice` field —
`agent({ voice: "michael" })`, an author convenience desugared to
`tts: assemblyAITts({ voice })` in `normalizeAgentConveniences` (typed
against the catalog, invalid alongside an explicit `tts` descriptor, which
owns its own voice). An explicit AssemblyAI TTS stage picks it with
`assemblyAITts({ voice })` from `@alexkroman1/aai/tts` (or
`assemblyAIPipeline({ voice })`). S2S mode's voice rides on the `s2s`
descriptor — `voice` is a compile error there.

### Storage (`ctx.db`)

There is no KV store anymore. Persistent state is the opt-in **app
database**: enabling storage for an app (CLI `aai storage enable <slug>`; the
studio's Settings pane → Database, which switches BOTH of a project's agents
at once — see the Database-card note under "Browser studio"; or
`DATABASE_URL` in the project `.env` under
`aai dev`) gives its tools `ctx.db` — a SQL handle
(`query<T>(sql, params?)`, `$1` placeholders) backed by a per-app schema in
the platform's Supabase Postgres. Accessing `ctx.db` without storage
enabled throws with that enablement guidance. On the platform each app
gets its own schema + login role (search_path pinned, 10s
statement_timeout); credentials live in Supabase Vault. Session-scoped
scratch belongs in `ctx.state` (or the `remember`/`recall` builtins, now
in-memory per-session).

There is no Vector store anymore — `ctx.vector`, the `vector:` agent field,
the `@alexkroman1/aai/vector` subpath, and the platform-owned
`PINECONE_API_KEY` were all removed. If retrieval comes back it will be a
Supabase (pgvector) store following the same path as `ctx.db`: per-app
schema, platform-provisioned credentials in Vault.
`ctx.db` connects DIRECTLY from the guest: the app's own scoped Postgres
credentials (role/search_path pinned at provisioning) ride into the guest as
`DATABASE_URL` in the agent's boot env, and the bundle's runtime opens its
own connection — exactly as `aai dev` does with a project `.env`. The old
host-proxied `db/query` RPC is gone: it kept a versioned RPC in the
harness↔bundle contract to protect a credential that only reaches the
tenant's own data anyway.

### Guest network access

There is **no per-agent egress policy**. `allowedHosts` and its enforcement
stack (the SDK's `tool-egress`/`guest-fetch-policy` in-process guard, the
platform's Modal outbound-domain allowlist, `guest-egress.ts`) were removed:
the agent's own code runs in the guest with open egress, exactly as it does
under `aai dev`. The Modal container is the isolation boundary — a tenant
can reach the internet, not the platform. Tool code and providers `fetch`
directly.

**The network builtins follow one rule: screen only when there is no
container around us** (`builtinFetch` in `host/ssrf.ts`).

- **Contained** (a Modal Sandbox) → plain `pinnedFetch`, no SSRF screen. The
  screen guards nothing a tenant cannot bypass in one line, because their own
  tool code has open egress by design — so it constrains the *model*, not the
  author. The container is the boundary and it holds no PLATFORM credentials
  (`ctx.db`'s DATABASE_URL is the app's own scoped role).
- **Not contained** (`aai dev`, and the subprocess backend) → `safeFetch`.
  Here the host IS someone's machine: these same builtins run in the
  developer's own process, where a model-controlled URL can reach localhost,
  the LAN, or cloud metadata. That is the case the screen exists for.

Containment is **declared by the spawner**, never inferred by the guest:
`modal-sandbox.ts` sets `AAI_SANDBOX_CONTAINED=1` in the exec env and the
subprocess backend does not. "Am I a guest" and "am I contained" are
different questions — the subprocess backend runs a guest with no container
at all, so a guest-token sniff would open egress on a developer's laptop.
`ssrf.test.ts` pins that distinction.

The residual risk in a container is prompt injection steering the model at an
internal endpoint; accepted, because the sandbox has nothing internal worth
reaching and an author who wants that can already write it.

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
| Platform sandboxes need Modal credentials in production only | prod is stricter | `aai dev` runs tools in-process; the platform spawns real Modal sandboxes in production (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`), and an isolation-free child process in local dev — see "Modal sandbox notes". |

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

### Client audio path (browser ⇄ server)

Both legs carry **raw PCM16 over the session WebSocket** — 384 kbps down at
24 kHz, 256 kbps up at 16 kHz, uncompressed, with the mic streaming
continuously (barge-in needs it open). That budget is the backdrop for
everything below: a jitter buffer absorbs *jitter*, and no size of buffer
fixes a link that cannot carry the bitrate in real time.

**Playback is a jitter buffer with hysteresis, not a startup delay**
(`aai-ui/worklets/playback-processor.ts`). It fills to `PLAYBACK_JITTER_MS`
before a turn speaks, and on an underrun it returns to filling — to the
shorter `PLAYBACK_REFILL_MS`, because mid-reply a long wait is itself a hole
in the speech. The re-arm is the whole point: while the gate only guarded the
*start* of a turn, one stall left `readPos` chasing `writePos` and every later
quantum emitted a few real samples padded with silence, so a single network
hiccup turned the rest of the reply into ~5ms fragments — stutter through
every word rather than one pause. A starved quantum never advances `readPos`,
so buffered audio survives intact.

Gaps are **concealed**, not zero-filled: the worklet loops the retained tail
of played audio under a decay to silence (`PLAYBACK_CONCEAL_FADE_MS`). A hard
zero-fill is a discontinuity mid-word, which is what makes a brief stall sound
like breakage rather than a pause.

**Underruns are reported, in WebRTC's counter shape.** Each turn's `stop`
message carries `concealedSamples`, `silentConcealedSamples` (a subset, as in
`getStats()`), `concealmentEvents`, and `silentConcealmentEvents`, surfaced as
`VoiceIOOptions.onPlaybackStats` (the default session leaves it unwired). Nothing
else marks an underrun — the session still reports `"speaking"` and `done()`
still settles — so this is the only way to tell a turn that needed its cushion
from one that didn't, and the only honest basis for retuning
`PLAYBACK_JITTER_MS`. A high `silentConcealedSamples` share means the stall
outran what concealment can cover, i.e. a bandwidth problem rather than a
tuning one.

**The server paces audio out at a bounded lead** (`aai/host/audio-pacer.ts`,
wired into `ws-handler.ts`'s `ClientSink`). TTS outruns playback, so relaying
each provider frame on arrival put a whole reply into the socket buffer at
once; on a slow link that is seconds of queue the server cannot see into,
bounded only by the `MAX_CLIENT_WS_BUFFERED_BYTES` disconnect.
`CLIENT_AUDIO_LEAD_MS` **must stay above `PLAYBACK_JITTER_MS`** — the lead is
the client's only source of cushion, so pacing at exactly real time would
leave the playback buffer unable to fill. Holding audio back makes two
orderings load-bearing, both enforced by the pacer:

- `audio_done` is queued **behind** pending audio. It is a turn boundary; the
  worklet takes it as "this is all there is", so an early one truncates the
  reply.
- A `cancelled`/`reset` event **discards** held audio. The client flushes its
  own buffer on those events, so anything still held would arrive afterwards
  and play as an orphan fragment.

**Capture runs on its own AudioContext at the STT rate**, and the worklet
converts no rates (`aai-ui/worklets/capture-processor.ts`). The browser's
resampler is band-limited; the linear interpolation this replaced folded
everything above the new Nyquist back into the band as aliasing. Playback
keeps a separate context at the TTS rate, and the two collapse into one when
the rates match. There is deliberately **no fallback resampler**: `audio.ts`
asserts the browser honored both requested rates and fails init otherwise,
because a context at another rate either ships audio to a socket that declared
a different rate or plays PCM at the wrong speed — a loud failure beats
either.

**Capture is raw voice, echo cancellation aside.** Both `getUserMedia`
call sites (the WebSocket mic and `createPttRecorder`) share one exported
`VOICE_CAPTURE_CONSTRAINTS`, because copies of the object drifted apart
trivially. `autoGainControl`, `noiseSuppression`, and `voiceIsolation` are all
**off**: each rewrites the signal before STT sees
it — AGC continuously retargets level, so it rides the noise floor up through
silence, while
suppression and isolation discard signal and can gate a quiet room to *exact*
zeros, which is also what a dead mic looks like. `echoCancellation` stays on:
the mic is open while the agent speaks (barge-in needs it), so without AEC the
agent hears itself and interrupts its own reply.

**A dead microphone is detected once per session.** An OS-muted or wrong input
device delivers digital silence, which from every other vantage point is
identical to a user who has not spoken: socket up, session listening, no turn
ever committed. The capture worklet watches the first `MIC_SILENCE_PROBE_MS`
for any nonzero sample (a live mic in a quiet room still carries a noise
floor) and reports once via `VoiceIOOptions.onMicSilent`. It disarms on the
first real sample, so it costs nothing after the window and cannot fire
mid-session.

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

### Default values and magic numbers

All numeric constants live in `packages/aai/sdk/constants.ts` (client-audio
budgets are split into `sdk/client-audio-constants.ts` for file-length reasons
and re-exported from `constants.ts`, so the import path is unchanged). Key
defaults that affect agent behavior:

| Default | Value | Where applied | Notes |
| --- | --- | --- | --- |
| `maxSteps` | 10 (`DEFAULT_MAX_STEPS`) | `constants.ts` | Max tool calls per reply. Prevents runaway tool loops; sized so multi-tool chains plus a repair retry fit. |
| `toolChoice` | `"auto"` | runtime resolution | LLM decides when to use tools vs respond directly. Full AI SDK set: `"auto"`, `"required"`, `"none"`, `{ type: "tool", toolName }`. |
| `idleTimeoutMs` | 300,000 (5 min) | `constants.ts:26` | `0` or non-finite disables the timer entirely. Re-armed on every inbound audio frame (`resetIdle`), so it measures silence, not call length. On expiry session-core emits `idle_timeout` **and closes the socket** — the event alone retires nothing (clients treat it as informational and wait for the close), so for a long time an idle session lingered and only Modal's 300s input cap reaped it. |
| `silenceTimeoutMs` | unset (disabled) | `pipeline-silence.ts` | Pipeline only: assistant proactively takes a turn after this much user silence. Capped at `MAX_CONSECUTIVE_SILENCE_NUDGES` (3) back-to-back nudges until the user speaks again. `silencePrompt` customizes the injected instruction (default `DEFAULT_SILENCE_PROMPT`); it is kept in LLM history but never emitted as a user transcript. |
| `minBargeInWords` | 2 (`DEFAULT_MIN_BARGE_IN_WORDS`) | `constants.ts` | Pipeline only: interim-transcript words before user speech interrupts the in-flight reply. 2 keeps one-word backchannels from cutting the agent off; sub-threshold finals are answered after the reply. |
| `interruptionMinDurationMs` | 500 (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`) | `constants.ts` | Pipeline only: sustained speech (ms since the utterance's first partial) required before an interim-triggered barge-in fires — LiveKit's `min_interruption_duration` analog. Non-zero by default: room noise and echo of the agent's own voice produce short interim transcripts, and each one used to abandon a reply mid-word. Finals are never gated. 0 disables. |
| AssemblyAI `min_turn_silence` | 2000 (`DEFAULT_MIN_TURN_SILENCE_MS`) | `host/providers/stt/assemblyai.ts` | End-of-turn silence before the service commits a `final`. Endpointing lives in the STT provider — the pipeline transport commits a turn on every final — so this is what keeps a mid-utterance pause from splitting one request across turns. Raised from 1500 after Full-Duplex-Bench v3 caught 1500 splitting real hesitant speech mid-sentence; the benchmark's own breakdown localizes it to *silence* rather than word accuracy (self-corrections and false starts passed 100%, hesitations 33%, pauses 57%). Override via `assemblyAIStt({ minTurnSilenceMs })`. |
| Deepgram `endpointing` | 1500 (`DEFAULT_DEEPGRAM_ENDPOINTING_MS`) | `sdk/providers/stt/deepgram.ts` | Same role as `min_turn_silence` above — the provider owns end-of-turn; override via `deepgram({ endpointing })`. |
| `holdPhrase` | `"One moment."` (`DEFAULT_HOLD_PHRASE`) | `pipeline-stream.ts` | Pipeline only: spoken when a turn opens with a tool call and no speech. `""` disables. |
| `errorPhrase` | `"Sorry, I had a problem just then. Could you say that again?"` (`DEFAULT_ERROR_PHRASE`) | `pipeline-turn-outcome.ts` | Pipeline only: spoken when the turn's LLM stream fails, so a provider outage hands the conversation back instead of going silent. A failed turn produces no text, so nothing would otherwise reach TTS and the only trace is a `llm` session error the browser surfaces without a sound. `""` disables. |
| dead-air cover | 2000 ms (`DEFAULT_DEAD_AIR_COVER_MS`) | `pipeline-stream.ts` | Pipeline only: tool execution that sends nothing to TTS for this long gets a `DEAD_AIR_COVER_PHRASES` filler — unlike `holdPhrase` this is time-based, so it still fires after the model has spoken, and repeats across a tool chain with the wait doubling each time. `holdPhrase: ""` disables both. |
| `falseInterruptionTimeoutMs` | 2000 (`DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS`) | `constants.ts` | Pipeline only: a partial-triggered barge-in that never commits a user turn (STT noise) resumes the interrupted reply via a synthetic continuation turn after this window. A mid-turn cut resumes from the `[interrupted]` history marker (`DEFAULT_FALSE_INTERRUPTION_PROMPT`); a cut during the client playback tail — the reply finished server-side but was still playing out — resumes with a prompt quoting the estimated last-heard words (`buildTailResumePrompt`), unless less than `TAIL_RESUME_MIN_UNHEARD_MS` of audio was unheard. 0 disables. |
| `maxHistory` | 200 | `constants.ts:52` | Sliding window of conversation messages retained. **The LLM view is trimmed by `capLlm`, not `cap`** (`pipeline-history.ts`): that view holds tool-call/result PAIRS, and an index trim can land between an assistant `tool-call` message and the `tool` message answering it. Both providers reject an unmatched tool result outright (OpenAI: "messages with role 'tool' must be a response to a preceding message with 'tool_calls'"), so every remaining turn of the call failed at the provider and the caller heard `errorPhrase` instead of a reply. Turn sizes vary — 2 messages for a text-only turn, 4 for one tool call, more for a chain — so the window drifts out of alignment with turn boundaries on its own; nothing about the conversation has to be unusual. Only the FRONT is trimmed, so dropping leading `tool` messages is sufficient. A uniform turn size hides the whole class: 4 divides 200, so every trim lands on a turn boundary. |
| resume grace | 120,000 (`SESSION_RESUME_GRACE_MS`) | `constants.ts` | How long a disconnected session's per-session tool state (`ctx.state`) survives awaiting a `?sessionId=<id>` resume — the runtime's stateMap sweep (in-guest on the platform, in-process under `aai dev`) waits it out, cancelled when the session resumes. Sized above the browser client's worst-case automatic-reconnect span (~105s); the client reconnects with the sessionId from the `config` frame, so the resumed session finds its state under the same key. |
| `builtinTools` | `DEFAULT_BUILTIN_TOOLS` (`think`, `remember`, `recall`, `calculate`) | `constants.ts` | Cognitive built-ins on by default: private reasoning scratchpad, session notes, safe calculator. Set `builtinTools` explicitly (including `[]`) to override. `web_search`/`visit_webpage`/`get_page_design`/`fetch_json`/`run_code` remain opt-in. A custom or relayed tool with the same name wins — the built-in is dropped. |

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
- **`aai` has a randomized interleaving fuzz over the pipeline transport**
  (`host/integration/pipeline-fuzz.integration.test.ts`, run by
  `pnpm --filter @alexkroman1/aai test:integration`; needs no API keys). The
  scripted specs in `host/transports/` each assert ONE interleaving; this drives
  random event orderings and checks GLOBAL invariants — turn serialization, no
  callback after `stop()`, no write to a closed provider session, reply-text
  integrity, no audio after a reply's own `replyDone` — plus the strongest
  oracle, validating every LLM request payload the way Anthropic and OpenAI do
  (an unmatched `tool` result is a hard 400). That oracle is what surfaced the
  `capLlm` bug above. Two rules when extending it: **an oracle must be a
  property a real provider or client enforces**, and **the generator must not
  itself break a provider contract** — an early draft emitted TTS audio at
  arbitrary moments, and the truncation oracle fired on the generator rather
  than the transport. It also asserts COVERAGE FLOORS (barge-in, tool
  execution, history trimming, reply completion): an all-green fuzz proves
  nothing if the random walk never entered the state, so a suddenly greener
  result is usually a broken generator, not a fixed bug. Discovery and
  regression are separate jobs — findings get a deterministic spec of their own
  (the `capLlm` one lives in `pipeline-history.test.ts`), because whether a
  random walk reaches a given alignment is luck.
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

### Stateless server (aai-server)

The platform server holds no cross-request durable or coordination state in
process — any replica can serve any request, and a replica restart loses
nothing but live control-channel connections (voice sessions don't pass
through it at all). Everything durable lives in Supabase (bundles and
client files in Storage, agent env + app-db credentials in Vault, studio
workspaces/chats and per-app data in Postgres), and cross-replica
coordination lives in the same Postgres over `SUPABASE_DB_URL`.

**The schema is DECLARED, in `supabase/migrations`** — not created lazily by
the store that reads it. Every `aai_platform` store used to call a memoized
`create schema/table if not exists` on first use (`pg-ensure.ts`), which is
why pg_cron sweep bodies were wrapped in `to_regclass` guards: on a fresh
database a job could fire before its table existed. Migrations delete both,
plus the boot-time publication/grant setup. The trade is deploy ORDERING —
`supabase db push` before the deploy — and a missed migration now fails
loudly with "relation does not exist" instead of being papered over by a lazy
create that runs on whichever connection first noticed.
`platform-schema.test.ts` is the guard in both directions: every
`aai_platform.<table>` the source queries must be declared in a migration,
and the store suites assert that no store issues DDL:

- **Per-slug mutation lock** (`platform-lock.ts`): deploy/delete/secret/
  storage mutations for a slug run under a **Postgres advisory lock**
  (`createPgSlugLock`), injected as the `slugLock` binding. This was a lease
  table, on the reasoning that "advisory locks are connection-scoped and
  `SqlExec` runs over a pool, so acquire and release could land on different
  connections" — true, and the answer is to stop using the pool:
  `AdminDb.reserve()` (postgres.js `sql.reserve()`) holds ONE connection for
  the critical section. That deleted the table, the 250ms poll loop
  (`pg_advisory_lock` queues the waiter inside Postgres), the lease sweep,
  and the "not renewed while held" caveat — an operation now holds the lock
  until it finishes, however long that takes, and a dropped connection
  releases it, so a crashed replica frees its slug immediately. The acquire
  deadline is `lock_timeout` on that connection; Postgres raises `55P03`,
  which becomes `SlugLockTimeoutError` → 409. The key is
  `pg_advisory_lock(SLUG_LOCK_NAMESPACE, hashtext(slug))` — two ints so the
  namespace can never collide with another advisory-lock user in the
  database. It still takes the in-process `withSlugLock` first, now so a
  local waiter doesn't hold a reserved connection open while blocked.
  `sandbox-resolve.ts` stays on the in-process lock deliberately: it guards
  this replica's slot cache, a legitimately process-local resource.

  **`SUPABASE_DB_URL` must be the direct, SESSION-mode connection string.** A
  transaction-mode pooler (Supavisor's port 6543, `pgbouncer=true`) returns
  the server connection between statements, so an advisory lock taken through
  one is not held by whoever thinks it holds it — silent loss of mutual
  exclusion. `assertSessionModeUrl` refuses such a URL at boot rather than
  letting that be discovered later. Per-app databases are unaffected: they are
  fronted by the pooler on purpose and take no advisory locks.

  **The binding is wrapped in `createMutationLock`, and must stay wrapped:
  taking the lock also drops this replica's cached view of the slug.**
  Exclusion alone is not enough, because every mutation is a read-modify-write
  over a read-through row cache — `handleSecretSet` merges onto `getEnv`,
  `deployLocked` merges the stored env *and* `credential_hashes` off
  `getAgent`. A row that replica A wrote moments ago can be invisible to
  replica B's cache, so B computes its merge from a pre-lock snapshot and
  writes the older value back. The two writes were serialized perfectly and
  one of them still vanished, silently: a secret reverts, or a deploy drops
  a co-owner's credential hash. Invalidation belongs at lock acquisition
  (one place, in `platform-lock.ts`) rather than per route — a route that
  forgets produces no error at all. Only the row caches are dropped: blob
  caches are content-addressed and cannot go stale. The broker path
  deliberately does NOT go through this wrapper — it mutates nothing.
- **Studio rate limits** (`aai-studio-server/studio-rate-limit.ts`): the
  chat and project-create windows are rows in
  `aai_platform.studio_rate_limits` (`createPgRateLimiter`, one atomic
  upsert per check), so the limit holds platform-wide instead of
  multiplying by the replica count. Fail-closed: a database error
  propagates rather than silently unmetering the LLM-proxy route. Expired
  rows are swept by pg_cron (`aai-server/pg-cron.ts`), not in-process.
- **Session resume needs no cross-replica store**: sessions live in the
  guest sandbox, not on a replica — a `?sessionId=<id>` reconnect
  re-brokers via `GET /:slug/client-config` and lands on the SAME sandbox,
  whose in-guest runtime holds the state through the resume grace window.
  (The old host-side session-state persistence died with the host relay.)

What deliberately stays in-process, and why it doesn't break statelessness:

- **The slot cache and sandboxes** — a resident sandbox is a
  per-replica accelerator; the agents row's change stream (below) keeps
  residents correct across replicas, and losing them costs a rebuild,
  never correctness. WHICH sandbox a slug runs is not per-replica state,
  though: that lives in `aai_platform.sandbox_registry`, so a cold broker
  routes to a live peer's guest rather than spawning the fleet's Nth copy
  (see "No horizontal sandbox scaling" below).
- **Caches** (bundle-store row/version caches, hash-keyed immutable blob
  caches, the auth hash cache, the studio build cache) — TTL-bounded or
  content-hash-keyed read-through caches whose staleness windows are
  documented at each site.
- **The in-process workspace/slug mutexes** — kept *under* the distributed
  mechanisms so local writer fan-out doesn't burn the cross-replica
  retry/lease on itself.

### Split services (aai-server / aai-studio-server)

Two packages, one surface each. `aai-server` is the AGENT service plus the
shared platform core (stores, locks, epochs, sandbox machinery — exported to
the sibling via `"./*": "./*.ts"` exports; `platform-barrel.ts` is the
sanctioned path to its `_`-internal utilities). `aai-studio-server` is the
STUDIO service; its entry also hosts the `combined` composition
(`AAI_SERVICE` combined|studio — a path dispatcher over both apps, which is
what `pnpm dev:aai-server` and pre-split deployments run). Deploys are
per-service Modal apps (`aai-server-web`, `aai-studio-web`, each package's
`modal_deploy.py`). The split exists because the two workloads scale
differently — studio chat turns are LLM-bound and bursty, the agent
service's control work is light — and one container served both badly.

- **One public origin.** Browsers only ever talk to the agent service; in
  `agent` mode it reverse-proxies `/`, `/favicon.ico`, `/studio-assets/*`,
  and `/studio/*` to `STUDIO_UPSTREAM_URL` (`studio-proxy.ts` — streaming
  passthrough, SSE included). This is what keeps the preview iframe working:
  agent pages are served `X-Frame-Options: SAMEORIGIN`, so the studio must
  share their origin. The proxy forwards identity-encoded (drops
  `accept-encoding`) because undici's fetch decompresses bodies but leaves
  `content-encoding` headers in place. Shared base middleware lives in
  `app-middleware.ts` so the two apps can't drift on CORS/framing policy.
- **Never derive the public scheme from the request URL** — use
  `resolvePublicOrigin` (`aai-server/public-origin.ts`). Modal terminates TLS
  at its edge and forwards plain HTTP to the container (its ASGI proxy adds
  only `X-Forwarded-For`, never `X-Forwarded-Proto`), so `new URL(c.req.url)`
  is **always** `http:` in a handler, whatever the browser used. Resolution
  order: `AAI_PUBLIC_ORIGIN` → `x-forwarded-host`/`-proto` (a real proxy in
  front, including this platform's own studio proxy, which sets both *from
  this resolver*) → infer, loopback being the only `http`.

  Both places that had rolled their own cost real outages. Studio **Publish
  died on `401 Missing Authorization header` from its own platform**: the
  guest was handed `http://<public host>`, its `aai deploy` POST was
  308-redirected to `https://`, and `fetch` strips `Authorization` across a
  scheme change (different origin per the Fetch spec). The request arrived
  unauthenticated, so the CLI reported an invalid API key it had in fact sent
  correctly — and the studio proxy's own `x-forwarded-proto: http` propagated
  the same wrong answer into split mode. The bare-slug redirect
  (`/:slug` → `/:slug/`) separately echoed the cleartext URL back as an
  absolute `Location`, bouncing https browsers through `http://`; it is now
  relative, which no scheme can taint.
- **Cross-service invalidation is the agents row's CHANGE STREAM**
  (`agent-store.ts` for the row; `platform-events.ts` /
  `realtime-events.ts` for the stream; `watchAgentInvalidation` in
  `sandbox-resolve.ts` for the handler). Mutation handlers ONLY write the
  row — deploy upserts it (bumping `version`), delete removes it — and
  every replica, the writer included, reacts to the resulting Supabase
  Realtime `postgres_changes` event: the handler drops the bundle-store
  row caches, re-reads the version fresh (events are signals, never
  payloads), and retires a resident at a different version (terminates on
  a deleted row — a deleted agent must stop answering, not drain). This is
  how a studio-service Publish reaches the agent service's resident
  sandboxes within seconds. There is no separate signal to send — the row
  write IS the notification, so no bump can be missed — and no duplicate
  detection paths: the per-broker lazy version check and the idle sweep's
  `SupersededCheck` were both removed when the change stream replaced
  them, so `resolveSandbox` serves any LIVE resident as-is and the idle
  sweep is purely about idleness. (Worker/client blob caches are
  hash-keyed and immutable — a stale row is a consistent OLD deploy, never
  a torn mix, and a wrong blob is structurally impossible.) The handler's
  version comparison under the slug lock is what makes duplicated or
  reordered events harmless; an unreadable version logs and leaves the
  resident alone rather than killing a healthy sandbox.

  **Deploy and delete are the ONLY mutations that move sandboxes.** Secret
  and storage changes write Vault and bump nothing — they take effect on
  the agent's next deploy (or whenever its sandbox is next rebuilt). That
  trade deleted the whole secret-invalidation mechanism (the old
  `aai_platform.slug_epochs` table); the documented way to apply a secret
  now is to redeploy.

  **Supabase setup this depends on lives in `supabase/migrations`**, applied
  with `supabase db push` BEFORE the code that queries it: the `aai_platform`
  schema and its tables, the watched tables' membership in the
  `supabase_realtime` publication, the `service_role` SELECT grants, and the
  `pg_cron`/`pgmq` extensions. Realtime validates channel filter columns (and
  gates row visibility) against what the subscriber's claimed role can SELECT,
  and the app-created `aai_platform` schema gets none of Supabase's default
  `public` grants, so without those grants every filtered subscribe fails with
  `invalid column for filter <col>`. Only the pg_cron SCHEDULING stays at boot
  (`schedulePlatformSweeps` via `bootstrapPlatformDb`), because the sweep
  bodies are defined in TypeScript and change with the code that owns them.
  The env carries `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for the
  Realtime socket, required in production alongside `SUPABASE_DB_URL`.
- **A superseded sandbox is RETIRED, not terminated** (`sandbox-retire.ts`).
  A mutation replaces the code a slug runs; it says nothing about the calls
  already in flight on the old sandbox, and closing their sockets inline —
  which every mutation path used to do — meant shipping during the day
  dropped live conversations. `retireSlot` splits the two things
  "terminate" conflated: it detaches the sandbox from the slot
  **synchronously, with no await in between** — the broker is the only
  routing point, so from that instant no NEW session can reach it and the
  slug is free to rebuild — then FIRE-AND-FORGETS one deadline-carrying
  `POST /manage/drain` to the guest. The GUEST owns the drain from there
  (`harness-agent-mode.ts`): it refuses new direct-dial sessions, exits the
  instant its last session ends, and exits at the deadline
  (`SANDBOX_RETIRE_DRAIN_MS`, 10 min, env overridable; 0 terminates
  immediately) regardless — a retired sandbox is a billed guest running
  superseded code. The host keeps NO drain state and runs no poll loop; an
  unreachable guest (the drain request rejects) is terminated on the spot.
  - **Retirement is for superseded, not gone.** A failed VM, an exited
    guest, and a deleted agent stay on `terminateSlot`: there is nothing to
    drain, and a deleted agent must stop answering rather than keep taking
    calls for ten more minutes.
  - **Process teardown deliberately does NOT chase retired guests** — they
    are off the slot map and self-governing; their drain deadline is
    minutes past the container grace period, and Modal's sandbox `timeoutMs`
    is the backstop behind everything.
- **The studio service holds an always-empty slot cache** — the shared
  mutation cores' local sandbox teardowns are deliberate no-ops there,
  while the deploy's row-version bump does the real work. It shares
  everything else through Supabase and spawns its own Modal sandboxes for
  `test_agent`/config extraction.
- **The web service autoscales** (constants block in `modal_deploy.py`),
  bounded by `MIN_CONTAINERS`/`MAX_CONTAINERS`. Scale-in is FREE for voice
  sessions: a replica going down RETIRES its agent guests instead of
  waiting on or terminating them (`teardownSandboxes` — one awaited,
  deadline-carrying drain per guest, then exit).

  **Shutdown has to stop BOOTING sandboxes before it stops serving.**
  Flipping `draining` only makes `/health` fail; the proxy stops routing here
  when it notices, up to a health-check interval later. A request landing in
  that window used to take the cold broker path, find an emptied slot, and
  spawn a guest seconds before the process exited — ORPHANED, since no slot
  referenced it and nothing held it, billing until Modal's idle timeout. Two
  guards, in order of importance: `brokerSessionUrl` refuses to boot a new
  sandbox when `isDraining` (503, so the client re-brokers onto a live
  replica) while still serving a LIVE resident, which orphans nothing; and
  `teardownSandboxes` waits `SHUTDOWN_GRACE_MS` (3s, env-overridable) before
  emptying the slots, so requests that would have been served still are. The
  wait is deliberately short — it spends the same SIGTERM allowance the
  drains need, and an undelivered drain is the worse failure. The studio-only
  service passes 0: its slot cache is always empty, so it has no such window.
  Sessions dial the sandbox
  tunnel directly and the guest has no dependency on the replica, so live
  calls finish in the guests on their own clock after the replica is gone;
  the next replica's broker spawns fresh sandboxes on demand. The old
  count-guest-sessions-and-wait shutdown drain (`liveGuestSessions`,
  `drainActiveSessions`, `SHUTDOWN_DRAIN_MS`) was deleted — it could only
  ever delay the exit, and past its 120s budget it cut the very calls it
  existed to protect. Studio guests DO go down with the replica (the
  broker's `dispose()`): their coding-agent sessions live on the host's
  control channel, so a dead host makes them useless.
- **Shutdown ENDS long-lived responses; it must never let the process exit
  destroy them** (`live-streams.ts`, wired into `serve-lifecycle.ts`). SSE
  streams never end on their own, so `server.close()` waited out
  `SHUTDOWN_CLOSE_FALLBACK_MS` and `process.exit(0)` then destroyed the
  sockets — cutting each chunked body before its terminating `0\r\n\r\n`.
  That is a protocol error to whatever is reading, and in production the
  reader is Modal's in-container ASGI proxy, which surfaced it as a recurring
  unretrieved-task `ClientPayloadError: Response payload is not completed:
  <TransferEncodingError: 400, 'Not enough data to satisfy transfer length
  header.'>` on `GET /studio/projects/<x>/events`, with nothing tying it to a
  replica scale-in. Both ends of the hop register: the studio's SSE pusher
  (`studio-sse.ts`) and the agent service's PROXIED passthrough of it
  (`gracefulEventStream` in `studio-proxy.ts` — `text/event-stream` only, so
  assets and JSON stay zero-copy). Ending them is also what lets
  `server.close()` complete, so shutdown stops hitting the fallback timer at
  all. The client sees a clean stream end and resubscribes on its existing
  backoff (`useEventStream`). Any future long-lived response owes the same
  registration — the wire-level guard is `live-streams.test.ts`, which reads
  raw socket bytes because a handler-level assertion passes with the bug
  present.

  Three properties of the ending itself, each of which was a hole that put the
  truncation back while the registry looked correct:
  - **It runs FIRST, before the service teardown.** Ending a stream is
    synchronous and depends on nothing, while `onShutdown` sleeps
    `SHUTDOWN_GRACE_MS` and then awaits one drain request per resident guest —
    seconds at best, unbounded when a guest is unreachable. Modal SIGKILLs the
    container when its stop grace lapses, so ending them *after* the teardown
    made the graceful end contingent on sandbox teardown finishing in time.
  - **The registry LATCHES closed.** Nothing drains it twice, so a stream
    registered after shutdown began would be held open until the exit destroyed
    it; `registerLiveStream` therefore ends a late arrival on the spot instead.
    That is not the rare case — the client's first reconnect backoff is 3s and
    shutdown deliberately keeps serving for `SHUTDOWN_GRACE_MS`, so a
    resubscribe landing mid-shutdown is the MODAL case. (`resetLiveStreams` is
    a test-only seam for the latch.)
  - **The crash path ends them too** (`installProcessSafetyNets` in
    `service-config.ts`): `uncaughtException` → `process.exit(1)` destroys
    sockets exactly as a scale-in does.
- **A long-lived connection is ONE Modal input, so the function `timeout`
  bounds CALL DURATION** — not request latency. Both services therefore set it
  explicitly (`FUNCTION_TIMEOUT_SECS` = 4h on the agent app, matching
  `DEFAULT_SANDBOX_TIMEOUT_MS`; 30 min on the studio app, whose longest input
  is a cold-sandbox Publish). Left unset, Modal's default is **300s**, and it
  severed every in-process session (the old `?host=1` host mode, since
  removed) at exactly five minutes, mid-word — the client saw a bare "not
  connected" and the server logged nothing, because nothing in our code did
  it. No session runs in the server process anymore — browser voice sessions
  dial the guest sandbox's tunnel directly, and `/:slug/websocket` upgrades
  are handshake redirects — but SSE streams through the studio proxy sit
  under the same cap, so it stays pinned rather than inherited. The sandbox
  layer hit the same trap first and documents it in `modal-sandbox-env.ts`.

  **`STUDIO_FUNCTION_TIMEOUT_SECS` (30 min) is a latent split-mode hazard, not
  a live one.** It was reasoned as headroom for a cold-sandbox Publish, on the
  premise that "nothing here is long-lived by design" — true of WebSockets
  (chat streams browser→guest directly) and false of the event streams a
  browser holds open for as long as a project is on screen, which did not exist
  when the value was set. Both `GET /studio/events` and
  `GET /studio/projects/:project/events` are open for hours. It does not bite
  today only because production runs `combined`, so those routes are served by
  the agent app under its 4h. Deploying split without raising it would start
  reaping them.

  **Most `TransferEncodingError`s in the log are NOT truncation we caused.**
  Measured over 6h of production `aai-server-web` logs (2026-08-05): 38 SSE
  stream completions, 40 of these errors, pairing 1:1 by timestamp — at every
  duration from 25s to 1375s, and continuing across a redeploy that shipped the
  registry above. Modal's `_proxy_http_request.send_response()` is still
  iterating the upstream body when the client goes away, and Modal never awaits
  that task ("Task exception was never retrieved"), so ONE lands in the log per
  abandoned stream. The browser is already gone when it fires. Two corollaries
  before treating a spike as a regression: **join it to Modal's request log
  first** — the `duration` on the completion line at the same second is the
  stream's whole lifetime, which is what separates a client abort (any
  duration, all of them multiples of `SSE_HEARTBEAT_MS`, because nothing in the
  chain notices a departed client until data flows) from a real deadline (a
  tight cluster at one value); and a rise in the count usually means a client is
  churning subscriptions, not that a stream was cut.

  **Capping the streams' own lifetime was considered and rejected.** It cannot
  reduce the above — a tab close still aborts whatever stream is open — while
  `projectPayload` carries `files: workspace.files`, so every forced recycle
  re-sends the whole workspace file map to every open tab. If split mode ever
  ships, raise the ceiling rather than adding a cap under it.

### Modal sandbox notes

- **Two backends, selected by `sandbox-backend.ts`.** Guest sandboxes are
  **remote Modal Sandboxes** (`modal-sandbox.ts`) in production and a plain
  **child process** (`subprocess-sandbox.ts`) in local dev. The policy is
  three rules: an explicit `SANDBOX_BACKEND` (`modal` | `subprocess`) always
  wins (unknown values throw — a silent fallback would look like the override
  not working); otherwise not-local-dev → `modal`, unconditionally; otherwise
  → `subprocess`. `isLocalDev` is false whenever `SUPABASE_STORAGE_BUCKET` is
  set, so **production can never resolve the host-local backend**, and fails
  loudly without `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (or a `~/.modal.toml`
  profile) rather than degrading. There is **no fallback between backends at
  spawn time**: a failed spawn is a failed spawn.
- **Two tiers, and deliberately no middle one.** A local-container backend
  (Apple's `container` CLI) sat between these and was removed. The reasoning
  is worth keeping, because "run a real container locally" keeps sounding
  like the obvious answer: it could never give production confidence — only
  `SANDBOX_BACKEND=modal` can, since that IS production — while it cost a
  second delivery mechanism for the in-guest build toolchain (Modal bakes one
  into its snapshot image; a local container needs an equivalent built and
  mounted) and invented failure modes that exist in no other environment. Two
  of those cost real debugging time: a linux guest cannot load the host's
  darwin-installed native binaries (vite/rolldown, lightningcss — everything
  *resolves*, then fails to *load*), and a loopback platform origin points at
  the guest's own harness rather than the dev server, so Publish 404s against
  itself. So: `subprocess` for fast iteration, `modal` when the question is
  "does this really work". A stale `SANDBOX_BACKEND=apple-container` throws
  at boot.
- **Subprocess backend (the local-dev default)** — `subprocess-sandbox.ts`
  runs the harness as a child process of the server on a loopback port. It
  has **no isolation at all**: tenant agent code, and the studio coding
  agent's `bash`/`run_code` tools, run with the server's uid, filesystem, and
  network. That is only acceptable because selection can never reach it in
  production, and boot says so unconditionally
  (`assertSandboxBackendOrWarn` logs the backend plus an isolation warning).
  It keeps the *shape* that catches integration bugs — a real OS process, the
  real `/ws` JSON-RPC control channel, real agent-mode file boots, real
  `/websocket` sessions, real dial-retry and orphan-timeout behavior — and it
  has no prerequisites, which is the whole point of it being the default.
  The harness binds **loopback** via `AAI_GUEST_HOST` (see
  `aai-guest/harness.ts`): with no network namespace around it, the auth-free
  `/websocket` would otherwise be exposed to the dev machine's network.
  In-guest builds resolve the toolchain through aai-guest's own
  `node_modules` — the same walk-up shape as `/opt/aai` in the baked image,
  with no cache to build. The shared harness lifecycle (exit fan-out,
  memoized cleanup, guest dial retry, stdio draining, loopback port
  allocation) lives in `warm-harness.ts`, used by both backends.
- The guest base image defaults to `node:24-slim`; pin via
  `MODAL_SANDBOX_IMAGE` for reproducible guests. `MODAL_APP_NAME` selects the
  Modal App sandboxes are created under (default `aai-server`).
- **The harness AND the build toolchain are baked into a snapshot image**,
  not written per spawn, in two halves that cache differently. The
  TOOLCHAIN is a native image LAYER (`toolchainImage`: a
  `dockerfileCommands` `RUN npm install` into `/opt/aai/node_modules` — the
  aai CLI bundlers plus the workspace-facing packages), so Modal's own
  layer cache serves it and a harness rebuild — every
  server code change — no longer reinstalls ~15 packages. The HARNESS needs a
  throwaway builder sandbox, because the JS SDK's `dockerfileCommands` takes
  commands with no build context and there is nothing to `COPY` a ~13 MB local
  bundle from: a sandbox started from the layer writes it, its filesystem is
  snapshotted (`snapshotFilesystem`), and the image is `publish`ed under a
  content-addressed tag
  (`aai-guest-harness:<hash(base image, harness, toolchain)>`), so every
  later spawn — and every other replica, across restarts — resolves it with
  one `images.fromName` call. A new harness build, base-image change, or
  toolchain bump mints a new tag. This is the only harness-delivery path; a
  failed build fails the spawn loudly (memo cleared, next spawn retries).
  DEPLOYED AGENTS spawn from the tag recorded on their agents row at deploy
  time (`harness_image_tag` — per-deploy pinning, so a platform upgrade
  never changes the environment under an already-deployed bundle). An
  unresolvable pin FAILS the spawn loudly — silently substituting the
  current image is exactly the untested-environment drift pinning exists to
  prevent; the operator kill switch `SANDBOX_IGNORE_IMAGE_PINS=1` forces
  the current image for every spawn when a registry loss makes that trade
  explicitly. Studio/inspect sandboxes always run the current image.
- **The guest toolchain is LOCKED, and the lock is committed**
  (`packages/aai-guest/toolchain/{package.json,package-lock.json}`, regenerated
  by `pnpm sync:guest-toolchain`, gated by `pnpm check:guest-toolchain` in
  `scripts/check.sh` AND the CI check job). Without it the resolved tree is a
  function of WHEN the layer was built, while the published tag and Modal's
  layer cache both key on the install command's TEXT — so one
  `harness_image_tag` could mean two different trees, the exact opposite of
  the per-deploy environment pinning the tag exists for. The install is
  therefore two steps, and the split is forced:
  - **Third-party packages: `npm ci` against the committed lockfile.** Their
    versions and integrity hashes are known at commit time, and this is where
    nearly all the transitive surface lives (vite/rolldown, typescript,
    vitest, react, tailwind). `npm ci` also refuses to run when the manifest
    and lockfile disagree, so a hand-edited manifest fails the BUILD.
  - **`@alexkroman1/*`: `npm install` at exact resolved versions.** These
    CANNOT be locked here — their versions change every release, and a
    lockfile entry needs an integrity hash that only exists once the version
    is PUBLISHED, which happens after the commit that bumps it. Their own
    dependencies (the provider SDKs) therefore still resolve at install time;
    closing that residual gap needs a post-publish regeneration step, not a
    lockfile in this repo.

  Both files are written by the RUN itself, gzipped and base64'd (~20 KB), for
  the same reason the harness cannot be `COPY`'d: `dockerfileCommands` carries
  no build context. The image TAG hashes the lockfile's content, not the
  manifest's — the manifest names direct versions, the lockfile names the whole
  tree, so a purely transitive change still mints a new tag.
  Only the Modal backend needs this: the subprocess backend's harness runs
  from `packages/aai-guest/dist/` and resolves the toolchain through
  aai-guest's own `node_modules` — the same walk-up shape as `/opt/aai`, with
  nothing to build or mount. The `workspace-build-integration.test.ts` suite
  keeps the path covered on any runner by spawning the harness there directly
  and publishing through the real CLI to a real listening orchestrator.
- Sandboxes are created with open egress and a bounded lifetime
  (`SANDBOX_TIMEOUT_SECS`, default 4h).
- **Guest resources are a BURST RANGE: reserve the idle shape, cap the build
  shape.** `SANDBOX_MEMORY_MB` / `SANDBOX_CPU` reserve; `SANDBOX_MEMORY_LIMIT_MB`
  / `SANDBOX_CPU_LIMIT` cap. Modal constrains the pair from both sides — a bare
  cap fails sandbox creation ("must also specify cpu when cpuLimit is
  specified") and a reservation above its cap is rejected — so
  `parseSandboxLimitsFromEnv` reconciles them in one place and **throws on a
  cap with no reservation**, naming the env var, rather than letting the spawn
  die inside Modal on parameters the operator never set.

  They must stay two numbers, because a guest's load is bimodal: it idles as a
  voice session (~250 MB, a few % of a core) and spikes to ~1.7 GB across
  several cores for the seconds a `test_agent` or Publish build spends in the
  bundler. While the reservation was pinned equal to the cap, the two had to be
  ONE number and the affordable one won: 1 GiB / 1 core. That does not fit a
  build, and the failure is not an OOM — the guest wedges at its cgroup ceiling
  in permanent direct-reclaim, burning its core on back-to-back full GCs that
  can never free rolldown's **native Rust** allocations. Measured on a wedged
  production sandbox: RSS pinned flat at 1.29 GB, ~1 core split seven ways
  across 4 V8 GC workers + the main thread + 2 rolldown workers, **zero** I/O,
  453 CPU-seconds and no progress, versus 253 MB / 0.97 CPU-seconds on an idle
  sibling. It reads as a hung build.

  Two corollaries. **The cap is on the CGROUP, not the process** — so it takes
  out `test_agent` and Publish alike, and moving the bundler into a child
  process (as #845 did, reverted in #863) cannot escape it; the child's peak is
  charged to the same sandbox budget. And **`--max-old-space-size` cannot help**,
  because the memory is native, not V8's. The reservation is the idle
  voice-session shape; the cap only has to clear the bundler's peak.

  **BOTH Modal apps set the burst range in their image env** — the agent
  app's guest-sandbox resources block (`aai-server/modal_deploy.py`) and
  the studio app's (`aai-studio-server/modal_deploy.py`). The studio spawns
  its own sandboxes (coding-agent sessions, Publish, config extraction),
  whose `test_agent`/Publish builds are exactly the workload the cap exists
  for — for a while only the agent app set the range, so studio-spawned
  sandboxes ran on Modal defaults. Keep the two blocks' values in lockstep
  unless the divergence is deliberate.
- **Every sandbox is tagged with a `role`** (`sandbox-role.ts`: `agent`,
  `preview`, `studio`, `studio-publish`, `inspect`) plus the `slug`
  (studio sandboxes carry the project name), so the Modal dashboard can tell
  a production voice agent from a preview deploy, a studio coding-agent
  session, or a bundle inspection. Every spawn knows its identity at
  creation. Observability only: nothing
  may gate on these tags, and the `preview` role is inferred from the
  `-preview` slug suffix (`PREVIEW_SLUG_SUFFIX`, defined once in the SDK's
  slug contract — `aai/sdk/slug.ts`, reachable as `@alexkroman1/aai/utils` —
  because three independent things key off it and a disagreement is silent
  data loss: the deploy boundary rejects the suffix, the reaper deletes
  agents carrying it, and the CLI refuses to derive a project name ending in
  it. It lives in the SDK rather than aai-server because the CLI needs it and
  cannot import a private package).
- **The `-preview` opt-in is DECLARED by the caller, never inferred from the
  slug.** `deployAgentBundle` rejects a requested `*-preview` slug unless
  `allowPreviewSlug` is set, and only the studio's auto-preview deployer sets
  it — it targets `<project>-preview` on purpose. Publish shares the very same
  in-guest `aai deploy` invocation and must leave it unset. It used to ride on
  that shared invocation unconditionally, reasoned as "harmless for a
  production Publish, whose slug has no such suffix" — true only for
  server-minted project names. A CLI push derives the project name from the
  DIRECTORY, so a directory named `demo-preview` published straight through
  the guard and got an agent the hourly sweep would delete. Inferring the
  opt-in from the slug's shape would NOT have fixed it: a production Publish
  of such a project passes exactly that slug.
- **The guest snapshot image is resolved AT BOOT, not on the first spawn**
  (`prewarmModal(harnessPath)` in modal-sandbox.ts, called from
  `assertSandboxBackendOrWarn`). Two memoized stages otherwise charged to
  whoever spawns first: the Modal app lookup (a gRPC round trip), and the
  harness image — reading the ~13 MB harness, the synchronous SHA-256 that
  forms its content-addressed tag, and resolving that tag. On a harness
  version nobody has published yet — i.e. right after EVERY deploy —
  "resolving" means BUILDING: toolchain layer, builder sandbox, 13 MB write,
  `snapshotFilesystem`, publish. That landed on one unlucky user's first
  voice session or studio chat. `createGuestSandbox` awaits the same memoized
  promise, so a spawn racing the prewarm joins it rather than starting a
  second build, and replicas racing each other are no worse than the
  concurrent cold spawns that raced before (the resolver tries
  `images.fromName(tag)` first). Fire-and-forget: a failure only warns and
  the memo resets, exactly as when the first spawn was the first caller.
- **Readiness is Modal's readiness PROBE**, not host-side polling
  (`GUEST_READINESS_PROBE` in modal-sandbox.ts): every guest sandbox is
  created with `readinessProbe: Probe.withTcp(8080)` and the spawn awaits
  `sandbox.waitUntilReady()`. A TCP probe is exactly equivalent to the
  `/health` 200 it replaced, and that equivalence is a property of the
  harness's boot order rather than a guess: agent mode reads its boot files,
  hash-verifies and LOADS the bundle, and only then calls `server.listen` — so
  the port opening means "sessions can be served". A harness that listened
  first would report ready before it could serve anything. The wait is always
  raced against guest-process EXIT (`raceGuestExit` in warm-harness.ts): every
  boot failure exits the process with its reason on stderr, and without the
  race a readiness wait burns its whole budget and then blames the network.
  The host-side `pollGuestHealth` remains for the subprocess backend, which
  has no probes.
- **Transport**: STUDIO/INSPECT guests get a WebSocket control channel the
  host dials through the sandbox's Modal tunnel (`encryptedPorts: [8080]`;
  JSON-RPC on `/ws`) once the probe reports ready — the dial's retry
  (`GUEST_DIAL_TIMEOUT_MS`) stays as a backstop rather than the discovery
  mechanism. AGENT guests get NO channel — readiness is the probe, and the
  host probes `/manage/*` over plain HTTPS. Both are authenticated by a
  per-sandbox bearer token minted at
  spawn and delivered via the EXEC's env (never the sandbox's). The tunnel
  URL is public; the token is what keeps the managed surfaces from being an
  open door.
- **Region pinning**: `MODAL_SANDBOX_REGION` (comma-separated for multiple)
  pins sandbox placement via Modal's `regions` create param. Unpinned, Modal
  places for capacity — it once put the server in us-east-1/AWS and guest
  sandboxes in uk-london-1/OCI, so every host↔guest exchange paid a
  transatlantic RTT inside voice turns. `modal_deploy.py` pins its
  functions to one `REGION` constant and
  exports it as `MODAL_SANDBOX_REGION`, so production host and guests are
  co-located by construction; local dev stays unpinned.
- **Orphan cleanup differs per mode.** STUDIO/INSPECT guests: the host's
  WebSocket IS the liveness signal — a host that dies without teardown
  drops its sockets, and the harness self-exits after
  `HARNESS_ORPHAN_TIMEOUT_MS` with no host connected (constants in
  `aai-guest/limits.ts`; the window also covers the boot gap before the
  first dial). AGENT guests have no host socket, so they own their own
  lifecycle instead: self-exit after `AGENT_IDLE_EXIT_MS` with zero
  sessions (see "Agent guests are servers"). Either way, once the exec has
  exited, Modal's `idleTimeoutMs` (`SANDBOX_IDLE_TIMEOUT_SECS`, default
  15 min) terminates the sandbox. These are backstops, not the normal
  path: Modal delivers stop signals to the container's **Python** runtime,
  never to a bare `subprocess.Popen` child, so `run_node`
  (scripts/modal_image.py) forwards SIGTERM/SIGINT to the node process and
  waits — that is the only reason `teardownSandboxes` (retire agent guests,
  dispose the studio broker) runs on scale-in/redeploy at all.
  There is NO host-side idle eviction: the guest owns idleness (agent-mode
  self-exit; the studio broker keeps its own per-project idle sweep), and a
  guest exit detaches its slot via `onSandboxLost`.
- The server itself deploys to Modal too (`modal_deploy.py`,
  `pnpm --filter aai-server deploy:modal`) — there is no Docker image or
  Fly.io deployment anymore.

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

### Modal sandbox isolation

Each agent runs in its own **Modal Sandbox** — a remote, isolated container
on Modal's infrastructure (`modal-sandbox.ts`). The guest runs a Node
process executing the bundled agent code (`aai-guest/harness.ts`) — the
COMPLETE agent: the runtime ships INSIDE the worker bundle (see
"User-shipped runtime" — the harness embeds none), and client sessions
connect directly to the sandbox's public `/session` tunnel endpoint.
Host↔guest control traffic is JSON-RPC over a WebSocket the host dials
through the same tunnel (`/ws`), authenticated by a per-sandbox bearer
token.

**In production.** Local dev defaults to the `subprocess` backend, which has
**none** of the properties described below — the harness is a child process
of the server, sharing its uid, filesystem, and network — see "Modal sandbox
notes". Selection (`sandbox-backend.ts`) makes it unreachable outside local
dev: any environment with `SUPABASE_STORAGE_BUCKET` set resolves `modal`
unconditionally. When reasoning about the security model, the backend is the
first thing to establish, and the boot log names it (with a warning when
there is no boundary at all).

Key properties:

- **Remote isolation**: each sandbox is its own container on Modal — no
  shared kernel surface with the platform host, no shared state between
  agents. The container is the security boundary; the guest runs plain Node
  (no language-runtime permission model).
- **Open egress**: the container is the isolation boundary — a tenant can
  reach the internet, not the platform. Tool code, `ctx.generate`, and
  provider streams dial out from the guest directly (identical to
  `aai dev`); `ctx.db` connects directly on the app's OWN scoped role
  (`DATABASE_URL` in the agent's boot env) — platform ADMIN database
  credentials never enter the guest.
- **Minimal filesystem**: the guest sees the baked harness image — never
  the host filesystem.
- **Resource limits**: Modal per-sandbox memory/CPU caps
  (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) and a bounded lifetime
  (`SANDBOX_TIMEOUT_SECS`, default 4h).
- **Sessions live in the guest**: the embedded runtime owns per-session
  state (`ctx.state`, history, the resume grace window) exactly as the
  self-hosted runtime does. The host holds no session state.

### Agent guests are servers (no control channel)

DEPLOYED AGENTS spawn as servers (`spawnAgentServer` in sandbox-vm.ts;
guest side in `aai-guest/harness-agent-mode.ts`). The whole
platform↔deployed-agent contract, frozen per deploy by the harness image
pin and versioned by `GUEST_CONTRACT_VERSION` (additive changes only):

- **Boot**: the spawner writes the worker bundle and the agent env as
  FILES into the fresh sandbox (`sb.filesystem.writeText` on Modal, a
  scratch dir on the subprocess backend), then execs the harness with
  `AAI_GUEST_MODE=agent` + the artifact paths + the bundle's sha-256. The
  guest hash-verifies the bundle (a mismatch is a hard boot failure, never
  a silently different agent), loads it BEFORE listening, and scrubs the
  env file. Readiness is the guest's public `/health` answering 200 —
  polled by the host, raced against guest-process exit so a boot crash
  fails the spawn immediately with the guest's stderr in the host log
  (relayed from the moment the process exists — see `startGuestLogging`;
  draining only once the guest was READY discarded exactly the output that
  explains a boot failure).

  **How long a guest may take to boot and how long a CLIENT waits for it are
  separate budgets.** They were one number, so an agent whose top-level code
  blocks — never ready — hung every broker call for the full
  `AGENT_HEALTH_TIMEOUT_MS` (120s) before its 503, permanently. The broker
  caps its own wait at `BROKER_READY_TIMEOUT_MS` (20s, env overridable; 0
  waits for the whole boot budget) and answers 503 while the boot CONTINUES:
  the sandbox is already attached to its slot and reports `alive()` while
  pending, so the next call joins the SAME readiness promise instead of
  spawning a second sandbox. Tripping it on a healthy-but-slow boot costs one
  client reconnect, not a failure — `session-core.ts` re-brokers per attempt
  and only an ANSWERED lookup latches anything.
- **Ongoing surface**: `GET /manage/status` (live session count +
  draining + contractVersion — an operator/debugging probe; nothing
  host-side gates on it anymore) and
  `POST /manage/drain` (`?deadlineMs=` carries the retire budget the guest
  enforces itself), both gated by the per-sandbox bearer
  from the exec env. Nothing else — no WebSocket, no RPC, no host
  connection. The guest's public `/client-config` doubles as the broker's
  name/greeting source (proxied — see "Pre-connection client config").
- **Lifecycle is guest-owned — the host runs NO idle machinery**: the agent
  guest self-exits after `AGENT_IDLE_EXIT_MS` (5 min; override by setting
  `AAI_GUEST_IDLE_EXIT_MS` on the SERVER, which `agentBootEnv` forwards into
  the guest's exec env — a guest reads only what it is handed at exec, so
  setting it on the platform process is what reaches BOTH backends) with
  zero sessions —
  this IS idle reclamation, not a backstop (the host's per-slot idle timers
  were deleted); the exit surfaces host-side as `onSandboxLost`, which
  detaches the slot, and the next broker call rebuilds it. A drained guest
  refuses new direct-dial sessions (close 1013 → the client re-brokers) and
  exits the moment it empties or at its drain deadline.
- **Redeploys hand over BLUE-GREEN** (`handoverSlot` in
  sandbox-resolve.ts): the agents-row change event boots the NEW deploy's
  sandbox and waits for its readiness before detaching the old one, so a
  redeploy never leaves an empty slot — the next caller lands warm while
  the old sandbox drains its calls in the background. A replacement that
  fails to boot retires the old resident anyway (an empty slot keeps the
  failure visible on the next broker call; silently serving superseded
  code would not).

### No warm pool — every spawn boots from the snapshot image

There is NO warm sandbox pool (`sandbox-pool.ts`, `SANDBOX_POOL_SIZE`, the
`pool` role, and the `setTags` retag plumbing were all deleted). Production
always ran with the pool disabled, so it was pure complexity: every spawn —
agent, studio, inspect — now boots directly from the published
content-addressed harness snapshot image, one code path per backend, and
every sandbox knows its identity (role/slug tags) at creation. When Modal's
JS SDK exposes sandbox MEMORY snapshots (today it exposes only
`snapshotFilesystem`; memory snapshots are Python-SDK experimental),
restore-from-snapshot slots into this single spawn path — do NOT
reintroduce a host-managed pool to approximate it.

### No horizontal sandbox scaling — one sandbox per slug, FLEET-WIDE

Per-slug horizontal scaling (`sandbox-scale.ts`: session caps, overflow
replicas, least-connections routing over guest-reported counts) stays
DELETED: a slug has ONE resident sandbox, and the broker
(`GET /:slug/client-config` → `resolveSandbox`) either serves it or
rebuilds it. A single guest handles many concurrent voice sessions before
that matters. Git history has the full design if per-slug scaling ever
needs to come back — the one constraint that survives any reintroduction:
sessions dial the sandbox directly, so the guest-reported session count is
the only honest load signal, and the broker is the only routing point.

**"One" means fleet-wide, not per replica — and MODAL enforces it**
(`sandbox-directory.ts`). The slot cache is per-replica and the web service
autoscales, so for a while each replica spawned its own guest for the same
slug. That is not an edge case — Modal load-balances every request
independently, so a page load and the project switch a minute later
routinely land on different replicas.

A guest sandbox's fleet-wide identity is its Modal **name**
(`agent-<hash(slug)>-v<version>`): `sandboxes.create` throws
`AlreadyExistsError` when the name is taken, and `sandboxes.fromName` returns
only a RUNNING sandbox. So a COLD broker (no local resident) asks Modal
whether some replica is already serving this deploy and routes to that
guest's tunnel — sessions dial the guest directly, so a peer's URL serves a
client exactly as well as a local one.

This replaced `aai_platform.sandbox_registry`, a lease table the owning
replica heartbeated every 10s. What went with it: the heartbeat timer and its
per-tick ownership re-check (which existed so every detach path — retire,
terminate, idle self-exit, lost guest, blue-green handover — converged on an
unregister without knowing the registry existed), the pg_cron sweep for
crashed replicas' rows, `replicaId` on the agent path, and the accepted
**stale-lease window**: the old design could hand out a dead peer URL for up
to one lease after a crash, and a retired sandbox's URL for up to one
heartbeat. A name is released when the sandbox stops, so `fromName` cannot
return something that is not running.

Three properties worth keeping:

- **The name carries the deploy VERSION.** A blue-green handover
  (`handoverSlot`) boots the replacement while the old resident drains, so a
  slug legitimately has two live sandboxes for minutes and a version-less
  name would collide. It also makes the peer lookup version-EXACT — the lease
  table could hand out a guest running superseded code until the owner's
  heartbeat stopped.
- **The peer route is gated on the agents row still existing.** A deleted
  agent's sandbox can still be running (retirement drains it for minutes),
  and routing to it would resurrect a 404. The same `getAgentVersion` read
  serves as both that gate and half the name.
- **Losing the name race routes to the winner** (`awaitBrokeredUrl`). A
  create that lost is the ONE remaining path to a duplicate; it comes back as
  `SandboxNameTakenError`, and the broker returns to the directory rather than
  retrying a spawn that can only lose again.

The directory is read at the broker, NOT subscribed to: it only matters at
the moment a cold broker runs. A change stream would be a second mechanism
answering the same question — the duplication rule that shaped
`watchAgentInvalidation`.

### One studio sandbox per project, fleet-wide

The same problem hit the studio harder, and the fix is shaped differently
because a studio guest is STATEFUL to the host: it holds an installed
session (materialized workspace, caller's key, system prompt) that a broker
call must be able to refresh, or the coding agent edits a stale tree. Two
live guests for one project also meant two `studio/sync-workspace` writers
racing on the same workspace row.

`aai-studio-server/studio-session-registry.ts` (`aai_platform.studio_sessions`)
records the chat URL + chat token the browser gets, plus the guest origin +
per-sandbox token a PEER needs to reinstall the session. `ensureSession` is
now a three-step ladder: local map hit → reuse; registry row → **adopt**
(`studio-session-adopt.ts`); neither → cold spawn + claim.

**The studio lease SURVIVES the move to Modal names, and this is not an
oversight.** Agent sandboxes dropped their registry entirely — a name answers
"does this deploy have a live sandbox", which is all the agent broker asks.
The studio asks a second question the owner's idle sweeper depends on: "has
any replica used this project recently?" A name cannot express that, and
nothing else can either — a peer's chat turns go browser→guest DIRECTLY, so
the owner (whose sweeper decides eviction) observes no activity at all, and
without the touched lease it would evict a guest another replica is actively
serving mid-conversation. The studio spawn IS named
(`studioSandboxName(scope, project)`), which adds what the lease could not
guarantee: two replicas racing the cold path cannot both spawn even when the
lease read missed. Closing the rest — deriving `chatToken`/`sandboxToken` from
the sandbox id and reducing the row to pure activity — needs a guest-side
last-used signal over the control socket the owner already holds; that is the
direction, not the current state.

- **Adoption cannot use the control socket** — a harness accepts exactly
  ONE (`/ws` answers 409 to a second authenticated dial), and the owner has
  it. So the guest serves an HTTP twin, `POST /studio/session-init`
  (`aai-guest/studio-session-init.ts`), gated by the per-sandbox HOST token
  rather than the `chatToken` it mints. The SOCKET stays the owner's,
  carrying lifecycle and the guest→host RPCs; HTTP lets any replica install
  a session. Ownership never moves, so there is no second socket and no
  cross-replica termination.
- **The install IS the liveness probe.** Anything but a clean 2xx drops the
  row and falls through to a cold spawn, so a stale row costs one failed
  HTTP round trip rather than a dead URL in a browser.
- **The guest pins its own identity.** `initStudioSession` records the
  (scope, project) of its first successful install and refuses any later
  one naming a different pair (409). Now that any replica can install over
  HTTP, a mis-keyed row would otherwise materialize one tenant's workspace
  inside another tenant's guest — the same reasoning as agent mode
  hash-verifying its bundle instead of trusting the spawner.
- **The lease and the local idle window are ONE number**
  (`STUDIO_SESSION_IDLE_MS`). They have to be: a peer's broker call is
  activity the owner cannot see, and all it leaves behind is a touched
  lease, so the owner's sweeper consults the row before evicting. Guest RPC
  activity touches the lease too — an agent turn longer than the window
  would otherwise let the row expire and invite a peer to cold-spawn
  mid-turn.
- **`chatToken` is minted once per SANDBOX and stored in the row**, so every
  replica hands back the same one. Re-minting per broker call would revoke
  the token every other tab is holding.

The studio registry carries a `replicaId` (`ServiceConfig.replicaId`, a
per-process UUID) and falls back to independent per-replica behaviour when
there is no platform database — dev and tests are a single process with no
peers. The agent path needs no such identity: a NAME answers "does this
exist", never "who made it".

### Platform sandbox (aai-server)

Agent code runs in **per-agent Modal Sandboxes**. Key files:
`packages/aai-server/sandbox.ts`, `sandbox-vm.ts`, `modal-sandbox.ts`,
`aai-guest/harness.ts`, `rpc-transport.ts`.

**Isolation layers:**

- **Filesystem**: the baked harness image. No host filesystem access.
- **Network**: open egress (the container is the boundary); ctx.db connects
  directly on the app's own scoped role — platform admin credentials stay
  host-side.
- **Memory/CPU**: Modal per-sandbox limits; separate container per sandbox.
- **Env vars**: a deployed agent's env is delivered as a boot FILE written
  into its own sandbox (scrubbed after reading); per-sandbox tokens ride
  the exec env. Platform secrets stay host-side.

**Credential separation:**

Each agent provides its own `ASSEMBLYAI_API_KEY` via `.env` (local dev) or
`aai secret put` (production). There is no central/platform-owned key.
`SandboxOptions` has separate `apiKey` (host-only, for S2S connections) and
`agentEnv` (forwarded to guest) fields. The key is extracted from the agent's
stored env at sandbox creation time and kept host-side only.

- **App database**: per-app Postgres role/schema credentials are
  platform-provisioned and held in Supabase Vault. When storage is enabled
  they reach the guest as `DATABASE_URL` in the boot-delivered agent env —
  the app's
  OWN scoped role (search_path pinned, statement_timeout, connection
  limit), never a platform admin credential; it reaches only data the
  tenant's code could read anyway, and matches what `aai dev` puts in
  `ctx.env` via the project `.env`.
- **Agent secrets**: stored in Supabase Vault (`agent-env:<slug>`), not
  encrypted blobs — the old master-key envelope encryption
  (`KV_SCOPE_SECRET`) is gone.
- **Credential resolution reads the agent env only — never `process.env`.**
  The platform host process holds its own credentials under exactly the names a
  tenant descriptor could resolve (`AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` for Supabase storage), so a fallback would let an
  agent that supplied no credential of its own silently borrow the
  platform's.

  There are **two** such helpers and both must stay sealed — closing only one
  leaves the leak open, since between them they cover every provider:
  - `resolveApiKey` (`providers/resolve.ts`) — descriptor-declared env keys.
  - `requireApiKey` (`providers/_utils.ts`) — every STT/TTS opener and every
    LLM (via `resolve.ts`'s `requireKey`).

  Self-hosted runs opt into shell-exported keys via
  `withHostCredentialFallback` (`providers/host-env.ts`), which copies only
  `PROVIDER_CREDENTIAL_ENVS` (derived from the provider registries). It feeds
  `RuntimeOptions.providerEnv`, **not** `env` — credentials must not land in
  `ctx.env`, both so agent code can't read them and so dev keeps parity with
  production in what `ctx.env` contains.

  The providerEnv-not-env rule is **type-enforced** via the branded env
  records in `sdk/env-types.ts`: `withHostCredentialFallback` is the only
  minter of `HostCredentialEnv`, which satisfies
  `RuntimeOptions.providerEnv` (`ProviderEnv`) but is a compile error for
  `RuntimeOptions.env` (`AgentEnv`) and everything else that becomes
  `ctx.env`. Plain records stay assignable to both, so only the dangerous
  flow needs ceremony; `env-types.test-d.ts` locks the assignability matrix.
  The brand is advisory against *deliberate* re-annotation — the point is
  that leaking host credentials into `ctx.env` can no longer be silent.

**Cross-agent isolation:**

- App databases are separate Postgres schemas with per-app login roles —
  agents cannot access each other's data.
- Each sandbox communicates over its own authenticated WebSocket.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

**`run_code` built-in tool (`aai-guest/trial.ts`):**

- Executes **only inside the guest sandbox** (Modal/Node): the harness wires
  its in-sandbox executor into the runtime as `RuntimeOptions.runCode`
  (`run_code` is in `SANDBOX_ONLY_BUILTINS`). The old host-side `node:vm`
  execution was removed — `node:vm` is not a security boundary; the Modal
  container is.
- The host-side `execute` (`builtin-run-code.ts`) is a guard for the
  self-hosted path (`aai dev`), which has no sandbox — it refuses rather
  than evaluating attacker-influenceable code in the host process.
- The executor is a bare `new Function` async wrapper: code runs with the
  **same authority as the rest of the sandboxed agent** — open egress,
  filesystem, env, child processes — and nothing more. There is deliberately
  no in-process capability stripping; the container is the whole boundary.
  (This is why the tool description promises only "output from console.log",
  not "no network/filesystem" — that claim would be false now.)
- 5-second execution timeout (enforced in the guest).

**SSRF protection (aai/host/ssrf.ts):**

- Lives in the SDK, not `aai-server`, so both the platform's guest-fetch proxy
  and the SDK's own network builtins resolve one implementation.
- `resolveAndAssertPublic()` uses the `bogon` library for private IP ranges.
- Handles IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`).
- Blocks `.internal`, `.local`, cloud metadata hostnames, and non-HTTP(S)
  protocols.
- Re-validates every redirect hop and strips credential headers once a redirect
  leaves the original origin.
- Pins the validated IP with an undici dispatcher `lookup` rather than
  rewriting the URL hostname. Rewriting broke TLS — SNI and cert verification
  use the URL, not the `Host` header — so every `https://` request failed. Keep
  the URL intact when touching this.
- **The dispatcher and the `fetch` it is handed to must come from the same
  undici.** `pinnedDispatcher` builds an `Agent` from this package's `undici`
  dependency, while `globalThis.fetch` is backed by the copy bundled into the
  Node runtime (`process.versions.undici`) — a different major. undici 8
  reworked the dispatch-handler interface, so a v8 `Agent` rejects the v7-style
  handler Node's internal fetch builds, with `InvalidArgumentError: invalid
  onRequestStart method` surfacing as a bare `TypeError: fetch failed`. A
  dispatcher is attached to *every* hostname request, so the mismatch takes out
  all SSRF-guarded egress at once — `web_search`, `visit_webpage`,
  `get_page_design`, and `fetch_json`. `safeFetch` therefore routes through
  `pinnedFetch`, undici's own `fetch`; never reintroduce `globalThis.fetch`
  there. Guarded by `ssrf-dispatcher.test.ts` — the rest of the SSRF suite
  injects a fake fetch and never builds a real dispatcher, which is why this
  shipped unnoticed. Two rules survived the (since-removed) tool-egress
  guard that first hit this: **the caller may not name a fetch
  implementation** (leave `fetchFn` unset — it exists for tests — so the
  pinned default applies), and the guard test has to cover the *call site*,
  not just `pinnedFetch` in isolation.

  **The request *body* crosses the same seam, and `FormData` does not survive
  it.** undici 8's `extractBody` brand-checks each body type with an
  `instanceof` against **its own** class, so a `globalThis.FormData` (an
  instance of Node's *internal* undici's class) matches no branch, falls
  through to the string conversion, and goes out as `Content-Type: text/plain`
  with the 17-byte body `[object FormData]` — the server answers
  `415 Unsupported Media Type` and the caller sees an opaque HTTP failure.

  The rule that generalizes: **never hand a `FormData`, `Blob`, `File`,
  `Headers`, or `Request` to a `fetch` that might not be the one your realm's
  global came from** — pass bytes.
- The network builtins (`web_search`, `visit_webpage`, `get_page_design`,
  `fetch_json`) take a
  model-controlled URL and **default** to this via `safeFetch` in
  `builtin-tools.ts`. Protection is not opt-in per caller; only tests override
  the `fetch` option.

**Auth:**

- **Two bearer forms, one resolution point** (`resolveBearer` in
  `middleware.ts`). Raw API keys (the `aai` CLI, and the in-guest
  `aai deploy` Publish runs) pass through unchanged. JWT-shaped bearers —
  browser studio sessions — are verified against the auth backend and
  mapped to the user's stored AssemblyAI key (`user-key:<uid>` in the
  SecretStore), so every downstream consumer (ownership hashes, the
  gateway LLM, deploy env seeding) sees the real key either way. A key
  never contains dots, so the shape test (`isJwtShaped`) cleanly splits
  the two; the verification boundary is the backend's answer, never the
  shape. Raw keys additionally resolve a `userId` when the key was stored
  as some account's key — the `key-user:<sha256(key)>` reverse mapping
  written by `PUT /studio/account/key`, TTL-cached (negatives included)
  beside the user→key cache — which lands a linked CLI in the same studio
  scope as the browser session; an unmapped key keeps the key-derived
  scope.
- **Browser sessions are Supabase Auth** (`supabase-auth.ts`): GitHub
  OAuth sign-in via supabase-js (`signInWithOAuth`) in the studio client;
  the server verifies
  access tokens by asking Supabase (`GET /auth/v1/user` — no JWT
  secret/JWKS handling), TTL-cached by SHA-256(token). Configured by
  `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`. Local dev (same `isLocalDev`
  policy as the in-memory stores — production can never resolve it) falls
  back to `createDevAuth`: the login screen mints self-describing
  `dev.<base64url({id,email})>.dev` tokens, so `pnpm dev:aai-server`
  needs no Supabase project while exercising the same middleware. The
  studio's account surface (`GET /studio/auth`, `GET /studio/account`,
  `PUT /studio/account/key`) authenticates the session WITHOUT requiring
  a stored key — it is how the key gets set, as the mandatory onboarding
  screen after sign-in.
- **`aai login` never signs in and can never create an account** — it
  LINKS an account that is already signed in to the browser studio
  (device-link flow): the CLI mints an unguessable one-shot code, opens
  `<server>/?cli-link=<code>`, and polls
  `POST /studio/cli-link/exchange`; the signed-in (and key-onboarded)
  browser session approves via `POST /studio/cli-link/approve`, which
  grants that code ONE exchange for the account's stored API key. Grants
  live in the SecretStore under the code's hash
  (`cliLinkSecretName`), expire in 10 minutes, and are deleted on first
  read. There is no `GET /studio/account/key` route anymore — the exchange
  is the only way a raw key leaves the platform, and only to the terminal
  that minted the code.
- **Every AssemblyAI key on the platform is user-provided** — there is no
  platform-owned key, and with browser sessions the browser never holds
  one either: the key lives server-side against the account (Vault) and
  the browser holds only a revocable ~1h session token.
- API key ownership hashes are plain SHA-256 digests (`sha256:<hex>` in
  `secrets.ts`) — slug ownership is verified against stored credential
  digests, constant-time compared. NOT a password hash on purpose: platform
  keys are high-entropy machine secrets, so the argon2id stack this
  replaced (native dependency, TTL verify cache, lazy-hash choreography to
  dodge ~100ms derivations) was cost without a threat model. There are no
  legacy hash/decrypt fallbacks (nothing predating the current scheme was
  ever deployed).
- Stored credentials (agent env vars / secrets) live in Supabase Vault,
  which encrypts at rest — there is deliberately no app-layer encryption
  on top.
- Deploys go through the single `POST /deploy` route (slug in the body);
  the legacy `POST /:slug/deploy` route was removed.
- Deploys check slug ownership whether the slug was requested or generated —
  a generated-slug collision returns 409 rather than overwriting an existing
  agent and appending the caller's credential hash to it.
- **Server-generated names come from one generator**
  (`aai-server/slug-generate.ts`): a readable base plus a random lowercase
  base36 suffix, v0-style (`contact-form-x7k2mq`). A slugless CLI deploy
  seeds the base from the agent's own `name` (its bundle-described config);
  studio project creation seeds it from the creating chat prompt
  (`projectBaseFromPrompt`); an unusable base falls back to `human-id`
  words. Clients never generate names — creation always hits the server.

### No host mode on deployed agents

Host mode (`?host=1` — the caller supplies `systemPrompt`, `greeting`, and
relayed tool schemas while the session runs on the operator's credentials) is
an **`aai dev` feature only**. The platform version (`ws-host-mode.ts`,
owner-authenticated via bearer on the upgrade) was deliberately removed: it
was the one path where the SERVER'S current SDK interpreted a STORED config
(`toRuntimeAgent` → the server's `createRuntime`) — a cross-version seam that
could break already-deployed bundles, and the reason the server carried a
config→runtime-agent mapping at all. Every platform session now runs the
bundle's own frozen SDK inside its sandbox; `/:slug/websocket` upgrades are
pure handshake redirects to the sandbox, and the platform process terminates
no sessions of any kind. Don't reintroduce an in-process session surface — if
platform host mode ever returns, run it in the guest on the bundle's runtime.

### Self-hosted server defaults (`aai/host/server.ts`)

`createServer` has no request authentication of its own — it is the `aai dev`
backend, not the managed platform. Two defaults exist because of that, and
both are fail-closed:

- **Binds loopback.** `listen(port, host = DEFAULT_LISTEN_HOST)` defaults to
  `127.0.0.1`. Pass `"0.0.0.0"` deliberately to expose it; binding every
  interface by default put a developer's agent (and the provider credentials
  behind it) in reach of anyone on the same network. `aai dev` exposes this as
  `AAI_DEV_HOST` for setups where loopback isn't reachable (e.g. running in a
  container and connecting from the host).
- **Host mode is opt-in.** A `?host=1` WebSocket lets the *client* supply the
  agent definition (`systemPrompt`, `greeting`, relayed tool schemas) while the
  session runs on the operator's credentials, so `isHostAllowed` requires an
  explicit `AAI_ALLOW_HOST` of `1`/`true`/`yes`/`on`. Unset means off.
  Harnesses (e.g. tau2) set it themselves. Note `resolveServerEnv` only
  surfaces keys declared in `.env`, so `aai dev` passes the shell value through
  explicitly (`hostModeEnv`) — otherwise exporting the variable the usual way
  would have no effect.

### CLI credential destinations (`aai-cli/_agent.ts`)

`.aai/project.json` is in the working tree, so a cloned repo controls its
`serverUrl` — and `aai deploy` / `aai secret` pair that URL with the user's API
key and secret values. `resolveServerUrl` therefore honors a config-supplied
origin only when it is the shipped default or already in `approvedServers` in
the user-owned global config. Loopback origins are deliberately NOT implicitly
trusted from config — a repo-supplied `http://localhost:<port>` would hand the
key to whatever is listening on that local port (dev mode targets its own
default server before the project config is consulted, so `aai dev` workflows
are unaffected). Passing `--server` is what approves an origin (it is user
intent, not repo content) and is remembered for later commands. Never widen
this to trust `serverUrl` directly.

The `slug` from the same file is validated against the platform's slug shape
(`VALID_SLUG_RE`, shared with aai-server via `@alexkroman1/aai/utils` —
`sdk/slug.ts` is the single definition) before it is ever
interpolated into a URL path, so a hostile `"slug": "x/../admin"` cannot steer
a credentialed request; `aai secret delete` also URL-encodes the secret name.
**That check lives in `resolveDeployTarget`** — the one point where
repo-controlled config becomes a credentialed target — so every command
inherits it. It used to live in `getServerInfo` only, which covered
secret/storage/delete but NOT `publish`, whose `syncEnvSecrets` PUTs the whole
`.env` to `${serverUrl}/${slug}/secret`; one guard in two places, with the
copy missing from the command users actually run.

The API key itself is stored 0600 in the global `config.json`
(`AAI_CONFIG_DIR` overrides the config dir location).
**`ensureApiKey` has exactly ONE source: the key `aai login` saved.** Neither a
"paste a key" prompt nor an `ASSEMBLYAI_API_KEY` env var authenticates the CLI.
Both produced the same thing — a CLI that could push, publish, and read/write
another account's secrets while linked to no account the user could see in the
studio, and an `aai login` that was optional in practice. The env var was the
worse of the two: it applies to every invocation in a shell, it PERSISTED
itself into the global config on first use (so the CLI stayed authenticated as
that key long after the export was gone), and it collides with what the same
name means in a project `.env`, where it is a *provider* credential for the dev
server rather than a platform identity. The prompt was separately the riskier
code path: a hidden password prompt reads stdin, so a piped invocation could
have its input eaten and persisted as the API key. Unauthenticated commands
fail with `not_logged_in` pointing at `aai login`; non-interactive callers (CI,
scripts, the eval harnesses) point `AAI_CONFIG_DIR` at a config dir holding a
logged-in key, which is what `aaiEnv()` seeds for the e2e suite's spawned CLIs.

**Every global-config update goes through `updateGlobalConfig`, which holds a
cross-process lock.** `writeJson` makes each write atomic (temp file + rename),
so no reader sees a torn file — but the read→modify→write SPAN is not atomic and
every writer replaces the whole document, so concurrent invocations lose each
other's updates. Measured: 8 parallel commands each approving a distinct origin
recorded only 5, and a concurrent `approveServer` straddling the final write of
`aai login` DISCARDS THE API KEY — the login prints "your API key is saved" and
the next command says `not_logged_in`. The window is wide open in practice,
because `aai login` polls for up to five minutes while the user approves in the
browser, so anything else run in that time can be mid-update when the key lands.
The lock is a `wx` exclusive-create lockfile with three deliberate properties:
acquisition is **bounded** (on timeout the update proceeds UNLOCKED rather than
throwing — failing a login on a stuck lockfile is worse than the lost update),
a **stale** lock is broken (a process killed mid-update must not send every later
write down the unlocked path forever), and it must **never nest** (re-entry
self-deadlocks until the timeout; `executeLogin` calls `approveServer` and the
key update in sequence, not nested). `.aai/project.json` deliberately keeps the
last-write-wins behaviour — it is per-directory, not shared across every command
and terminal.

**`aai dev` is the one command a shell-exported key still reaches, and only as
a provider credential.** `resolveAgentEnv` (`_dev-server.ts`) falls back to the
login key only when NEITHER `.env` nor the shell carries one — otherwise
exporting the key the usual way would hard-fail with `not_logged_in`. The
exported value deliberately never enters `ctx.env`: it reaches the resolvers
through `withHostCredentialFallback` (the same documented ergonomic every other
provider key gets), and `agentEnvWarnings` flags it as shell-only so the "works
here, dead after deploy" case stays visible.

**Tests must never resolve the real config dir.** `getConfigDir()` returns a
per-process temp dir whenever `VITEST` is set (unless `AAI_CONFIG_DIR` says
otherwise), and `aaiEnv()` sets `AAI_CONFIG_DIR` for the CLIs the e2e suite
spawns. The guard is in the code path, not a vitest setup file, because
setup files are per-config and any config can omit one — `vitest.slow.config.ts`
(integration + e2e) declared none, so `_test-setup.ts` never ran for those
suites and real configs accumulated ~100 approved loopback origins plus
`https://override.com`. That matters because `approvedServers` is the trust
anchor for a repo-supplied `serverUrl`: a pre-approved loopback origin lets a
cloned repo's `.aai/project.json` collect the developer's API key and secret
values with no prompt, which is exactly what the loopback tightening above
removed. Spawned CLI children run with `VITEST` cleared (or the CLI skips
`main()`), so both halves are needed.

Note also that `aai build` and `aai dev` evaluate the repository's bundled
`agent.ts` in the host process (`evalWorkerBundle`, via a `data:` URL
import) — running either against an untrusted clone executes that repo's
code locally. `aai deploy` no longer does: every worker self-describes its
config (`__aaiConfig`, generated by `buildWorker`'s wrapper entry) and the
server extracts it guest-side (`extractAgentConfig` → `describeBundle`), so
the deploy path uploads without evaluating. A bare `aai` in a project still
asks for confirmation on a TTY before implicitly deploying.

### Testing security boundaries

- `modal-sandbox.test.ts` — Modal spawn flow against an injected fake
  context: sandbox creation, tunnel dial + per-sandbox token, teardown on
  failure. (Isolation itself — filesystem, memory — is enforced by Modal's
  sandbox boundary, not host code.)
- `aai-guest/harness.test.ts` — the guest's `run_code`
  executor (console capture, thrown-error reporting, timeout). It does NOT
  test network/filesystem/env denial: the executor has no in-process
  sandbox — the Modal container is the boundary, so those are Modal's to
  enforce, not host code's.
- `net.test.ts` / `ssrf-extended.test.ts` — SSRF bypass prevention
  (IPv4-mapped IPv6, cloud metadata, `.internal` domains).

There is deliberately **no load or chaos tier.** `packages/aai-server/load/`
and `packages/aai-server/adversarial/` (plus the `load-and-adversarial` CI
job and `docker-compose.load.yml`) were deleted, because what they asserted
had drifted away from what they claimed to test:

- The two "adversarial" tests deployed an agent whose tool body was a
  `while (true) {}` spin or an unbounded allocation loop — **and then never
  invoked it.** No message was ever sent on the socket and the deploy seeded
  a fake `ASSEMBLYAI_API_KEY`, so no LLM existed to call the tool. Both
  amounted to "an idle server stays under 90% memory." Their docstrings still
  described "the isolate" and a "V8 heap (128 MB limit)" — the secure-exec
  design replaced two architectures ago.
- `lru-eviction.test.ts` configured `MAX_SLOTS` / `SLOT_IDLE_MS`, neither of
  which exists in the server anymore; testcontainers passes unknown env vars
  through silently, so it stayed green while testing nothing.
- `ws-memory.test.ts`, `session-memory.test.ts`, and
  `s2s-session-memory.test.ts` were benchmarks with `.test.ts` extensions —
  their only assertions were shape checks like `results.length > 0` and
  `sessions.length === TIERS.at(-1)`. `ws-memory` imported no aai-server code
  at all; it measured the `ws` package.
- `sandbox-storm.test.ts` swallowed deploy failures and passed on
  `aliveCount > 0` — 1 of 14 sandboxes working was a pass.

Two were real (`connection-flood`, `kv-corruption`), but not worth an 8-minute
Docker job wired into the required `ci` gate, where a wall-clock memory
threshold on a shared runner blocks merges when it flakes.

If you reintroduce load or chaos testing, the bar is: **the hostile code must
actually execute** (put it at the bundle's top level so the boot-time load
triggers it — no LLM needed), the thresholds must be tied to constants the server
really reads, and it belongs outside the merge gate. Note also that a
successful WebSocket upgrade proves nothing about the sandbox:
a client can hold an open `/session` socket to a guest whose runtime
failed to build (it is accepted, then closed 1011), so `opened.length === 1`
can hold while every sandbox fails.

### Known limitations

- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`)
  and `aai-ui` (`.`). Subpath exports (e.g. `./protocol`) are not covered
  by type tests.
