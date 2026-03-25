# CLAUDE.md

## Overview

AAI is a voice agent development kit. Users define agents via `defineAgent()`
in `agent.ts`. The SDK produces a self-hostable server (`createServer()`) that
can run anywhere, or agents can be deployed to the managed platform.

Two modes:

- **Self-hosted**: `agent.ts` → `createServer()` → runs on Node/Deno/Docker
- **Platform**: `agent.ts` → CLI bundle → deploy to managed server

## Commands

```sh
pnpm install             # Install dependencies
pnpm test                # Run tests (via Turborepo)
pnpm lint                # Run Biome linter (via Turborepo)
pnpm typecheck           # Type check all packages
pnpm check               # Typecheck + lint + tests
```

Run a single package's tests: `pnpm --filter @alexkroman1/aai test`
Run a single test file: `pnpm vitest run packages/aai/types_test.ts`
Run all tests from root: `npx vitest run --config vitest.config.ts`

## Architecture

Three workspace packages under `packages/`:

- `packages/aai/` (`@alexkroman1/aai`) — Agent SDK: `defineAgent`,
  `createServer`, types, protocol, S2S orchestration, session management,
  KV, vector store
- `packages/aai-ui/` (`@alexkroman1/aai-ui`) — Browser client library
  (Preact): session, audio, components
- `packages/aai-cli/` (`@alexkroman1/aai-cli`) — The `aai` CLI: dev,
  build, deploy, start, new. Contains `templates/` for agent scaffolding.

Dependency flow: `aai-cli` and `aai-ui` depend on `aai` (via
`workspace:*`) but never on each other.

### Package exports

#### `@alexkroman1/aai` (SDK)

Public:

- `.` — `defineAgent` + re-exported types
- `./server` — `createServer` for self-hosting
- `./types` — all type definitions
- `./kv` — KV store interface + in-memory implementation
- `./vector` — vector store interface + in-memory implementation
- `./testing` — `MockWebSocket`, `installMockWebSocket`

Internal:

- `./runtime` — `Logger`, `Metrics`, `S2SConfig` interfaces
- `./s2s` — AssemblyAI S2S WebSocket client
- `./session` — S2S session management
- `./ws-handler` — WebSocket lifecycle handler
- `./direct-executor` — in-process tool execution (self-hosted)
- `./protocol` — wire-format types, Zod schemas, constants
- `./internal-types` — `AgentConfig`, `ToolSchema`, `DeployBody`
- `./worker-entry` — tool execution logic
- `./builtin-tools` — built-in tool definitions + memory tools
- `./utils` — shared utility functions

#### `@alexkroman1/aai-ui` (UI)

- `.` — default Preact UI component
- `./session` — session management
- `./components` — individual UI components
- `./styles.css` — default styles

#### `@alexkroman1/aai-cli` (CLI)

- Binary: `aai` — arg parsing, subcommands: init, dev, build,
  deploy, start, secret, rag

### Key Files

#### packages/aai-cli/

- `cli.ts` — arg parsing, subcommands
- `init.tsx` / `dev.tsx` / `deploy.tsx` / `start.tsx` — subcommand UI
- `_init.ts` / `_deploy.ts` / `_bundler.ts` — internal logic
- `_bundler.ts` — generates Vite config at build time, bundles
  `agent.ts`/`client.tsx` into `worker.js`/`index.html`
- `_discover.ts` — agent discovery, auth config, project config
- `secret.tsx` / `rag.tsx` — secret management and RAG ingestion commands
- `_ink.tsx` / `_prompts.tsx` — shared Ink components and interactive prompts

#### packages/aai-ui/

- `session.ts` — WebSocket session management, audio capture/playback
- `audio.ts` — PCM encoding/decoding, AudioWorklet management
- `mod.ts` — default Preact UI component

### Data Flow

1. User speaks → browser captures PCM audio → WebSocket → server
1. Server forwards audio to AssemblyAI STT → receives transcript
1. STT fires `onTurn` → agentic loop (LLM + tools)
1. LLM response text → TTS → audio chunks → WebSocket → browser
1. Browser plays audio; user can interrupt at any time (cancels in-flight turn)

## Conventions

- **Runtime**: Node for everything
- **Frameworks**: Preact (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Testing**: Vitest. Test files are co-located: `foo.ts` → `foo_test.ts`
- **Linting**: Biome for all packages
- **Exports**: In dev mode, package.json exports point to `.ts` source
  for seamless workspace resolution. Update to compiled `.js` dist paths
  before publishing.
- **Agent API docs**: `packages/aai-cli/templates/_shared/CLAUDE.md` is the
  agent API reference installed into user projects. When modifying the agent
  API surface (`packages/aai/types.ts`), update it to match.
- **Templates**: `packages/aai-cli/templates/` contains agent scaffolding
  templates. Each template is self-contained with its own `agent.ts` and
  `client.tsx`. `_shared/` has non-code files common to all templates.
- **Updating CLAUDE.md**: When you make changes to the codebase that
  would help future agents understand the architecture, security model,
  conventions, or gotchas, update this file. Keep it concise and accurate.

## Security Architecture

### Platform Sandbox (aai-server)

Agent code runs in **secure-exec V8 isolates** with strict permission
boundaries. Key files: `packages/aai-server/src/sandbox.ts`,
`_harness-runtime.ts`, `_harness-protocol.ts`.

**Isolation layers:**

- **Filesystem**: Read-only in-memory virtual FS. No write/delete/mkdir.
- **Network**: Isolate can only reach its own per-sandbox sidecar server
  on loopback (exact host+port enforced via Zod-validated network policy).
  No external URLs, no cloud metadata, no port scanning.
- **Child processes**: All subprocess spawning disabled.
- **Env vars**: Only `SIDECAR_URL` and `AAI_ENV_*` prefixed vars are
  readable. Platform secrets (e.g. `ASSEMBLYAI_API_KEY`) stay host-side
  and never enter the isolate.
- **Memory**: 128 MB limit per isolate.
- **Timing**: `timingMitigation: "freeze"` prevents side-channel attacks.

**Credential separation:**

`SandboxOptions` has separate `apiKey` (platform, host-only) and
`agentEnv` (user secrets, forwarded to isolate) fields. Platform keys
are structurally prevented from entering sandboxes — there is no
denylist/filter; they are separate fields in the type system.

**Cross-agent isolation:**

- KV keys are prefixed `kv:{keyHash}:{slug}:{key}` — agents cannot
  access each other's data.
- Vector store uses Upstash namespace `{keyHash}:{slug}`.
- Each sandbox gets its own sidecar on an ephemeral loopback port.
  Network policy pins the isolate to that exact port.
- Sessions are per-sandbox (own `Map<string, Session>`).
- No shared mutable state between sandboxes.

**Self-hosted server (aai/server.ts):**

- HTML output uses `escapeHtml()` to prevent XSS from agent names.
- `run_code` built-in tool shadows dangerous globals (`process`,
  `require`, `globalThis`, `Function`, `eval`, `fetch`, etc.) via
  AsyncFunction parameter binding and blocks constructor chain escapes
  (`"".constructor.constructor(...)`) via regex.

**SSRF protection (aai-server/_net.ts):**

- `assertPublicUrl()` uses `BlockList` for private IP ranges.
- Handles IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`).
- Blocks `.internal`, `.local`, cloud metadata hostnames.

**Auth:**

- API key hashes compared with `timingSafeEqual` (constant-time).
- Scope tokens are HS256 JWTs with 1-hour expiry.
- Stored credentials are AES-256-GCM encrypted with HKDF-derived keys.

### Testing security boundaries

- `sandbox-integration.test.ts`: Tests network, filesystem, process,
  and env isolation end-to-end in real isolates.
  Run: `pnpm --filter @alexkroman1/aai-server test:integration`
- `builtin-tools.test.ts`: Tests run_code global shadowing and
  constructor chain blocking.
- `_net.test.ts`: Tests SSRF bypass prevention (IPv4-mapped IPv6,
  cloud metadata, .internal domains).
- `scope-token.test.ts`: Tests token expiration enforcement.

### Known limitations

- **E2E tests**: Playwright/Chromium may not be installed in all
  environments. The `aai-cli` e2e test (`test:e2e`) may fail locally.
  CI handles this. Use `--no-verify` on push if blocked by pre-push hook.
- **API Extractor**: Covers main entry points of `aai` and `aai-ui` only.
  Subpath exports (e.g. `./kv`, `./vector`, `./protocol`) are not covered.
