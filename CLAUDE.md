# CLAUDE.md

## Overview

AAI is a voice agent development kit. Users define agents via `defineAgent()`
in `agent.ts`. The SDK produces a self-hostable server (`createServer()`) or
agents can be deployed to the managed platform.

- **Self-hosted**: `agent.ts` → `createServer()` → runs on Node/Docker
- **Platform**: `agent.ts` → CLI bundle → deploy to managed server

## Shared Plans

Active planning docs live in `.claude/plans/`. **Check these before starting
work on related areas.** Update plan status and check off tasks as you
complete them. Copy `TEMPLATE.md` when creating a new plan.

**When to create a plan:**

- Before starting any multi-step feature or refactor, create a plan first.
- When you encounter friction during development (confusing APIs, missing
  docs, unclear ownership, flaky tests, slow builds, non-obvious workarounds),
  create a plan describing the friction and a proposed fix. Tag its status
  as `draft` so others can review.
- When you discover work that's out of scope for your current task but
  should be done, capture it as a plan rather than ignoring it.

Plans are cheap. When in doubt, write one.

## Commands

```sh
pnpm install             # Install dependencies
pnpm test                # Run all tests (vitest)
pnpm lint                # Run Biome linter (all packages)
pnpm typecheck           # Type-check all packages
pnpm lint:fix            # Auto-fix lint issues
pnpm check:local         # Fast pre-commit gate (typecheck + lint + syncpack + test)
```

**Running specific tests:**

```sh
pnpm --filter @alexkroman1/aai test          # Single package
pnpm vitest run packages/aai/types_test.ts    # Single file
npx vitest run --config vitest.config.ts      # All from root
```

**Full CI check** (`pnpm check`):

Runs everything in sequence: `pnpm -r run build` → `typecheck` → `lint` →
`api-extractor` (aai, aai-ui) → `attw --pack` (aai, aai-ui) → template
type-check → `knip` → `syncpack lint` → `markdownlint-cli2` → aai-server
integration tests → aai-cli e2e tests → `vitest --coverage`.

## Architecture

Four workspace packages under `packages/`:

| Package | npm name | Purpose |
| ------- | -------- | ------- |
| `packages/aai/` | `@alexkroman1/aai` | Agent SDK: `defineAgent`, `createServer`, types, protocol, S2S orchestration, session, KV, vector store |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (Preact): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, deploy, start, secret, rag, link |
| `packages/aai-server/` | `@alexkroman1/aai-server` | Managed platform server (private): sandbox, sidecar, auth, SSRF protection |

**Dependency flow:** `aai-cli`, `aai-ui`, and `aai-server` depend on `aai`
(via `workspace:*`) but never on each other.

### Package Exports

#### `@alexkroman1/aai` (SDK)

Public:

- `.` — `defineAgent`, `defineTool` + re-exported types
- `./server` — `createServer` for self-hosting
- `./types` — all type definitions
- `./kv` — KV store interface + in-memory implementation
- `./vector` — vector store interface + in-memory implementation
- `./testing` — `MockWebSocket`, `installMockWebSocket`,
  `createTestHarness`, `TestHarness`, `TurnResult`
- `./testing/matchers` — Vitest custom matchers (`toHaveCalledTool`)

Internal (exported in package.json but not part of public API):

- `./runtime` — `Logger`, `LogContext`, `S2SConfig`, `consoleLogger`,
  `DEFAULT_S2S_CONFIG`
- `./s2s` — AssemblyAI S2S WebSocket client
- `./session` — S2S session management
- `./ws-handler` — WebSocket lifecycle handler
- `./protocol` — wire-format types, Zod schemas, constants
- `./internal-types` — `AgentConfig`, `ToolSchema`, `DeployBody`
- `./worker-entry` — tool execution logic
- `./telemetry` — OpenTelemetry tracer, meter, pre-built metrics, `withSpan` helper
- `./utils` — shared utility functions
- `./ssrf` — SSRF protection (`assertPublicUrl`, `isPrivateIp`, `ssrfSafeFetch`)
- `./middleware-core` — pure middleware runner functions (zero runtime deps,
  isolate-safe; bundled into the harness runtime)

Non-exported internal files (used within the package only):

- `builtin-tools.ts` — built-in tool definitions + memory tools
- `direct-executor.ts` — in-process tool execution (self-hosted)
- `middleware.ts` — middleware re-exports from middleware-core + `HookInvoker`

#### `@alexkroman1/aai-ui` (UI)

- `.` — default Preact UI component + session + mount helpers
- `./session` — session management (no Preact dependency)
- `./styles.css` — default styles

#### `@alexkroman1/aai-cli` (CLI)

Binary: `aai` — subcommands: init, dev, test, build, deploy, start,
secret, rag, link, unlink

### Key Files

#### packages/aai-cli/

- `cli.ts` — arg parsing, subcommand dispatch
- `init.ts` / `dev.ts` / `deploy.ts` / `start.ts` — subcommand entry points
- `_init.ts` / `_deploy.ts` / `_bundler.ts` / `_build.ts` — internal logic
- `_bundler.ts` — generates Vite config, bundles `agent.ts`/`client.tsx`
  into `worker.js`/`index.html`
- `_discover.ts` — agent discovery, auth config, project config
- `secret.ts` / `rag.ts` — secret management and RAG ingestion
- `_ui.ts` — shared Ink UI components
- `_prompts.ts` — interactive prompts
- `_link.ts` — workspace package linking (dev only)

#### packages/aai-ui/

- `session.ts` — WebSocket session management, audio capture/playback
- `audio.ts` — PCM encoding/decoding, AudioWorklet management
- `index.ts` — default Preact UI component

#### packages/aai-server/src/

- `sandbox.ts` — secure-exec V8 isolate management
- `_harness-runtime.ts` — code that runs inside the isolate
- `_harness-protocol.ts` — shared types between host and isolate
- `_net.ts` — SSRF protection, URL validation

### Data Flow

1. User speaks → browser captures PCM audio → WebSocket → server
2. Server forwards audio to AssemblyAI STT → receives transcript
3. STT fires `onTurn` → agentic loop (LLM + tools)
4. LLM response text → TTS → audio chunks → WebSocket → browser
5. Browser plays audio; user can interrupt at any time (cancels in-flight turn)

## Conventions

- **Runtime**: Node
- **Frameworks**: Preact (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Testing**: Vitest. Test files co-located: `foo.ts` → `foo_test.ts`
- **Linting**: Biome. Auto-runs on staged files via lefthook pre-commit hook.
- **Exports**: In dev mode, package.json exports point to `.ts` source for
  seamless workspace resolution. Update to compiled `.js` dist paths before
  publishing.
- **Agent API docs**: `packages/aai-cli/templates/_shared/CLAUDE.md` is the
  agent API reference installed into user projects. When modifying the agent
  API surface (`packages/aai/types.ts`), update it to match.
- **Templates**: `packages/aai-cli/templates/` contains 18 agent scaffolding
  templates (simple, memory-agent, web-researcher, etc.). Each is
  self-contained with its own `agent.ts` and `client.tsx`. `_shared/` has
  non-code files common to all templates.
- **Git hooks** (lefthook): pre-commit runs `biome check --write` on staged
  files and `syncpack lint` when package.json changes; pre-push blocks pushes
  to main/master and runs `pnpm check`.
- **Updating CLAUDE.md**: When you make changes that affect architecture,
  security model, conventions, or gotchas, update this file.

## PR Workflow (reducing fix-up commits)

Run `pnpm check:local` **before your first commit** on a PR branch. This
catches the most common issues that historically required follow-up commits:

1. **Syncpack version drift**: When bumping a dependency, also update
   `packages/aai-cli/templates/_shared/package.json` if it has the same dep.
   `pnpm check:syncpack` catches this.
2. **Test assertion mismatches**: After changing output formats or error
   messages, run `pnpm test` and update affected assertions.
3. **Lint in related files**: Pre-commit only lints staged files. Run
   `pnpm lint` to catch lint issues in files affected by your change.
4. **API extractor reports**: After changing public API exports, run
   `pnpm -r run build && pnpm -r run --if-present check:api` and commit
   updated `.api.md` reports.

## Security Architecture

### Secure-exec Isolate Constraint

`_harness-runtime.ts` runs inside a secure-exec V8 isolate with **no access
to `node_modules`**. Only `node:*` built-ins and the virtual filesystem
files (harness JS + agent bundle) are available.

Rules for `_harness-runtime.ts`:

- **Only use `import type`** from workspace packages and npm deps — never
  runtime imports. Any runtime import (e.g. Zod schemas) will cause the
  isolate to fail to boot, manifesting as timeout errors in integration tests.
- The harness entry in `tsdown.config.ts` must **not** use `noExternal` —
  bundling workspace packages would still leave transitive npm deps (like
  `zod`) external and unresolvable in the isolate.
- Host-side validation (in `sandbox.ts`) is sufficient. The isolate trusts
  the host since they run in the same server process.
- `_harness-protocol.ts` is dual-purpose: type-checked at compile time for
  both host and isolate, but only the host side can use its runtime Zod schemas.

### Platform Sandbox (aai-server)

Agent code runs in **secure-exec V8 isolates** with strict permission
boundaries. Key files: `packages/aai-server/src/sandbox.ts`,
`_harness-runtime.ts`, `_harness-protocol.ts`.

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
- Vector store uses Upstash namespace `{keyHash}:{slug}`.
- Each sandbox gets its own sidecar on an ephemeral loopback port.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

**`run_code` built-in tool (aai/builtin-tools.ts):**

- Each invocation runs in a **fresh secure-exec V8 isolate** — fully
  isolated from the host process and from other invocations.
- No network, no filesystem writes, no child processes, no env vars.
- 32 MB memory limit, 5-second execution timeout.
- Isolate is disposed immediately after execution — no state leaks.
- Works identically in both self-hosted and platform modes.

**Self-hosted server (aai/server.ts):**

- HTML output uses `escapeHtml()` to prevent XSS from agent names.

**SSRF protection (aai-server/_net.ts):**

- `assertPublicUrl()` uses `BlockList` for private IP ranges.
- Handles IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`).
- Blocks `.internal`, `.local`, cloud metadata hostnames.

**Auth:**

- API key hashes compared with `timingSafeEqual` (constant-time).
- Scope tokens are HS256 JWTs with 1-hour expiry.
- Stored credentials are AES-256-GCM encrypted with HKDF-derived keys.

### Testing Security Boundaries

- `sandbox-integration.test.ts` — network, filesystem, process, env
  isolation e2e. Run: `pnpm --filter @alexkroman1/aai-server test:integration`
- `builtin-tools.test.ts` — `run_code` isolate security boundaries.
- `run-code-isolate.test.ts` — comprehensive integration tests for
  run_code V8 isolate (network, filesystem, process, env, constructor
  chain bypass, cross-invocation isolation).
- `pentest.test.ts` — penetration tests verifying isolate prevents
  previously-exploitable constructor chain bypasses.
- `_net.test.ts` — SSRF bypass prevention (IPv4-mapped IPv6, cloud metadata,
  `.internal` domains).
- `scope-token.test.ts` — token expiration enforcement.

### Observability: OpenTelemetry

Unified traces + metrics + logs via OpenTelemetry, replacing the former
prom-client setup.

**SDK layer (`packages/aai/telemetry.ts`):**

Uses `@opentelemetry/api` only — consumers bring their own SDK and exporters.
When no SDK is configured, the API returns no-op instances (zero overhead).

Pre-built metrics (`aai.*`):

- `aai.session.count` / `aai.session.active` — session lifecycle
- `aai.turn.count` / `aai.turn.bargein.count` — user turns
- `aai.tool.call.count` / `aai.tool.call.duration` — tool execution
- `aai.tool.call.error.count` — tool errors
- `aai.turn.steps` — agentic loop steps (tool calls) per completed turn
- `aai.s2s.connection.duration` / `aai.s2s.error.count` — S2S health

Trace spans:

- `ws.session` — WebSocket session lifecycle (ws-handler.ts)
- `s2s.connection` — S2S WebSocket connection (s2s.ts)
- `tool.call` — tool call with name, call_id, agent, session ID

**Platform layer (`packages/aai-server/src/metrics.ts`):**

Configures `MeterProvider` with `PrometheusExporter` and registers it as the
global meter provider. SDK-level meters automatically flow through.
`GET /:slug/metrics` endpoint still serves Prometheus text format, filtered
by agent label.

**Instrumenting a self-hosted server:**

Install `@opentelemetry/sdk-node` and configure before importing AAI:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
new NodeSDK({ /* exporters */ }).start();
// then import and use createServer()
```

### Known Limitations

- **E2E tests**: Playwright/Chromium may not be installed in all environments.
  The `aai-cli` e2e test (`test:e2e`) may fail locally. CI handles this.
- **API Extractor**: Covers main entry points of `aai` and `aai-ui` only.
  Subpath exports (e.g. `./kv`, `./vector`, `./protocol`) are not covered.
