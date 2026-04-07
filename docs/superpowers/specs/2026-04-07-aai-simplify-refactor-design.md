# Simplify and refactor packages/aai/

**Date:** 2026-04-07
**Scope:** `packages/aai/host/` and `packages/aai/isolate/` — file splits, renames, and re-export cleanup

## Problem

`direct-executor.ts` (384 lines) mixes tool execution with runtime creation. `session.ts` (510 lines) mixes context construction with event handling. `runtime.ts` vs `direct-executor.ts` naming is confusing — the former holds config types while the latter holds the actual runtime factory. Transitive re-exports in `session.ts` obscure the real dependency graph.

## Changes

### 1. Extract `host/tool-executor.ts` from `direct-executor.ts`

**Moves to `tool-executor.ts`:**
- `yieldTick()` helper
- `ExecuteToolCallOptions` type
- `buildToolContext()` function
- `executeToolCall()` function
- `export type { ExecuteTool }` re-export from `_internal-types.ts`

**Stays in `direct-executor.ts` (later renamed to `runtime.ts`):**
- `createRuntime()`, `RuntimeOptions`, `Runtime`, `AgentRuntime`, `SessionStartOptions`, `createLocalKv()`
- Imports `executeToolCall` from `./tool-executor.ts`

### 2. Extract `host/session-ctx.ts` from `session.ts`

**Moves to `session-ctx.ts`:**
- `PendingTool` type
- `ReplyState` type
- `SessionDeps` type
- `S2sSessionCtx` type
- `buildCtx()` function

**Stays in `session.ts`:**
- `Session` type, `S2sSessionOptions` type, `_internals`
- `createIdleTimer()`, all event handlers, `setupListeners()`, `createS2sSession()`
- Imports `buildCtx`, `S2sSessionCtx` from `./session-ctx.ts`

### 3. Rename `runtime.ts` → `runtime-config.ts`

Contents unchanged: `Logger`, `LogContext`, `consoleLogger`, `jsonLogger`, `S2SConfig`, `DEFAULT_S2S_CONFIG`.

All internal importers update: `session.ts`, `s2s.ts`, `ws-handler.ts`, `server.ts`, `session-ctx.ts`, the new `runtime.ts`.

### 4. Rename `direct-executor.ts` → `runtime.ts`

After extracting `tool-executor.ts`, this file is purely the runtime factory. The rename makes the naming match the responsibility.

`server.ts` and `host/index.ts` update their import paths.

### 5. Remove transitive re-exports from `session.ts`

Delete these lines from `session.ts`:
```ts
export type { AgentHookMap, AgentHooks } from "../isolate/hooks.ts";
export { callResolveTurnConfig, createAgentHooks } from "../isolate/hooks.ts";
export { buildSystemPrompt } from "../isolate/system-prompt.ts";
```

These are redundant — `host/index.ts` already re-exports everything from `isolate/index.ts` which includes hooks.ts and system-prompt.ts. Any consumer importing these from `session.ts` will be updated to import from the actual source.

### 6. Update `host/index.ts` barrel

Add new modules:
```ts
export * from "./session-ctx.ts";
export * from "./tool-executor.ts";
```

Replace `./direct-executor.ts` with `./runtime.ts` and `./runtime.ts` with `./runtime-config.ts`.

### 7. Update `server.ts` re-export path

```ts
// Before:
export { createRuntime, type Runtime, type RuntimeOptions } from "./direct-executor.ts";
// After:
export { createRuntime, type Runtime, type RuntimeOptions } from "./runtime.ts";
```

Public API unchanged — users still do `import { createRuntime, createServer } from "@alexkroman1/aai/server"`.

## File map (after)

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `host/runtime-config.ts` | Logger, S2SConfig types + defaults | 95 |
| `host/tool-executor.ts` | Tool execution engine | 70 |
| `host/runtime.ts` | Runtime factory (createRuntime) | 250 |
| `host/session-ctx.ts` | Session context builder + types | 100 |
| `host/session.ts` | Session event handlers + factory | 370 |
| `host/server.ts` | HTTP + WebSocket server | 230 |
| `host/s2s.ts` | S2S WebSocket client | 330 |
| `host/ws-handler.ts` | WebSocket lifecycle handler | 246 |
| `host/builtin-tools.ts` | Built-in tool definitions | 270 |

## What does NOT change

- `isolate/` directory — no changes
- Public API exports in `package.json` — unchanged
- Test files — no logic changes, only import path updates
- `_runtime-conformance.ts`, `_test-utils.ts`, `_mock-ws.ts` — stay where they are
- `matchers.ts`, `vite-plugin.ts`, `unstorage-kv.ts` — unchanged except import path for runtime-config

## Verification

- `pnpm check:local` must pass (build, typecheck, lint, publint, syncpack, tests)
- All existing tests pass without logic changes
- `pnpm vitest run --project aai` passes
- `pnpm typecheck` passes (both host and isolate tsconfig)
