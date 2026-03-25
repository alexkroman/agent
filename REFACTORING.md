# Refactoring Opportunities

Analysis of complexity reduction opportunities across the AAI codebase.

> **Design constraint:** `_harness-runtime.ts` runs inside a secure-exec V8
> isolate (128 MB, no `node_modules`, minimal boot time). Code imported into
> the isolate must be small and fast. Duplication between the harness and
> SDK-side code is an intentional trade-off — the harness deliberately
> inlines logic to avoid bundle bloat, import overhead, and transitive
> dependency risk. Refactorings below respect this boundary.

## Recommended (host-side / CLI — no isolate impact)

### 1. `builtin-tools.ts` Inline Isolate Harness

**File:** `packages/aai/builtin-tools.ts` (lines ~220-306)

The `createRunCode` function mixes three concerns: a 20-line harness code template as an inline string, a 25-line runtime options object, and a polling loop. All host-side, no isolate import path. Extract to:
- `_run-code-harness.ts` for the harness template string
- `buildRunCodeRuntime()` for the options
- `pollIsolateOutput()` for the result collection loop

### 2. Middleware Iteration Helpers

**File:** `packages/aai/middleware.ts` (158 lines)

The 5 exported functions use 3 iteration patterns (forward-with-early-return, reverse, forward-with-accumulation). This file is used by `direct-executor.ts` (self-hosted, host-side) — not by the isolate. A pair of helpers would reduce repetition:

```ts
async function forwardMiddleware<T>(
  mw: Middleware[], key: string, fn: (m: Middleware) => Promise<T | void>
): Promise<T | void>

async function reverseMiddleware(
  mw: Middleware[], key: string, fn: (m: Middleware) => Promise<void>
): Promise<void>
```

### 3. CLI Command Boilerplate

**File:** `packages/aai-cli/cli.ts`

Every command handler follows: resolve cwd, ensure agent, dynamic import, spread args. A `defineAgentCommand()` helper would reduce per-command boilerplate from ~10 lines to ~3. CLI startup is not performance-sensitive.

### 4. `types.ts` Organization (442 lines)

**File:** `packages/aai/types.ts`

All agent types, hook types, middleware types, and tool types are in one file. Splitting into `types/hooks.ts`, `types/middleware.ts`, `types/agent.ts` with a barrel re-export would improve navigability. Zero runtime impact — purely compile-time.

### 5. Test Utilities Duplication

**File:** `packages/aai-server/src/_test-utils.ts` (247 lines)

`createTestKvStore()` and `createTestVectorStore()` both implement identical `scopedKey` helpers and similar prefix-filtering iteration. A shared `ScopedKeyManager` would eliminate this. Test-only code, no runtime impact.

## Intentionally Not Recommended

The following were identified as duplicated patterns but are **intentionally left as-is** due to the isolate performance constraint:

### Harness middleware runners (`_harness-runtime.ts` lines ~195-261)

Re-implements all 5 middleware functions from `middleware.ts`. Sharing these would require bundling them into the isolate entry, increasing boot time and bundle size. The inline versions are deliberately minimal — ~65 lines is a small price for isolate safety and fast cold starts.

### Session state manager (`_harness-runtime.ts` lines ~88-99)

5-line `getState()` duplicated from `direct-executor.ts`. Importing an abstraction adds bundle weight inside the isolate for negligible DRY benefit.

### Hook handler map (`_harness-runtime.ts` lines ~268-312)

11 inline hook handlers in `invokeHook`. Extracting to named functions adds indirection in the isolate hot path. The current form is already clear and direct.

### `dispatchS2sMessage` switch (`s2s.ts:90-139`)

50-line switch mapping S2S message types to events. Handles real-time audio. V8 optimizes switch statements very well for this pattern; an object lookup + dynamic dispatch could actually be slower and adds allocation overhead. Not worth the trade-off.

### Handler factory for kv/vector handlers

`kv-handler.ts` (46 lines) and `vector-handler.ts` (45 lines) are structurally similar but in the platform server request path. They're already small, fast, and clear. A factory abstraction adds indirection for minimal gain.

## Summary

| # | Refactoring | Location | Lines Saved | Risk |
|---|-------------|----------|-------------|------|
| 1 | Run-code extraction | builtin-tools.ts (host) | ~30 | Low |
| 2 | Middleware iteration helpers | middleware.ts (host) | ~15 | Low |
| 3 | CLI command helper | cli.ts (CLI) | ~30 | Low |
| 4 | Types file split | types.ts (compile-time) | 0 (reorg) | Low |
| 5 | Test utility dedup | _test-utils.ts (test) | ~20 | Low |

All recommended items are host-side or CLI code with no impact on isolate boot time or runtime performance.
