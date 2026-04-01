# CLAUDE.md

## Overview

AAI is a voice agent development kit. Users define agents via `defineAgent()`
in `agent.ts`. The SDK produces a self-hostable server
(`createRuntime()` + `createServer()`) or agents can be deployed to
the managed platform.

- **Self-hosted**: `agent.ts` → `createRuntime()` → `createServer()` → runs on Node/Docker
- **Platform**: `agent.ts` → CLI bundle → deploy to managed server

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
| `packages/aai/` | `@alexkroman1/aai` | Agent SDK: `defineAgent`, `createServer`, types, protocol, S2S, session, KV |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (Preact): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, deploy, delete, secret |
| `packages/aai-server/` | `@alexkroman1/aai-server` | Managed platform server (private): sandbox, sidecar, auth, SSRF |
| `packages/aai-templates/` | `@alexkroman1/aai-templates` | Agent templates + scaffold (private): starter templates |

**Dependency flow:** `aai-cli`, `aai-ui`, and `aai-server` depend on `aai`
(via `workspace:*`) but never on each other.

### Package exports

#### `@alexkroman1/aai` (SDK)

**Public:**

- `.` — `defineAgent`, `defineTool` + re-exported types
- `./server` — `createServer`, `createAgentApp`, `createRuntime`,
  `Runtime`, `RuntimeOptions` for self-hosting
- `./types` — all type definitions
- `./kv` — KV store interface + in-memory implementation
- `./testing` — `MockWebSocket`, `installMockWebSocket`,
  `createTestHarness`, `TestHarness`, `TurnResult`
- `./testing/matchers` — Vitest custom matchers (`toHaveCalledTool`)

**Internal** (exported in package.json but not part of public API — do **not**
depend on these from consumer code; they may change without notice):

- `./protocol` — wire-format types, Zod schemas, constants
- `./isolate` — isolate-safe barrel: all modules safe for secure-exec V8 isolates
- `./host` — host barrel: isolate kernel + host-only modules
- `./hooks` — hook definitions for lifecycle events
- `./utils` — shared utility functions
- `./vite-plugin` — Vite integration plugin for agent bundling

Type-level tests (`.test-d.ts`) cover only the **public** entry points
(`.`, `./types`, `./server`). Changes to internal exports do not require
type test updates.

#### `@alexkroman1/aai-ui` (UI)

- `.` — default Preact UI component + session + defineClient helpers
- `./session` — session management (no Preact dependency)
- `./styles.css` — default styles

#### `@alexkroman1/aai-cli` (CLI)

Binary: `aai` — subcommands: init, dev, test, build, deploy, delete, secret

### Isolate / host boundary

The SDK is split into two compilation zones:

- **`isolate/`** — modules that run inside secure-exec V8 isolates.
  Compiled under a restricted `tsconfig.json` (`"types": []`, no
  `@types/node`). Any `node:*` import is a **type error**. Contains:
  `types.ts`, `kv.ts`, `_kv-utils.ts`, `hooks.ts`, `_utils.ts`,
  `constants.ts`, `protocol.ts`, `system-prompt.ts`, `_internal-types.ts`.
- **`host/`** — host-only modules that require Node.js APIs. Contains:
  `server.ts`, `direct-executor.ts`, `session.ts`, `s2s.ts`,
  `ws-handler.ts`, `runtime.ts`, `builtin-tools.ts`, `_run-code.ts`,
  `unstorage-kv.ts`, `vite-plugin.ts`, `testing.ts`, `matchers.ts`.

When adding new SDK code, place it in `isolate/` if it has no `node:`
dependencies. The isolate typecheck (`tsc -p isolate/tsconfig.json`)
runs as part of `pnpm typecheck` and will catch violations.

### Key files

#### packages/aai-cli/

- `cli.ts` — arg parsing, subcommand dispatch
- `init.ts` / `dev.ts` / `test.ts` / `deploy.ts` / `delete.ts` /
  `secret.ts` — subcommand entry points
- `start.ts` — production server launcher (used internally)
- `_init.ts` / `_deploy.ts` / `_delete.ts` / `_bundler.ts` — internal logic
- `_bundler.ts` — generates Vite config, bundles `agent.ts`/`client.tsx`
  into `worker.js`/`index.html`
- `_api-client.ts` — platform API client
- `_discover.ts` — agent discovery, auth config, project config
- `_server-common.ts` — shared server utilities
- `_templates.ts` — template handling
- `_ui.ts` — shared UI components
- `_prompts.ts` — interactive prompts

#### packages/aai-ui/

- `index.ts` — main exports, Preact UI component
- `session.ts` — WebSocket session management
- `audio.ts` — PCM encoding/decoding, AudioWorklet management
- `client-handler.ts` — WebSocket client handler
- `client-context.ts` — Preact context for client config
- `signals.ts` — signal state management
- `types.ts` — UI type definitions
- `components/` — UI components (app, chat-view, controls, message-bubble,
  message-list, start-screen, sidebar-layout, state-indicator,
  thinking-indicator, tool-call-block, transcript, error-banner, button,
  tool-icons)

#### packages/aai-server/

- `orchestrator.ts` — HTTP + WebSocket routing
- `sandbox.ts` — V8 isolate management
- `sandbox-harness.ts` — sandbox execution environment
- `sandbox-network.ts` — network proxying for sandbox
- `sandbox-slots.ts` — slot allocation for concurrent sessions
- `harness-runtime.ts` — code that runs inside the isolate
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
3. STT fires `onTurn` → agentic loop (LLM + tools)
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

### Related docs

- **Agent API docs**: `packages/aai-templates/scaffold/CLAUDE.md` is the
  agent API reference installed into user projects. When modifying the agent
  API surface (`packages/aai/types.ts`), update it to match.
- **Templates**: `packages/aai-templates/templates/` contains agent
  scaffolding templates (simple, web-researcher, etc.). Each is
  self-contained with its own `agent.ts` and `client.tsx`. `scaffold/` has
  base project files (package.json, tsconfig, etc.) layered underneath.

### Git hooks (lefthook)

- **pre-commit**: runs `biome check --write` on staged files and
  `syncpack lint` when package.json changes.
- **pre-push**: blocks pushes to main/master, checks for merge conflicts
  with main, and runs `pnpm check`.

### Updating CLAUDE.md

When you make changes that affect architecture, security model, conventions,
or gotchas, update this file.

## PR workflow

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
4. **Type-level tests**: After changing public API types (`defineAgent`,
   `defineTool`, `createServer`, etc.), run `pnpm vitest run --project aai-types`
   to verify type contracts haven't regressed. Update `.test-d.ts` files
   if the change is intentional.

## Security architecture

### Secure-exec isolate constraint

`harness-runtime.ts` runs inside a secure-exec V8 isolate with **no access
to `node_modules`**. Only `node:*` built-ins and the virtual filesystem
files (harness JS + agent bundle) are available.

Rules for `harness-runtime.ts`:

- **Only use `import type`** from workspace packages and npm deps — never
  runtime imports. Any runtime import (e.g. Zod schemas) will cause the
  isolate to fail to boot, manifesting as timeout errors in integration tests.
- The harness entry in `tsdown.config.ts` must **not** use `noExternal` —
  bundling workspace packages would still leave transitive npm deps (like
  `zod`) external and unresolvable in the isolate.
- Host-side validation (in `sandbox.ts`) is sufficient. The isolate trusts
  the host since they run in the same server process.
- `sandbox-harness.ts` manages the sandbox execution environment on the
  host side.

### Platform sandbox (aai-server)

Agent code runs in **secure-exec V8 isolates** with strict permission
boundaries. Key files: `packages/aai-server/sandbox.ts`,
`sandbox-harness.ts`, `harness-runtime.ts`.

**Isolation layers:**

- **Filesystem**: Read-only in-memory virtual FS. No write/delete/mkdir.
- **Network**: Isolate can only reach its own per-sandbox sidecar on
  loopback (exact host+port enforced via Zod-validated network policy).
  No external URLs, no cloud metadata, no port scanning.
- **Child processes**: All subprocess spawning disabled.
- **Env vars**: Only `SIDECAR_URL` and `AAI_ENV_*` prefixed vars are
  readable. Platform secrets (e.g. `ASSEMBLYAI_API_KEY`) stay host-side.
- **Memory**: 128 MB limit per isolate.
- **Timing**: `timingMitigation: "freeze"` prevents side-channel attacks.

**Credential separation:**

`SandboxOptions` has separate `apiKey` (platform, host-only) and `agentEnv`
(user secrets, forwarded to isolate) fields. Platform keys are structurally
prevented from entering sandboxes — separate fields in the type system, not
a denylist.

**Cross-agent isolation:**

- KV keys prefixed `kv:{keyHash}:{slug}:{key}` — agents cannot access
  each other's data.
- Each sandbox gets its own sidecar on an ephemeral loopback port.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

**`run_code` built-in tool (aai/builtin-tools.ts):**

- Each invocation runs in a **fresh `node:vm` context** — isolated from
  the host process and from other invocations.
- No network, no filesystem access, no child processes, no env vars.
- 5-second execution timeout.
- Context is discarded after execution — no state leaks.
- Works identically in both self-hosted and platform modes.

**Self-hosted server (aai/server.ts):**

- HTML output uses `escapeHtml()` to prevent XSS from agent names.

**SSRF protection (aai-server/ssrf.ts):**

- `assertPublicUrl()` uses `BlockList` for private IP ranges.
- Handles IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`).
- Blocks `.internal`, `.local`, cloud metadata hostnames.

**Auth:**

- API key hashes compared with `timingSafeEqual` (constant-time).
- Scope tokens are HS256 JWTs with 1-hour expiry.
- Stored credentials are AES-256-GCM encrypted with HKDF-derived keys.

### Testing security boundaries

- `sandbox-integration.test.ts` — network, filesystem, process, env
  isolation e2e. Run: `pnpm --filter @alexkroman1/aai-server test:integration`
- `builtin-tools.test.ts` — `run_code` sandbox security boundaries.
- `run-code-sandbox.test.ts` — comprehensive tests for run_code
  `node:vm` sandbox (network, filesystem, process, env, constructor
  chain bypass, cross-invocation isolation).
- `pentest.test.ts` — penetration tests verifying sandbox prevents
  previously-exploitable constructor chain bypasses.
- `net.test.ts` / `ssrf-extended.test.ts` — SSRF bypass prevention
  (IPv4-mapped IPv6, cloud metadata, `.internal` domains).
- `security-boundary.test.ts` / `trust-boundary-validation.test.ts` —
  security boundary enforcement.

### Known limitations

- **E2E tests**: Playwright/Chromium may not be installed in all environments.
  The `aai-cli` e2e test (`test:e2e`) may fail locally. CI handles this.
- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`,
  `./server`) and `aai-ui` (`./session`). Subpath exports (e.g. `./kv`,
  `./protocol`) are not covered by type tests.
