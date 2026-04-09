# CLAUDE.md

## Overview

AAI is a voice agent development kit. Users define agents as directories
containing `agent.json` + `tools/*.ts` + `hooks/*.ts`. The CLI bundles and
deploys them to the managed platform, or they can be self-hosted.

- **Platform**: `agent.json` + tools/hooks → CLI bundle → deploy to managed server
- **Self-hosted**: `defineAgent()` → `createRuntime()` → `createServer()`
  → runs on Node/Docker

## Commands

```sh
pnpm install             # Install dependencies
pnpm test                # Run all unit tests (vitest)
pnpm lint                # Run Biome linter (all packages)
pnpm typecheck           # Type-check all packages
pnpm lint:fix            # Auto-fix lint issues
pnpm check:local         # Fast pre-commit gate (parallel: build → typecheck + lint + publint + syncpack → test)
```

### Test tiers

| Tier | Command | Scope | Timeout |
| --- | --- | --- | --- |
| Unit | `pnpm test` | Fast, mocked, co-located | 5s |
| Integration | `pnpm test:integration` | Real subsystems (V8 isolates, HTTP servers) | 30s |
| E2E | `pnpm test:e2e` | Full process spawn + Playwright browser | 300s |
| Templates | `pnpm test:templates` | Template agent example tests | 5s |

### Single-package shortcuts

```sh
pnpm test:aai            # Run only aai unit tests
pnpm test:aai-ui         # Run only aai-ui unit tests
pnpm test:aai-cli        # Run only aai-cli unit tests
pnpm test:aai-server     # Run only aai-server unit tests
pnpm test:templates      # Run template agent tests
pnpm dev:aai-server      # Start aai-server in dev mode
```

### Running specific tests

```sh
pnpm vitest run --project aai              # Single package via --project
pnpm vitest run packages/aai/types.test.ts # Single file
pnpm vitest run session                    # All files matching "session"
pnpm --filter @alexkroman1/aai test        # Single package via pnpm filter
```

### Full CI check (`pnpm check`)

Runs via `scripts/check.sh` in three parallelized phases:

1. **Build** (sequential): `pnpm -r run build`
2. **Checks** (parallel): typecheck, lint, publint, attw, templates,
   knip, syncpack, markdownlint
3. **Tests** (parallel, sharded by package): vitest per-package (aai, aai-ui,
   aai-cli, aai-server, templates), integration tests, e2e tests

`pnpm check:local` uses the same script with `--local` flag, running a
subset: build → typecheck + lint + publint + syncpack (parallel) →
vitest (no coverage).

## Architecture

Five workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Agent SDK: manifest, `createServer`, types, protocol, S2S, session, KV |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (Preact): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, deploy, delete, secret |
| `packages/aai-server/` | `@alexkroman1/aai-server` | Managed platform server (private): sandbox, sidecar, auth, SSRF |
| `packages/aai-templates/` | `@alexkroman1/aai-templates` | Agent templates + scaffold (private): starter templates |

**Dependency flow:** `aai-cli`, `aai-ui`, and `aai-server` depend on `aai`
(via `workspace:*`) but never on each other.

### Package exports

#### `@alexkroman1/aai` (SDK)

**Public:**

- `.` — `parseManifest`, `Manifest`, `Kv` + re-exported types (no
  `defineAgent`/`defineTool` — those are internal to the self-hosted path)
- `./server` — `createServer`, `createAgentApp`, `createRuntime`,
  `Runtime`, `RuntimeOptions` for self-hosting
- `./types` — all type definitions
- `./kv` — KV store interface + in-memory implementation
- `./testing` — `MockWebSocket`, `installMockWebSocket`,
  `createTestHarness(agentDir)`, `TestHarness`, `TurnResult`
- `./testing/matchers` — Vitest custom matchers (`toHaveCalledTool`)

**Internal** (exported in package.json but not part of public API — do **not**
depend on these from consumer code; they may change without notice):

- `./protocol` — wire-format types, Zod schemas, constants
- `./isolate` — isolate-safe barrel: shared modules
  (types, protocol, kv, hooks, manifest, utils)
- `./host` — host barrel: host-only modules
- `./hooks` — hook definitions for lifecycle events
- `./utils` — shared utility functions

Type-level tests (`.test-d.ts`) cover only the **public** entry points
(`.`, `./types`, `./server`). Changes to internal exports do not require
type test updates.

#### `@alexkroman1/aai-ui` (UI)

- `.` — default Preact UI component + session + defineClient helpers
- `./session` — session management (no Preact dependency)
- `./styles.css` — default styles

#### `@alexkroman1/aai-cli` (CLI)

Binary: `aai` — subcommands: init, dev, test, build, deploy, delete, secret

### SDK structure

The SDK is organized into two directories:

- **`isolate/`** — shared modules with no Node.js dependencies. Contains:
  `types.ts`, `kv.ts`, `hooks.ts`, `_utils.ts`, `constants.ts`,
  `protocol.ts`, `system-prompt.ts`, `manifest.ts`,
  `_internal-types.ts`.
- **`host/`** — host-only modules that require Node.js APIs. Contains:
  `server.ts`, `runtime.ts`, `runtime-config.ts`, `tool-executor.ts`,
  `session.ts`, `session-ctx.ts`, `s2s.ts`, `ws-handler.ts`,
  `builtin-tools.ts`, `_run-code.ts`, `unstorage-kv.ts`,
  `testing.ts`, `matchers.ts`.

When adding new SDK code, place it in `isolate/` if it has no `node:`
dependencies. The guest harness (`guest/harness.ts`) runs full Node.js
inside each gVisor sandbox with all deps bundled by esbuild — no import
restrictions apply there.

### Key files

#### packages/aai-cli/

- `cli.ts` — arg parsing, subcommand dispatch
- `init.ts` / `dev.ts` / `test.ts` / `deploy.ts` / `delete.ts` /
  `secret.ts` — subcommand entry points
- `_init.ts` / `_deploy.ts` / `_delete.ts` / `_bundler.ts` — internal logic
- `_scanner.ts` — agent directory scanner: reads `agent.json`,
  `tools/*.ts`, and `hooks/*.ts`; extracts static exports; produces a
  `Manifest`
- `_dev-server.ts` — dev server for directory-based agents: scans agent dir,
  builds runtime, watches for file changes, optionally runs Vite for client HMR
- `_bundler.ts` — bundles agent directory (tools + hooks + client.tsx) into
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
- `define-client.tsx` — defineClient mount helper
- `types.ts` — UI type definitions
- `components/` — UI components (app, chat-view, controls,
  message-list, start-screen, sidebar-layout, tool-call-block, button,
  tool-icons)

#### packages/aai-server/

- `orchestrator.ts` — HTTP + WebSocket routing
- `sandbox.ts` — gVisor sandbox management
- `sandbox-vm.ts` — per-agent sandbox lifecycle (start, teardown)
- `sandbox-network.ts` — network proxying for sandbox
- `sandbox-slots.ts` — slot allocation for concurrent sessions
- `gvisor.ts` — gVisor (runsc) OCI runtime integration
- `guest/harness.ts` — guest entry point (Node.js process inside gVisor sandbox)
- `guest/harness-logic.ts` — guest agent execution logic
- `harness-runtime.ts` — file-per-tool RPC dispatcher that runs inside the isolate
- `transport-websocket.ts` — WebSocket transport layer
- `auth.ts` — authentication/authorization
- `credentials.ts` — credential derivation
- `bundle-store.ts` — agent bundle storage (S3/memory)
- `deploy.ts` / `delete.ts` — deployment lifecycle
- `secret-handler.ts` — secret management
- `kv-handler.ts` — KV store HTTP API
- `ssrf.ts` — SSRF protection, URL validation

### Data flow

1. User speaks → browser captures PCM audio → WebSocket → server
2. Server forwards audio to AssemblyAI STT → receives transcript
3. STT fires `onUserTranscript` → agentic loop (LLM + tools)
4. LLM response text → TTS → audio chunks → WebSocket → browser
5. Browser plays audio; user can interrupt at any time (cancels in-flight turn)

## Conventions

- **Runtime**: Node
- **Frameworks**: Preact (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Linting**: Biome. Auto-runs on staged files via lefthook pre-commit hook.
- **Exports**: In dev mode, package.json exports point to `.ts` source for
  seamless workspace resolution. Update to compiled `.js` dist paths before
  publishing.

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
  `aai-types`, `aai-ui-types`.
- **Package validation**: `publint` runs post-build to verify package.json
  exports resolve to real files. `attw` validates export types. Both run
  in the check pipeline.

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

**Fixed packages:** `aai`, `aai-ui`, and `aai-cli` release together (configured
in `.changeset/config.json`). You only need to list one; the others are
bumped automatically.

**Checking status:** `pnpm changeset status --since=origin/main`

### Related docs

- **Agent API docs**: `packages/aai-templates/scaffold/CLAUDE.md` is the
  agent API reference installed into user projects. When modifying the agent
  API surface (manifest schema, tool/hook conventions, KV API), update it
  to match.
- **Templates**: `packages/aai-templates/templates/` contains agent
  scaffolding templates (simple, web-researcher, etc.). Each is
  self-contained with its own `agent.json`, `tools/`, `hooks/`, and optional
  `client.tsx`. `scaffold/` has base project files (package.json, tsconfig,
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
   `Manifest`, `createServer`, etc.), run `pnpm vitest run --project aai-types`
   to verify type contracts haven't regressed. Update `.test-d.ts` files
   if the change is intentional.

## Security architecture

### gVisor sandbox isolation

Each agent session runs in its own **gVisor sandbox** (runsc OCI runtime).
The guest runs a Node.js binary executing the bundled agent code
(`guest/harness.ts`). Host↔guest communication is via vscode-jsonrpc over
stdio.

Key properties:

- **Userspace kernel**: gVisor Sentry intercepts all syscalls in systrap mode.
  No KVM required — works on Fly.io, any Linux.
- **No shared memory between agents**: separate Sentry per sandbox.
- **Minimal rootfs**: only the Node.js binary and harness are visible.
  The agent cannot see the host filesystem.
- **cgroup limits**: 64 MB memory, 32 PIDs per sandbox.
- **Full Node.js in guest**: esbuild bundles all npm deps into the harness.
  No `import type` restriction — the guest can import anything.
- **Dev mode (macOS)**: gVisor unavailable; sandbox falls back to a plain
  child process with no isolation.

`harness-runtime.ts` is a self-contained file-per-tool RPC dispatcher with
**no workspace imports**. It exports `createDispatcher(opts)` for building
a dispatch function from tool/hook handler maps, and `startDispatcher(tools,
hooks)` for the isolate entry point that wires up SecureExec bindings.

Rules for `harness-runtime.ts`:

- **No runtime imports** from workspace packages or npm deps. The file must
  be entirely self-contained with inline type definitions. Any runtime import
  will cause the isolate to fail to boot, manifesting as timeout errors in
  integration tests.
- Host-side validation (in `sandbox.ts`) is sufficient. The isolate trusts
  the host since they run in the same server process.

### Platform sandbox (aai-server)

Agent code runs in **per-agent gVisor sandboxes**. Key files:
`packages/aai-server/sandbox.ts`, `sandbox-vm.ts`, `gvisor.ts`,
`guest/harness.ts`, `guest/harness-logic.ts`.

**Isolation layers:**

- **Filesystem**: minimal rootfs with only node binary + harness. No host
  filesystem access.
- **Network**: no network device in sandbox. All external calls proxy through host.
- **Memory**: cgroup limits (64 MB per sandbox). Separate Sentry per sandbox.
- **Env vars**: only `AAI_ENV_*` prefixed vars forwarded to guest. Platform
  secrets stay host-side.

**Credential separation:**

Each agent provides its own `ASSEMBLYAI_API_KEY` via `.env` (local dev) or
`aai secret put` (production). There is no central/platform-owned key.
`SandboxOptions` has separate `apiKey` (host-only, for S2S connections) and
`agentEnv` (forwarded to guest) fields. The key is extracted from the agent's
stored env at sandbox creation time and kept host-side only.

**Cross-agent isolation:**

- KV keys prefixed `kv:{keyHash}:{slug}:{key}` — agents cannot access
  each other's data.
- Each sandbox communicates via isolated vscode-jsonrpc over stdio.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

**`run_code` built-in tool (aai/builtin-tools.ts):**

- Each invocation runs in a **fresh `node:vm` context** — isolated from
  other invocations. Note: `node:vm` is not a security sandbox; in
  platform mode, the gVisor sandbox provides the security boundary.
- No network, no filesystem access, no child processes, no env vars.
- 5-second execution timeout.
- Context is discarded after execution — no state leaks.
- Works identically in both self-hosted and platform modes.

**Self-hosted server (aai/server.ts):**

- HTML output uses `escapeHtml()` to prevent XSS from agent names.

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
  Run: `pnpm --filter @alexkroman1/aai-server test:integration`
- `builtin-tools.test.ts` — `run_code` sandbox security boundaries
  (network, filesystem, process, env, constructor chain bypass,
  cross-invocation isolation).
- `net.test.ts` / `ssrf-extended.test.ts` — SSRF bypass prevention
  (IPv4-mapped IPv6, cloud metadata, `.internal` domains).

### Known limitations

- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`,
  `./server`) and `aai-ui` (`.`). Subpath exports (e.g. `./kv`,
  `./protocol`) are not covered by type tests.
