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
pnpm test                # Run Vitest tests
pnpm lint                # Run Biome linter
pnpm check               # Lint + tests
```

Run a single test file: `pnpm vitest run sdk/types_test.ts`

## Architecture

Single npm package `aai` with three source directories:

- `sdk/` — Agent SDK: `defineAgent`, `createServer`, types, protocol,
  S2S orchestration, session management, KV, vector store
- `cli/` — The `aai` CLI: dev, build, deploy, start, new
- `ui/` — Browser client library (Preact): session, audio, components
- `templates/` — Agent scaffolding templates

Dependency flow: `cli/` and `ui/` import from `sdk/` but never from each other.

### Subpath exports

Public API:

- `aai` — `defineAgent` + re-exported types
- `aai/server` — `createServer` for self-hosting
- `aai/types` — all type definitions
- `aai/kv` — KV store interface + in-memory implementation
- `aai/vector` — vector store interface + in-memory implementation
- `aai/testing` — `MockWebSocket`, `installMockWebSocket`
- `aai/ui` — default Preact UI component
- `aai/ui/session` — session management
- `aai/ui/components` — individual UI components

Internal:

- `aai/runtime` — `Logger`, `Metrics`, `S2SConfig` interfaces
- `aai/s2s` — AssemblyAI S2S WebSocket client
- `aai/session` — S2S session management
- `aai/ws-handler` — WebSocket lifecycle handler
- `aai/direct-executor` — in-process tool execution (self-hosted)
- `aai/protocol` — wire-format types, Zod schemas, constants
- `aai/internal-types` — `AgentConfig`, `ToolSchema`, `DeployBody`
- `aai/worker-entry` — tool execution logic
- `aai/worker-shim` — capnweb RPC wiring for Deno Workers
- `aai/builtin-tools` — built-in tool definitions + memory tools
- `aai/capnweb` — MessagePort RPC + WebSocket bridge

### Key Files

#### cli/

- `cli.ts` — arg parsing, subcommands: new, dev, build, deploy, start
- `new.ts` / `deploy.ts` / `dev.ts` / `start.ts` — subcommand definitions
- `_new.ts` / `_deploy.ts` / `_dev.ts` / `_start.ts` — internal logic
- `_bundler.ts` — generates Vite config at build time, bundles
  `agent.ts`/`client.tsx` into `worker.js`/`index.html`
- `_discover.ts` — agent discovery, auth config, project config
- `_static_config.ts` — AST-based config extraction (ts-morph)

#### ui/

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

- **Runtime**: Node for everything (sdk/ui/cli)
- **Frameworks**: Preact (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Testing**: Vitest. Test files are co-located: `foo.ts` → `foo_test.ts`
- **Linting**: Biome for sdk/, ui/, cli/
- **Agent API docs**: `templates/_shared/CLAUDE.md` is the agent API reference
  installed into user projects. When modifying the agent API surface
  (`sdk/types.ts`), update it to match.
- **Templates**: `templates/` contains agent scaffolding templates. Each
  template is self-contained with its own `agent.ts` and `client.tsx`.
  `templates/_shared/` has non-code files common to all templates.
