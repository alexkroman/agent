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
| Evals | `pnpm --filter aai-server test:evals` | LLM-in-the-loop studio codegen evals (vitest-evals) | 300s |

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

Six workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: manifest, types, protocol, S2S, session, Db |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (React 19): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, deploy, delete, secret |
| `packages/aai-server/` | `aai-server` | Managed platform server (private): sandbox, sidecar, auth, SSRF |
| `packages/aai-studio-client/` | `aai-studio-client` | The studio's browser front-end (private): Vite React app served by aai-server |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |

**Dependency flow:** `aai-cli`, `aai-ui`, and `aai-server` all depend on
`@alexkroman1/aai` (via `workspace:*`). The one edge between them is
`aai-server` → `aai-cli`, and only for its two public bundler subpaths
(`/worker-bundler`, `/client-bundler`): the studio builds workspaces
through the CLI's own Vite pipeline rather than carrying a second
bundler. Do not widen it — nothing else in the server may import from
the CLI, and the CLI must never import from the server.

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
- `./manifest` — `parseManifest()`, `toAgentConfig()`, `agentToolsToSchemas()`
- `./stt` — pipeline-mode STT provider factories (e.g. `assemblyAI`)
- `./tts` — pipeline-mode TTS provider factories (e.g. `cartesia`)
- `./vector` — Vector provider factories (`pinecone`, `inMemoryVector`)

#### `aai-ui` (UI)

- `.` — default React UI component + session + client helpers
- `./styles.css` — default styles
- `./default-client/*` — prebuilt default client assets (`dist/default-client/`)

#### `aai-cli` (CLI)

Binary: `aai` — subcommands: init, dev, test, build, deploy, delete, secret

### SDK structure

The SDK is organized into two directories with a **hard dependency
boundary** — this split is critical for sandbox security:

- **`sdk/`** — shared modules with **zero Node.js dependencies**. Safe to
  run in browsers, Deno, and sandboxed environments. Contains:
  `types.ts`, `db.ts`, `hooks.ts`, `utils.ts`, `constants.ts`,
  `protocol.ts`, `system-prompt.ts`, `manifest.ts`,
  `ws-upgrade.ts`, `_internal-types.ts`, `define.ts` (`agent()` and
  `tool()` helpers for authoring `agent.ts` files).
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

The guest harness (`guest/deno-harness.ts`) runs Deno inside each
Modal Sandbox, loading the agent's ESM bundle directly — no import
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
- `sandbox.ts` — agent sandbox management
- `sandbox-vm.ts` — per-agent sandbox lifecycle (start, teardown)
- `sandbox-agent-config.ts` — the deploy-time `IsolateConfig` → runtime-agent
  boundary: `toRuntimeAgent` passes the config through unchanged minus the
  `WIRE_ONLY_CONFIG_FIELDS` deny-list (see "One canonical config schema")
- `sandbox-guest-rpc.ts` — guest→host db/Vector/fetch RPC schemas + handler registration
- `sandbox-pool.ts` — pool of pre-warmed Deno harnesses for fast cold starts
- `sandbox-network.ts` — network proxying for sandbox
- `sandbox-slots.ts` — slot allocation for concurrent sessions
- `modal-sandbox.ts` — Modal Sandbox backend: creates remote sandboxes via
  the `modal` SDK, writes the harness, execs Deno, adapts web streams to the
  NDJSON transport
- `guest/deno-harness.ts` — Deno guest entry point (runs inside a Modal Sandbox)
- `modal_deploy.py` — Modal deployment of the server itself (`@modal.web_server`
  wrapping the node process); `pnpm --filter aai-server deploy:modal`
- `ndjson-transport.ts` — NDJSON-over-stdio transport for host↔guest RPC.
  Connections are typed by a per-direction method map (`RpcSchema`); the
  sandbox link's concrete map is `GuestRpcSchema` in `rpc-schemas.ts`, so
  method names and outgoing request params are compile-checked at every
  call site while results/incoming params stay `unknown` (untrusted wire
  data — Zod at the receiving site is the contract)
- `transport-websocket.ts` — WebSocket transport layer
- `auth.ts` — authentication/authorization
- `credentials.ts` — credential derivation
- `bundle-store.ts` — agent bundle storage (Supabase Storage via its
  S3-compatible endpoint in production, memory in dev/tests). Agent env
  lives in Supabase Vault through the injected `SecretStore`, not in the
  manifest blob.
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
- `metrics.ts` — Prometheus metrics registry and definitions; mounted at
  `/metrics` (internal-only).
- `studio/` — the browser studio server side (see "Browser studio"):
  `studio-routes.ts` (HTTP surface), `studio-agent.ts` (coding-agent LLM
  loop + tools), `studio-llm.ts` (provider/model selection + the picker's
  option list), `studio-sandbox.ts` (per-chat-session sandbox),
  `studio-edit.ts` (`edit_file`'s matching + diff), `studio-grep.ts`
  (workspace content search), `studio-workspace-dir.ts`
  (materializes a workspace to a scratch dir),
  `studio-bundle.ts` (worker build + import allowlist),
  `studio-client-build.ts` (client.tsx build), `studio-errors.ts`
  (`StudioBuildError`), `studio-deploy.ts` (build → sandbox inspect →
  deploy), `studio-workspace.ts` (project file store), `studio-prompt.ts`
  (system prompt from the scaffold CLAUDE.md), `studio-static.ts` (serves
  the built client)
- `packages/aai-studio-client/` — the studio's React front-end (Vite +
  Tailwind v4 + `useChat` + TanStack Query + CodeMirror), its own private
  workspace package built into its `dist/` by
  `pnpm --filter aai-studio-client build`. It talks to the server purely
  over HTTP/SSE (no code imports in either direction); aai-server serves
  the built artifact, resolved via `require.resolve` in
  `studio-static.ts` the same way aai-ui's `dist/default-client` is.
  Panes: `chat.tsx` (chat + composer), `code-view.tsx` / `preview.tsx`
  (the Code/Preview pane).

### Browser studio (aai-server)

Loading the platform server root (`GET /`) serves the **studio** — a
browser-based coding agent (TypeScript agent loop on the Vercel AI SDK,
the same `streamText` stack pipeline mode uses) that builds and deploys
voice agents without the CLI:

- **Workspaces** are small server-side file trees stored one row per
  project in Postgres (`aai_platform.studio_workspaces`, over the same
  platform `SqlExec` Vault uses; in-memory store in dev/tests —
  `studio/workspace-store.ts`, same two-implementation pattern as
  `SecretStore`). Blob `Storage` serves only deploy artifacts. Rows carry an
  optimistic `version`: writes go through `createWorkspace` /
  `mutateWorkspace` (`studio-workspace.ts`), which retry a conflicted write
  once — the in-process keyed lock (`studio-workspace-lock.ts`) still
  serializes local writers, so a conflict means another replica. `scope` is
  a *deterministic* SHA-256 of the caller's API key (`studioScope`) — unlike
  the salted PBKDF2 ownership hashes, it must be stable so a browser session
  can find its projects again.
- **Chat** (`POST /studio/chat`) runs one agent turn with file tools
  (list/read/write/edit/delete/grep) plus `test_agent`, streamed as the AI SDK **UI
  message stream** (SSE) that the client's `useChat` consumes directly.
  The system prompt embeds the same `aai-templates/scaffold/CLAUDE.md` the
  CLI ships to user projects (`studio-prompt.ts`) plus studio-specific
  overrides. Conversations persist per project in
  `aai_platform.studio_chats` (`studio/chat-store.ts` — plain upsert, no
  version column: one writer surface, always the full snapshot), written
  server-side when the turn's UI stream settles (finish *and* client abort;
  `originalMessages`/`onFinish` in `runStudioChat`) and restored on project
  open via `GET /studio/projects/:project/chat`. Rows are capped at
  `MAX_STUDIO_CHAT_STORE_BYTES` (512 KB) by trimming whole messages from
  the front; project delete removes the chat row.
- **Docs MCP** (`studio-mcp.ts`). The system prompt embeds a *snapshot* of
  the scaffold guide, so anything outside it — a voice, a newly added
  gateway model, a provider option — was previously a guess. The agent now
  also gets AssemblyAI's docs MCP server
  (`https://www.assemblyai.com/docs/mcp`, via `@ai-sdk/mcp`'s
  `createMCPClient`) merged into its tool set. Points worth keeping:
  - One client per chat turn, closed when the stream settles, alongside the
    session sandbox. A turn is short; a shared long-lived client would be
    another thing to health-check.
  - **Failure is never fatal.** Connect and tool-listing are bounded at 5s
    and every failure path degrades to "no MCP tools this turn" — a docs
    server being down must cost a lookup, not the user's reply.
  - Studio tools are merged *on top* of MCP tools, so a server can never
    shadow `write_file`. `DENIED_TOOLS` additionally drops
    `submit_feedback`, which the docs server advertises — a coding turn has
    no business posting feedback as the user.
  - `STUDIO_MCP_URLS` overrides the default list; setting it empty disables
    MCP entirely.
- **Dev-mode key check.** `assertDevKeys` (`index.ts`) refuses to start a
  *local dev* server without `ASSEMBLYAI_API_KEY` and `BRAVE_API_KEY`. Both
  stay optional in production — the studio degrades (chat 503s, `web_search`
  is dropped) — but in dev that degradation is silent and reads as a bug, so
  it fails at boot where the cause is obvious. `AAI_DEV_SKIP_KEY_CHECK=1`
  overrides.
- **Every coding-agent tool runs under a per-call deadline**
  (`studio-tool-timeout.ts`, `STUDIO_TOOL_TIMEOUT_MS`, default 120s —
  generous because `test_agent` runs a full Vite build). A hung call (dead
  sandbox RPC, silent MCP server, stalled web fetch) used to hang the whole
  turn with the client's tool row shimmering forever; the wrapper resolves
  it to an error tool result instead. It is a resolution race, not a
  cancellation — the abandoned work dies with the turn's teardown. The
  client side of the same problem is the composer's **Stop button**
  (`chat.tsx`): while a turn streams, send becomes stop; `useChat().stop()`
  aborts the SSE fetch, the route's `c.req.raw.signal` fires, and
  `streamText` cancels the LLM call while `disposeSandbox` tears down the
  sandbox and MCP clients. A failed sandbox provisioning is retried on the
  next tool call, not cached for the turn (`studio-routes.ts`).
- **Web access** (`studio-web.ts`) exposes the SDK's own `visit_webpage`,
  `get_page_design`, and `web_search` builtins to the coding agent rather than reimplementing
  them — which is what buys `safeFetch`, the SSRF guard. A URL here is
  model-controlled and the studio runs on the platform host, so a
  hand-rolled `fetch` would be a request-forgery hole aimed at the metadata
  endpoint. `visit_webpage` and `get_page_design` need no key; `web_search`
  is dropped from the
  tool set unless the host holds `BRAVE_API_KEY`, since without one it can
  only return "not set" and waste a turn. The tool context is built from
  that single variable, never `process.env`, so a coding turn cannot read
  the host's other credentials.
- **The preview shows the *published* agent**, so edits look like they did
  nothing until Publish. `hasUnpublishedChanges` (`studio-workspace.ts`)
  compares a `filesHash` of the workspace against `deployedHash`, recorded
  on every successful deploy, and `GET /studio/projects/:project` returns it
  as `unpublished` so the client never hashes anything. The preview then
  says so, with a Publish button in the banner. A hash rather than a
  timestamp for two reasons: publishing itself writes the workspace (which
  bumps `updatedAt`), and editing a file then undoing it should not leave
  the project permanently "stale".
- **The coding agent cannot publish.** There is deliberately no deploy
  tool: going live is the user's call, made with the Publish button
  (`POST /studio/projects/:project/deploy`). The prompt states this
  outright so the agent doesn't claim to have deployed or invent a live
  URL. Keep it that way — an agent that ships to a public URL on its own
  read of "make it live" is a surprise nobody asked for.
- **LLM selection** (`studio-llm.ts`) uses the SDK's own provider
  descriptors + `resolveLlm` (exported from `@alexkroman1/aai/runtime`).
  Keys are **platform-owned host config**, never tenant env. Default: the
  AssemblyAI LLM Gateway when `ASSEMBLYAI_API_KEY` is set (model `gpt-5.5` —
  OpenAI models are the only ones the gateway documents streamed responses
  for), else Anthropic via `ANTHROPIC_API_KEY`;
  `STUDIO_LLM_PROVIDER`/`STUDIO_LLM_MODEL` override (any pipeline-mode LLM
  provider). Chat returns 503 when unconfigured — the editor and deploy
  button still work without it.
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
  model and never supplies a key** — keep it that way: reintroducing any
  request-side choice must stay validated against host-held keys.
- **Session sandboxes run the agent's code work on production infra**:
  each chat request lazily provisions one sandbox (`studio-sandbox.ts`)
  through the same warm-pool/`spawnWarmHarness` path deployed agents use
  (a remote Modal Sandbox). `test_agent` builds the workspace, loads the
  bundle there (repeat `bundle/load` replaces it), validates the config,
  and can trial-run one of the agent's tools via `tool/execute` against a
  scratch Vector (no db — ctx.db reports storage-not-enabled) — no tenant
  data, no secrets in the guest. Deploy
  config extraction reuses the same sandbox; the standalone deploy route
  uses a throwaway one (`describeBundle` in `sandbox-vm.ts`). The LLM
  orchestration itself stays host-side — the guest has no network device
  by design.
- **Builds never run in the server's process.** Every studio build executes
  the build entry (`studio/studio-build-entry.ts`, wire contract in
  `studio-build-protocol.ts`) out of process, selected by
  `studio-build-runner.ts`: in production `STUDIO_BUILD_BACKEND=modal` (set
  by `modal_deploy.py`'s image env) ships the build to the `studio_build`
  Modal Function — same image, separate container, **no secrets attached** —
  while dev/tests default to spawning the same entry as a local child
  process (`subprocess` backend). Vite/Rollup over untrusted workspace trees
  therefore never competes with live voice sessions for the web container's
  CPU, and never runs in the process holding platform credentials; it also
  moots the `withPreservedNodeEnv` hazard for studio builds, since the
  `NODE_ENV` mutation dies with the build process. There is deliberately
  **no in-process build path and no fallback between backends** — a failed
  backend is a failed build, loudly. Compile errors cross the process
  boundary as classified wire data and are rethrown host-side as
  `StudioBuildError`, so the coding agent still gets a message it can act
  on. `STUDIO_BUILD_TIMEOUT_MS` bounds each build (default 180s; the
  subprocess is killed on the deadline), and
  `STUDIO_BUILD_MODAL_APP`/`STUDIO_BUILD_MODAL_FUNCTION`/
  `STUDIO_BUILD_ENTRY_PATH` override the backend wiring.
- **Builds run through the CLI's bundlers, not copies of them.**
  `withWorkspaceDir` (`studio-workspace-dir.ts`) materializes the
  workspace to one scratch dir and both builds read it. The scratch dir
  lives under the server package, not `os.tmpdir()`, so Node resolves
  `@alexkroman1/aai`, `zod`, `react`, and `@alexkroman1/aai-ui` by
  walking up to the workspace `node_modules`. Workspace keys are
  re-validated with `SafePathSchema` at the point they become real paths.
- **Worker build** (`studio-bundle.ts`) calls `buildWorker` from
  `@alexkroman1/aai-cli/worker-bundler` — the same Vite/Rollup pass
  `aai deploy` runs. The studio supplies the policy on top:
  - A generated entry (`__aai-entry.ts`) re-exports the agent *and* its
    config as `__aaiConfig` (via the dependency-free
    `@alexkroman1/aai/manifest` helpers) so the guest reports the config
    back from `bundle/load`. **User code is never evaluated on the host** —
    which is why only `buildWorker` is reused and *not* the CLI's
    `buildAgentBundle`, whose `evalWorkerBundle` dynamic-imports the built
    worker.
  - `allowlistPlugin` enforces the import policy: workspace files,
    `@alexkroman1/aai` (any subpath), and `zod`; `node:` builtins stay
    external (CLI parity). It also **rejects any relative or absolute
    import resolving outside the scratch dir** — that dir is a real
    directory inside the server package, so a `../` climb would otherwise
    pull server source into the guest bundle. The in-memory esbuild
    version got this for free ("file not found"); on a real filesystem it
    has to be an explicit check.
  - `configFile: false` — a `vite.config.ts` is executable host code and
    workspace files are untrusted, so any the agent writes is inert.
  - Diagnostics are scrubbed (`scrub`) of the scratch-dir prefix and ANSI
    codes; the coding agent only knows workspace-relative paths.
- **Vite must not be allowed to mutate `process.env`.** Vite's `build()`
  sets `NODE_ENV=production` when it is unset — a permanent, global side
  effect on the calling process. Both CLI bundlers therefore wrap the
  build in `withPreservedNodeEnv` (`aai-cli/_vite-env.ts`), which
  snapshots and restores it. Without that, the first studio build in a
  `pnpm dev:aai-server` process flips the server to "production", where
  strict credential and storage checks break every later deploy; `aai dev`,
  which rebuilds on every file change, has the same problem. Keep any new
  Vite invocation inside that wrapper.
- **Client build** (`studio-client-build.ts`) handles a workspace
  `client.tsx`, built by `buildClient` from
  `@alexkroman1/aai-cli/client-bundler` — the same Vite pass
  `aai deploy` runs, so browser-published UIs match
  CLI-deployed ones. The studio injects `@vitejs/plugin-react` +
  `@tailwindcss/vite` (a workspace has no `vite.config.ts`) and passes
  `configFile: false`. No `client.tsx` → `{}` → the agent gets the
  default UI.
- **`buildClient` dedupes React** (`resolve.dedupe`), because `aai-ui`
  declares it as a *peer* dependency while the bundler resolves the bare
  `react/jsx-runtime` inside `aai-ui/dist/**` from *that file's* real path.
  Locally aai-ui's own devDependency satisfies it; a pruned production
  install can leave `aai-server`'s copy as the only React — which the build
  root (the scratch dir under that package) reaches and
  `packages/aai-ui/dist` does not. Publishing died with *"Rolldown failed to
  resolve import react/jsx-runtime"* while every local build passed.
  `aai-cli/client-bundler.test.ts` guards this (every non-optional aai-ui
  peer is deduped). The Modal image installs the full workspace (dev deps
  included), so the old pruned-image packaging tests are gone with the
  Dockerfile.
- **Deployed-agent credentials.** The studio has no secrets UI, so a
  published agent would otherwise start with an empty env — its S2S
  connect sends an empty bearer token (`runtime-transport.ts`:
  `env[ASSEMBLYAI_API_KEY_ENV] ?? ""`) and AssemblyAI answers
  `unauthorized`. The bearer token a studio caller
  authenticates with *is* their AssemblyAI key (see `aai-cli/_config.ts`),
  so `studio-deploy.ts` seeds it as the agent's `ASSEMBLYAI_API_KEY` via
  `DeployParams.defaultEnv`. `defaultEnv` is an env **floor**, not an
  override: `deployLocked` merges it as `{...defaultEnv, ...storedEnv, ...env}`,
  so a key the user set deliberately (deploy-time `env`, or `aai secret put`
  afterwards) always wins. This stays inside the credential-separation
  rule — it forwards *the caller's own* key, never a platform-owned one.
- **Client**: `packages/aai-studio-client` is a Vite-built React app;
  `studio-static.ts` resolves its `dist/` via `require.resolve` and serves
  it at `/` with hashed assets under `/studio-assets/`. When it hasn't
  been built, `GET /` serves a fallback page with build instructions
  (unit tests don't require it).
- **Reserved slugs** (`RESERVED_SLUGS` in `schemas.ts`): `studio` and
  `studio-assets` can never be claimed as agent slugs — they would shadow
  the studio routes. Enforced in `validateSlug`, `DeployBodySchema`, and
  the deploy core.

### `ctx.generate` and pattern combinators (`@alexkroman1/aai/patterns`)

Tool `execute` code gets one-shot LLM generation via `ctx.generate` — a
**host capability like `ctx.db`**: the guest has no network, so the platform
proxies it over the `llm/generate` guest RPC (`sandbox-guest-rpc.ts` +
`guest/harness-rpc.ts:generateAdapter`), while `aai dev` runs it in-process.
One implementation, `createGenerateFn` (`host/generate.ts`, exported from
`/runtime`): descriptors resolve through the same `resolveLlm` registry as
the pipeline model, credentials from the agent env only. Defaults to the
agent's own pipeline `llm`; a per-call `llm` descriptor works for S2S agents
holding that provider's key. In self-hosted mode the fn is exempted from the
tool-egress fetch guard (like db/vector) — provider traffic is
infrastructure, not agent egress.

`GenerateOptions.schema` is **plain JSON Schema, never a Zod schema** — the
options must survive the NDJSON RPC boundary, and both implementations
reject Zod schemas so dev and prod cannot drift. The typed ergonomics live
in `sdk/patterns.ts` (subpath `@alexkroman1/aai/patterns`, Node-free): the
five Vercel-AI-SDK workflow patterns as pure combinators over a
`GenerateFn` — `sequential` (chains), `parallel`, `route` (classify +
dispatch), `orchestrate` (plan → workers → synthesize), and
`evaluatorOptimizer` (generate → judge → retry with feedback) — plus
`generateStructured`, which converts Zod → JSON Schema caller-side and
re-validates the result. The subpath was renamed from
`@alexkroman1/aai/workflow` (a name that collided with a since-removed
`workflow()` app kind).

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
  `aai-server/client-config-handler.ts`. In `aai-ui`, `client()`'s config
  tier renders `DefaultRoot`, which fetches the config (any failure degrades
  to the empty default, so older servers keep working) and mounts the chat
  shell; the shell uses the server-declared `name` unless `client({ name })`
  overrides it. A custom `component` ignores all of it. The `aai dev` Vite
  proxy forwards `/client-config` to the backend.

- **There is no text-only mode.** Every pipeline agent declares a real TTS
  provider, and the default `ChatView` always renders the voice `Controls`.
  The snapshot's `apiUrl` field carries the programmatic WebSocket endpoint,
  shown by `ApiUrlChip`.

Reference providers shipped today:

- **STT**: one of
  - `assemblyAI({ model: "u3pro-rt" })` — `ASSEMBLYAI_API_KEY`
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
  `assemblyAI({ connectTimeoutMs, maxConnectRetries })`. The retry policy is
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
  - `gateway({ model })` — `AI_GATEWAY_API_KEY`; routes through the
    [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), one endpoint
    fronting hundreds of models addressed as `"creator/model"` (e.g.
    `gateway({ model: "zai/glm-4.6" })`). Resolved via `createGateway`
    from the `ai` package — no extra `@ai-sdk/*` dependency.
  - `assemblyAI({ model, region? })` — `ASSEMBLYAI_API_KEY`; routes through
    the [AssemblyAI LLM Gateway](https://www.assemblyai.com/docs/llm-gateway)
    (OpenAI-compatible chat-completions endpoint fronting 25+ models) via
    `@ai-sdk/openai`'s `.chat()` client. `region: "eu"` selects the EU
    endpoint. Same factory name as the STT provider — alias one on import.
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
  - `assemblyAI({ voice, language? })` — `ASSEMBLYAI_API_KEY`; AssemblyAI's
    streaming TTS over `wss://streaming-tts.assemblyai.com/v1/ws/`. Third
    factory named `assemblyAI` (STT and LLM have one too) — alias on import.
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

### Storage (`ctx.db`) + Vector

There is no KV store anymore. Persistent state is the opt-in **app
database**: enabling storage for an app (CLI `aai storage enable`, the
studio's Storage toggle, or `DATABASE_URL` in the project `.env` under
`aai dev`) gives its tools `ctx.db` — a SQL handle
(`query<T>(sql, params?)`, `$1` placeholders) backed by a per-app schema in
the platform's Supabase Postgres. Accessing `ctx.db` without storage
enabled throws with that enablement guidance. On the platform each app
gets its own schema + login role (search_path pinned, 10s
statement_timeout); credentials live in Supabase Vault. Session-scoped
scratch belongs in `ctx.state` (or the `remember`/`recall` builtins, now
in-memory per-session).

`Vector` is unchanged: `agent.ts` may declare `vector:` (BYO Pinecone,
resolved with the agent's env), else the platform default applies. Both
`ctx.db` and `ctx.vector` reach the guest as host-proxied RPC
(`db/query`, `vector/*`).

### Guest egress (`allowedHosts`)

`fetch` from an agent's own tool code only works against hostnames the agent
declares in `agent({ allowedHosts: [...] })`. The guest has no network
device, so its `fetch` is RPC-proxied to the host, which matches the
hostname against the list (`sandbox-fetch.ts`) *and* SSRF-screens the
request. The host-side network builtins (`fetch_json`, `visit_webpage`,
`get_page_design`, `web_search`) bypass the list entirely — they run in the
server process, so
they reach any public host with nothing declared. Those are two different
capabilities that both read as "the agent can call an API".

`allowedHosts` is **tenant-controlled input**, so it is validated at three
points from one implementation (`AllowedHostsSchema` in
`sdk/allowed-hosts.ts`): `AgentConfigSchema` (worker→host), `ManifestSchema`,
and the platform's `IsolateConfigSchema`. The server re-validates rather
than trusting that the CLI ran the rules — the list arrives inside a
tenant's bundle and decides that agent's egress. Patterns are bare
hostnames with at most one leading `*.`; protocols, paths, ports, IP
literals, bare `*`, and `.internal`/`.local`/`.localhost` TLDs are refused.

### Dev/prod parity for tool fetches

An agent's tool code runs in two very different places — a network-blocked
Modal/Deno guest on the platform, the plain Node host process under
`aai dev` — and the policy governing its `fetch` must not differ, or the
first time a developer learns about a limit is a production incident.

**One implementation, two call sites.** `host/guest-fetch-policy.ts` holds
the whole decision: `checkToolFetch()` (allowlist, request-body cap,
concurrency, URL validity) and `performToolFetch()` (SSRF screening,
per-redirect-hop allowlist re-check, timeout). The platform's
`sandbox-fetch.ts` and the self-hosted guard in `host/tool-egress.ts` both
call them and hold **no limits of their own** — the numbers live in
`sdk/constants.ts` as `TOOL_FETCH_*`. Adding a limit means editing the
policy, not a caller; a caller-side check is the drift this arrangement
exists to prevent.

The one unavoidable split is response size: the platform enforces it while
relaying NDJSON chunks, self-hosted mode via `capResponseBody()`'s
`TransformStream`. Same constant, different mechanism, both documented in
that module.

**Self-hosted enforcement mechanism** (`host/tool-egress.ts`): an
`AsyncLocalStorage` scope entered around each *custom* tool call, consulted
by a wrapped global `fetch`. Per-async-context rather than per-process
because one session's policy must not leak into another's. Two deliberate
exemptions, both matching what the platform actually restricts:

- **Built-in network tools** (`fetch_json`, `visit_webpage`,
  `get_page_design`, `web_search`)
  execute host-side in production too, where `allowedHosts` never applies.
- **`ctx.db` / `ctx.vector`** are RPC methods in the guest, not `fetch`, so
  the database (and a BYO `pinecone` endpoint) needs no declaration.
  `exemptFromToolEgress()` proxies them to run outside the scope.

`node:async_hooks` is banned in `sdk/` (which must stay Node-free) but
allowed in `host/` — the biome override was package-wide, with a
guest-VM-availability rationale that never applied to host-only code.

**Guest permissions are identical everywhere** — dev and production run
the same Modal spawn (`modal-sandbox.ts`), which passes `--no-prompt` and
nothing else. The harness needs no Deno grants: the bundle arrives over RPC
and loads from a `blob:` URL, and sibling harness modules are bundled in.

**Known remaining asymmetries**, none closable without larger work:

| Divergence | Direction | Why it stands |
| --- | --- | --- |
| `aai dev` runs tools in **Node**, production in **Deno** with no permissions | works in dev, fails in prod | `process.env`, `node:fs`, `child_process` are all reachable locally. Closing it means running dev tool code in a Deno sandbox — a dev-server redesign, not a tweak. |
| Modal memory/CPU limits (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) | works in dev, fails in prod | `aai dev` runs tools in the host process with no caps; a memory-hungry tool OOMs only when deployed. |
| `run_code` | fails in dev, works in prod | The host-side guard refuses rather than evaluating in-process. Fail-closed, so harmless. |
| `withHostCredentialFallback` (`providers/host-env.ts`) | works in dev, fails in prod | Deliberate ergonomic: an exported `ANTHROPIC_API_KEY` should work for `aai dev`. The prod failure is a loud auth error at session start. |
| `ctx.db` backing (BYO `DATABASE_URL` in dev vs platform-provisioned schema+role) | prod is stricter | Dev connects wherever the developer points it; prod pins search_path + statement_timeout on a per-app role. |
| Platform sandboxes need Modal credentials | prod is stricter | `aai dev` runs tools in-process; the platform (any machine with `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`) spawns real Modal sandboxes — see "Modal sandbox notes". |

**One canonical config schema, deny-list boundaries.** The dropped-field bug
family (`builtinTools` — deployed agents silently lost the default cognitive
builtins; `send`; the provider triple; `allowedHosts`) all came from
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
  (`AgentParams` = `Omit` + `Partial<Pick>` of the defaulted fields) instead
  of re-declaring it inline — the inline form is how `send` and `state`
  shipped as runtime-working but excess-property errors for authors
  (neither bundler typechecks user code). `define.test-d.ts` locks this.
- **`IsolateConfigSchema`** (`aai-server/rpc-schemas.ts`) is
  `AgentConfigSchema.extend({...})` — the extensions are wire-tolerance
  loosenings (a stored bundle from an older CLI must keep loading), wire
  defaults, and the wire-only `toolSchemas`; none may drop a field.
- **`toRuntimeAgent`** (`aai-server/sandbox-agent-config.ts`) passes the
  whole config through minus `WIRE_ONLY_CONFIG_FIELDS` (`toolSchemas`,
  `mode`). The provider descriptors ride on the runtime agent itself
  (`createRuntime` resolves `opts.stt ?? agent.stt`), keyed off the
  descriptors' own presence — never `config.mode`, which is optional: a
  config carrying all three providers with no `mode` once hit a
  `config.mode === "pipeline"` gate and lost every one of them, so
  `createRuntime` resolved S2S and ran a healthy S2S session on the agent's
  own key, nothing logged. `superRefine` rejects a `mode` that disagrees
  with the descriptors. Host mode (`ws-host-mode.ts`) uses the same
  function, so a pipeline agent driven over `?host=1` stays pipeline.
  `rpc-schemas.test.ts` asserts both subtractions:
  `Exclude<keyof AgentConfig, keyof IsolateConfig>` and
  `Exclude<keyof IsolateConfig, keyof AgentDef | WireOnlyConfigField>` are
  `never`.

A new serializable agent field therefore needs exactly two edits — `AgentDef`
(docs + type) and `AgentConfigSchema` (shape) — and the type guards fail
loudly if either half is missing; no mapper edits, and the field reaches the
server, the wire, and the runtime by default.

**Never let S2S be a fallback.** `buildTransport`
(`host/runtime-transport.ts`) reaches `buildAssemblyS2sTransport` by
fallthrough, so any path that loses the providers yields a fully functional
session in the wrong mode. Two rules keep that diagnosable: forward providers
based on their own presence (above), and `createRuntime` logs
`"Session mode resolved"` once per runtime with the mode and provider kinds —
"which transport is this agent on" must be answerable from one log line rather
than inferred from the shape of the message stream (`S2S <<` prefixes).

### Data flow

Audio path depends on the session mode (see above):

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
`VoiceIOOptions.onPlaybackStats` and logged by the default session. Nothing
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
| `@alexkroman1/aai/manifest` | `sdk/manifest-barrel.ts` → 3 modules | `parseManifest()`, `toAgentConfig()`, `agentToolsToSchemas()`, system prompt builder |
| `@alexkroman1/aai/stt` | `host/providers/stt-barrel.ts` | STT provider factories + types (`assemblyAI`, `deepgram`, `elevenlabs`, `soniox`) |
| `@alexkroman1/aai/llm` | `host/providers/llm-barrel.ts` | LLM provider factories + types (`anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`, `gateway`) |
| `@alexkroman1/aai/tts` | `host/providers/tts-barrel.ts` | TTS provider factories + types (`cartesia`, `rime`, `assemblyAI`) |
| `@alexkroman1/aai/vector` | `sdk/providers/vector-barrel.ts` | Vector provider factories + types (`pinecone`, `inMemoryVector`) |
| `@alexkroman1/aai/patterns` | `sdk/patterns.ts` (direct, not a barrel) | Workflow-pattern combinators over `ctx.generate` (`sequential`, `parallel`, `route`, `orchestrate`, `evaluatorOptimizer`, `generateStructured`). Node-free — runs in the guest sandbox |

### Default values and magic numbers

All numeric constants live in `packages/aai/sdk/constants.ts` (client-audio
budgets are split into `sdk/client-audio-constants.ts` for file-length reasons
and re-exported from `constants.ts`, so the import path is unchanged). Key
defaults that affect agent behavior:

| Default | Value | Where applied | Notes |
| --- | --- | --- | --- |
| `maxSteps` | 10 (`DEFAULT_MAX_STEPS`) | `constants.ts` | Max tool calls per reply. Prevents runaway tool loops; sized so multi-tool chains plus a repair retry fit. |
| `toolChoice` | `"auto"` | `manifest.ts:59` | LLM decides when to use tools vs respond directly. |
| `idleTimeoutMs` | 300,000 (5 min) | `constants.ts:26` | `0` or non-finite disables the timer entirely. |
| `silenceTimeoutMs` | unset (disabled) | `pipeline-silence.ts` | Pipeline only: assistant proactively takes a turn after this much user silence. Capped at `MAX_CONSECUTIVE_SILENCE_NUDGES` (3) back-to-back nudges until the user speaks again. `silencePrompt` customizes the injected instruction (default `DEFAULT_SILENCE_PROMPT`); it is kept in LLM history but never emitted as a user transcript. |
| `minBargeInWords` | 2 (`DEFAULT_MIN_BARGE_IN_WORDS`) | `constants.ts` | Pipeline only: interim-transcript words before user speech interrupts the in-flight reply. 2 keeps one-word backchannels from cutting the agent off; sub-threshold finals are answered after the reply. |
| `interruptionMinDurationMs` | 0 (disabled) | `pipeline-transport.ts` | Pipeline only: sustained speech (ms since the utterance's first partial) required before an interim-triggered barge-in fires — LiveKit's `min_interruption_duration` analog. Finals are never gated. |
| Deepgram `endpointing` | 100 (`DEFAULT_DEEPGRAM_ENDPOINTING_MS`) | `sdk/providers/stt/deepgram.ts` | Provider endpointing serializes with the transport settle windows, so it stays low; override via `deepgram({ endpointing })`. |
| `endpointSettleMs` | 1500 (`DEFAULT_ENDPOINT_SETTLE_MS`) | `constants.ts` | Pipeline only: wait after an STT final before committing the turn, aggregating disfluent multi-final utterances. `completeSettleMs` (500) is the shorter window for clearly-complete finals. 0 disables. |
| `holdPhrase` | `"One moment."` (`DEFAULT_HOLD_PHRASE`) | `pipeline-stream.ts` | Pipeline only: spoken when a turn opens with a tool call and no speech. `""` disables. |
| `errorPhrase` | `"Sorry, I had a problem just then. Could you say that again?"` (`DEFAULT_ERROR_PHRASE`) | `pipeline-turn-outcome.ts` | Pipeline only: spoken when the turn's LLM stream fails, so a provider outage hands the conversation back instead of going silent. A failed turn produces no text, so nothing would otherwise reach TTS and the only trace is a `llm` session error the browser surfaces without a sound. `""` disables. |
| dead-air cover | 2000 ms (`DEFAULT_DEAD_AIR_COVER_MS`) | `pipeline-stream.ts` | Pipeline only: tool execution that sends nothing to TTS for this long gets a `DEAD_AIR_COVER_PHRASES` filler — unlike `holdPhrase` this is time-based, so it still fires after the model has spoken, and repeats across a tool chain with the wait doubling each time. `holdPhrase: ""` disables both. |
| `falseInterruptionTimeoutMs` | 2000 (`DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS`) | `constants.ts` | Pipeline only: a partial-triggered barge-in that never commits a user turn (STT noise) resumes the interrupted reply via a synthetic continuation turn (`DEFAULT_FALSE_INTERRUPTION_PROMPT`) after this window. 0 disables. |
| `maxHistory` | 200 | `constants.ts:52` | Sliding window of conversation messages retained. |
| resume grace | 120,000 (`SESSION_RESUME_GRACE_MS`) | `constants.ts` | How long a disconnected session's per-session tool state (`ctx.state`) survives awaiting a `?sessionId=<id>` resume — the host runtime's stateMap sweep and the platform's deferred guest `session/end` both wait it out, cancelled when the session resumes. Sized above the browser client's worst-case automatic-reconnect span (~105s); the client reconnects with the sessionId from the `config` frame, so the resumed session finds its state under the same key. |
| `builtinTools` | `DEFAULT_BUILTIN_TOOLS` (`think`, `remember`, `recall`, `calculate`) | `constants.ts` | Cognitive built-ins on by default: private reasoning scratchpad, session notes, safe calculator. Set `builtinTools` explicitly (including `[]`) to override. `web_search`/`visit_webpage`/`get_page_design`/`fetch_json`/`run_code` remain opt-in. A custom or relayed tool with the same name wins — the built-in is dropped. |

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
| aai-server | **forks** | node | — | Forks for process isolation; excludes integration tests |
| aai-studio-client | threads | node | — | `.tsx` tests via `react-dom/server` (no jsdom) |
| aai-templates | threads | node | — | Only matches `templates/*/agent.test.ts` |

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

#### Studio codegen evals (aai-server)

`packages/aai-server/studio/studio-eval.test.ts` runs the real studio
coding agent (`runStudioChat` with the host-env selected LLM) one-shot
against fresh starter workspaces and judges the workspace it leaves
behind, using [vitest-evals](https://github.com/getsentry/vitest-evals)
(`describeEval` + `createHarness` + `createJudge`):

- **`WorkerBuildJudge`** (suite judge, threshold 1): the workspace must
  build through `bundleWorkspaceWorker` — the exact Vite/Rollup pass
  Publish runs. This is the "one-shot produces syntactically valid code"
  gate.
- **`SandboxLoadJudge`** (asserted via `toSatisfyJudge` when Deno + the
  built guest harness are available): the built worker must load in a
  real studio sandbox, self-describe a valid `IsolateConfigSchema`
  config, and expose the tools the prompt asked for — the "code actually
  works" gate.
- **`TemplateParityJudge`** (threshold 0.8): the workspace must be
  functionally equivalent to a hand-written template — the "built the
  *right* thing" gate. Most cases are template-parity cases: the prompt is
  one of the studio's own starter prompts
  (`aai-studio-client/src/starters.ts`, each modeled on a template) and the
  matching `aai-templates/templates/<name>/` is the reference. The
  reference is read off disk as **text**, never imported — evaluating it
  would need the templates package's own raw-`.md` import plugin. The
  prompts are duplicated rather than shared because aai-server and
  aai-studio-client talk over HTTP only, with no code imports either way.

  Grading is one LLM call on the host-selected studio model over a fixed
  5-criterion rubric with stable ids (`mode`, `capabilities`, `state`,
  `assets`, `persona`); the score is the fraction passed, and a criterion
  the judge skips counts as a failure. `TEMPLATE_CASES` holds one case per
  distinct agent shape and `UNCOVERED` records why each remaining template
  has none, with a non-LLM guard test asserting every template is in one or
  the other — both directions, so a rename can't leave a dangling entry.

  Much of the rubric's wording exists because a **false negative** was
  observed: left to itself the judge fails a generated agent for doing
  *more* than the reference — extra tools, the framework's default cognitive
  builtins on top of an explicit `builtinTools`, a stricter system prompt.
  Two related traps: the per-case `shape` string is deliberately **not**
  shown to the judge (it read "run_code only" as a requirement and failed an
  agent for keeping the defaults), and the `ONE_SHOT` suffix is stripped
  from the judge's view of the prompt (it instructs the *builder*, and the
  judge graded the voice agent's persona against it). When a case regresses,
  suspect the rubric before the studio prompt. `temperature: 0` is
  deliberately absent — the default studio model is a reasoning model that
  rejects it, and generation variance dominates anyway.

Run with `pnpm --filter aai-server test:evals` (the e2e profile of
`vitest.slow.config.ts`). The suite is excluded from the unit project and
**skips entirely without an LLM key** (`ASSEMBLYAI_API_KEY` or
`ANTHROPIC_API_KEY`, or `STUDIO_LLM_PROVIDER`/`STUDIO_LLM_MODEL`), so
`pnpm test` stays hermetic. For the sandbox judge, build the guest
harness first (`pnpm --filter aai-server build`, or point
`GUEST_HARNESS_PATH` at one). MCP is stubbed out so the eval measures the
model + system prompt + studio tools, never the docs server. An errored
agent turn fails the run loudly — judging the leftover starter workspace
(which builds fine) would be a false pass.

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

### Modal sandbox notes

- Guest sandboxes are **remote Modal Sandboxes** (`modal-sandbox.ts`) on every
  platform — macOS dev boxes and production alike. There is no local
  child-process or gVisor fallback; without `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`
  (or a `~/.modal.toml` profile) sandbox creation fails loudly.
- The guest image defaults to `denoland/deno:latest`; pin via
  `MODAL_SANDBOX_IMAGE` for reproducible guests. `MODAL_APP_NAME` selects the
  Modal App sandboxes are created under (default `aai-server`).
- Sandboxes are created with `blockNetwork: true` and a bounded lifetime
  (`SANDBOX_TIMEOUT_SECS`, default 4h). Memory/CPU caps come from
  `SANDBOX_MEMORY_LIMIT_MB` / `SANDBOX_CPU_LIMIT`.
- **Orphan cleanup is Modal's `idleTimeoutMs`, not host code**
  (`SANDBOX_IDLE_TIMEOUT_SECS`, default 15 min). A host that dies without
  running `shutdown()`'s teardown (crash, OOM, SIGKILL past the drain
  deadline) strands its remote sandboxes with no record of them — but host
  death closes the exec'd harness's stdin, the harness exits on that EOF,
  and a sandbox with no running exec goes idle to Modal, which terminates
  it after this window instead of billing until the 4h lifetime cap. A
  healthy sandbox always has the harness exec running, so its idle timer
  never starts — host-side eviction (`sandbox-slots.ts`) stays the
  authority on session-aware idleness (Modal can't see sessions).
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
4. **Type-level tests**: After changing public API types (`parseManifest`,
   `Manifest`, etc.), run `pnpm vitest run --project aai-types`
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

Each agent session runs in its own **Modal Sandbox** — a remote, isolated
container on Modal's infrastructure (`modal-sandbox.ts`). The guest runs a
Deno process executing the bundled agent code (`guest/deno-harness.ts`).
Host↔guest communication is NDJSON over the exec'd process's stdio streams
(Modal's command router).

Key properties:

- **Remote isolation**: each sandbox is its own container on Modal — no
  shared kernel surface with the platform host, no shared state between
  agents.
- **No guest network**: sandboxes are created with `blockNetwork: true`;
  all external calls proxy through host-side RPC.
- **Minimal filesystem**: the guest sees the Deno image plus the harness
  file written into it — never the host filesystem.
- **Resource limits**: Modal per-sandbox memory/CPU caps
  (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) and a bounded lifetime
  (`SANDBOX_TIMEOUT_SECS`, default 4h).
- **Deno guest**: the agent's ESM bundle is loaded directly by Deno.
  Deno's permission model provides defense-in-depth: the harness runs with
  `--no-prompt` and **no** `--allow-*` flags at all, in dev and prod alike.

### Warm sandbox pool

The server can pre-spawn a pool of "warm" Deno harnesses (process running,
NDJSON wired, no bundle loaded) so first-session cold starts skip the
slow `Modal sandbox create → Deno JIT init` path. On acquire, the
harness is finalized for the requesting agent by registering db/fetch
handlers and sending `bundle/load` — a single round-trip.

- **Enable**: set `SANDBOX_POOL_SIZE` to a positive integer (max 16).
  Disabled when unset.
- **Files**: `sandbox-pool.ts` (pool), `sandbox-vm.ts:spawnWarmHarness` /
  `modal-sandbox.ts:spawnModalWarm` (spawn), `configureSandbox` (per-agent
  finalization).
- **Security**: the pool spawns harnesses with the same Modal sandbox
  parameters as on-demand sandboxes. Bundle code and agent env vars are
  injected per-acquire — no agent secrets enter a warm sandbox.
- **Failure mode**: if the pool is empty or returns a dead harness,
  `createSandboxVm` falls back to a fresh spawn (the pre-pool path).

### Platform sandbox (aai-server)

Agent code runs in **per-agent Modal Sandboxes**. Key files:
`packages/aai-server/sandbox.ts`, `sandbox-vm.ts`, `modal-sandbox.ts`,
`guest/deno-harness.ts`, `ndjson-transport.ts`.

**Isolation layers:**

- **Filesystem**: the Deno image plus the harness file. No host
  filesystem access.
- **Network**: `blockNetwork: true` — all external calls proxy through host.
- **Memory/CPU**: Modal per-sandbox limits; separate container per sandbox.
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
- **App database**: per-app Postgres role/schema credentials are
  platform-provisioned and held in Supabase Vault — never in the agent's
  env, so tenant code can't read them.
- **Agent secrets**: stored in Supabase Vault (`agent-env:<slug>`), not
  encrypted blobs — the old master-key envelope encryption
  (`KV_SCOPE_SECRET`) is gone.
- **Credential resolution reads the agent env only — never `process.env`.**
  The platform host process holds its own credentials under exactly the names a
  tenant descriptor resolves (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for
  Supabase storage, `PINECONE_API_KEY`), so a fallback let an agent that
  declared `pinecone` with no credential of its own borrow the
  platform's, aimed at an endpoint/index it chose.

  There are **two** such helpers and both must stay sealed — closing only one
  leaves the leak open, since between them they cover every provider:
  - `resolveApiKey` (`providers/resolve.ts`) — descriptor-declared env keys.
  - `requireApiKey` (`providers/_utils.ts`) — every STT/TTS opener, every LLM
    (via `resolve.ts`'s `requireKey`), and Pinecone.

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
- Each sandbox communicates via isolated NDJSON over stdio.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

**`run_code` built-in tool (aai/builtin-tools.ts):**

- Executes **only inside the guest sandbox** (Modal/Deno): it is listed in
  `SANDBOX_ONLY_BUILTINS`, so the platform runtime delegates it over RPC to
  `deno-harness`, which runs it there. The old host-side `node:vm` execution
  was removed — `node:vm` is not a security boundary.
- The host-side `execute` is a guard for the self-hosted path (`aai dev`),
  which has no sandbox — it refuses rather than evaluating
  attacker-influenceable code in the host process.
- No network, no filesystem access, no child processes, no env vars.
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
  all host-side egress at once — `send_message`, `web_search`, `visit_webpage`,
  `get_page_design`, `fetch_json`, and the platform's guest-fetch proxy. Both
  defaults (`safeFetch` and `performToolFetch`) therefore route through
  `pinnedFetch`, undici's own `fetch`; never reintroduce `globalThis.fetch`
  there. Guarded by `ssrf-dispatcher.test.ts` — the rest of the SSRF suite
  injects a fake fetch and never builds a real dispatcher, which is why this
  shipped unnoticed.

  **A correct default is not enough — every call site has to leave it alone.**
  `performToolFetch` defaulted to `pinnedFetch` while both of its real callers
  passed `globalThis.fetch` explicitly and undid it: `tool-egress.ts` forwarded
  the pre-guard global (to avoid re-entering its own wrapper, which
  `pinnedFetch` never does anyway, being a different function object) and
  `sandbox-fetch.ts` re-declared the default as `opts.fetchFn ?? globalThis.fetch`.
  So *all* tool-code `fetch` failed — in `aai dev` and on the platform alike —
  with a bare `TypeError: fetch failed` and the real reason only in `.cause`.
  An agent declaring `allowedHosts` correctly still could not reach them, which
  reads as an egress-policy bug and is not one.

  Two rules follow. **Neither caller may name a fetch implementation**: leave
  `fetchFn` unset (it exists for tests) so the pinned default applies, and never
  re-spell a default a caller-side `??` — that is the same drift
  `guest-fetch-policy.ts`'s module comment forbids for limits. And the guard
  test has to cover the *call sites*, not just `pinnedFetch` in isolation:
  `tool-egress.test.ts` asserts which fetch reaches `ssrfSafeFetch`, and
  `sandbox-fetch.test.ts` asserts the handler's response did not come from a
  stubbed global. Note the dispatcher only attaches for *hostname* URLs, and
  SSRF rejects loopback, so a `skipSsrf` + `127.0.0.1` spec cannot exercise
  the pairing — which is precisely how both call sites stayed green.

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

- API key hashes compared with `timingSafeEqual` (constant-time).
  Keys are SHA-256 hashed and cached; slug ownership is verified
  against stored credential hashes.
- Stored credentials (agent env vars / secrets) are AES-256-GCM
  encrypted with HKDF-derived keys.
- Deploys check slug ownership whether the slug was requested or generated —
  a `humanId()` collision returns 409 rather than overwriting an existing
  agent and appending the caller's credential hash to it.

### Host mode on deployed agents (`aai-server/ws-host-mode.ts`)

A deployed agent's `WS /:slug/websocket` accepts `?host=1`, the same override
channel the dev server offers: the caller supplies `systemPrompt`, `greeting`,
and relayed tool schemas, and the session runs on the *deployed agent's*
credentials and provider pipeline.

The gate differs from the dev server's on purpose. `aai dev` is single-user
and loopback-bound, so `AAI_ALLOW_HOST` is an adequate control. The platform
is multi-tenant and an agent's WebSocket is deliberately **unauthenticated** —
anyone with the URL can talk to it. Allowing prompt/tool overrides on that
footing would make every deployed agent an open LLM proxy billed to its owner.
So `?host=1` requires `Authorization: Bearer <api key>` on the upgrade,
verified against slug ownership (the check `/:slug/secret` and `/:slug/storage`
already use). `startHostSession` gained an `allowHost` option so the platform
can gate on ownership instead of the env flag, which would be all-or-nothing
across tenants.

Details worth keeping:

- **Header, not a query param.** A URL leaks through proxy logs, history, and
  `Referer`, and this token is the caller's whole platform credential.
  Browsers can't set WebSocket headers, which is intended — host mode is for
  programmatic clients.
- **A refusal answers the handshake** (401/403 + reason) rather than dropping
  the socket; a bare RST is indistinguishable from a network fault.
- **Unknown slug and forbidden slug return the same thing**, so a non-owner
  gets no existence oracle.
- **Runs in the server process, not the guest sandbox.** Host mode replaces
  the agent's tools with ones relayed to the caller, so there is no tenant
  code to isolate. It builds its base agent with the same `toRuntimeAgent`
  the sandbox path uses, which keeps the provider descriptors on the agent
  object — otherwise a pipeline agent would silently fall back to S2S when
  driven over `?host=1`.
- Plain connections are untouched and stay unauthenticated.

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
The API key itself is stored 0600 in the global `config.json`
(`AAI_CONFIG_DIR` overrides the config dir location), and `ensureApiKey`
refuses to prompt without a TTY — the hidden prompt would otherwise consume
piped stdin as keystrokes.

Note also that `aai build` / `aai deploy` evaluate the repository's bundled
`agent.ts` in the host process (`evalWorkerBundle`) — running either against
an untrusted clone executes that repo's code locally. The studio path avoids
this by design (guest-side `bundle/load`); the CLI currently accepts it as the
price of config extraction, so deploy resolves the server-trust check and API
key BEFORE bundling, and a bare `aai` in a project asks for confirmation on a
TTY before implicitly deploying.

### Testing security boundaries

- `modal-sandbox.test.ts` — Modal spawn flow against an injected fake
  context: blockNetwork, harness delivery, exec permissions, teardown on
  failure. (Isolation itself — network, filesystem, memory — is enforced by
  Modal's sandbox boundary, not host code.)
- `builtin-tools.test.ts` — `run_code` sandbox security boundaries
  (network, filesystem, process, env, constructor chain bypass,
  cross-invocation isolation).
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
actually execute** (put it at the bundle's top level so `bundle/load` triggers
it — no LLM needed), the thresholds must be tied to constants the server
really reads, and it belongs outside the merge gate. Note also that a
successful WebSocket upgrade proves nothing about the sandbox:
`orchestrator.ts` completes `handleUpgrade` before `acquireSlotSession` and
session start, so `opened.length === 1` can hold while every sandbox fails.

### Known limitations

- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`)
  and `aai-ui` (`.`). Subpath exports (e.g. `./vector`,
  `./protocol`) are not covered by type tests.
