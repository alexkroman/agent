# Refactoring Opportunities

Analysis of complexity reduction opportunities across the AAI codebase.

## High Impact

### 1. Duplicate Middleware Runners in Harness Runtime

**Files:** `packages/aai/middleware.ts` (158 lines) vs `packages/aai-server/src/_harness-runtime.ts` (lines ~195-261)

The harness runtime re-implements all 5 middleware runner functions inline (`runMiddlewareBeforeTurn`, `runMiddlewareAfterTurn`, `runMiddlewareToolIntercept`, `runMiddlewareAfterToolCall`, `runMiddlewareOutputFilter`) because the isolate cannot import from `node_modules`.

**Suggestion:** Extract a zero-dependency `middleware-runner.ts` that both files can import. Since the harness is bundled via tsdown, a self-contained module with no transitive deps (no Zod, no external packages) could be bundled into the harness entry without breaking the isolate constraint. This would eliminate ~65 lines of duplicated logic and ensure behavioral parity.

### 2. `dispatchS2sMessage` Switch Statement (s2s.ts:90-139)

**File:** `packages/aai/s2s.ts`

The 50-line switch in `dispatchS2sMessage` maps S2S message types to emitter events with mechanical 1:1 transformations. This can be replaced with a declarative dispatch map:

```ts
const S2S_DISPATCH: Record<string, (msg: any, emitter: Emitter<S2sEvents>) => void> = {
  "session.ready": (msg, e) => e.emit("ready", { session_id: msg.session_id }),
  "input.speech.started": (_msg, e) => e.emit("speech_started"),
  // ...
};
```

This reduces cyclomatic complexity and makes adding new message types a one-liner.

### 3. Handler Pattern Duplication (kv-handler.ts / vector-handler.ts)

**Files:** `packages/aai-server/src/kv-handler.ts` (46 lines), `packages/aai-server/src/vector-handler.ts` (45 lines)

Both handlers follow an identical pattern: parse request with Zod schema, switch on `op` field, wrap in try/catch with console.error logging. A shared factory would eliminate the structural duplication:

```ts
function createOpHandler<T extends { op: string }>(
  schema: ZodSchema<T>,
  label: string,
  handler: (c: Context<Env>, scope: AgentScope, msg: T) => Promise<Response>,
) { ... }
```

## Medium Impact

### 4. Session State Manager Duplication

**Files:** `packages/aai/direct-executor.ts` (lines 98-120) vs `packages/aai-server/src/_harness-runtime.ts` (lines ~88-99)

Both implement the same per-session state initialization pattern (`getState` + `makeHookContext`). A shared `SessionStateManager` class or factory function would consolidate this:

```ts
export function createSessionStateManager(stateFactory?: () => Record<string, unknown>) {
  const states = new Map<string, Record<string, unknown>>();
  return {
    get(id: string) {
      if (!states.has(id) && stateFactory) states.set(id, stateFactory());
      return states.get(id) ?? {};
    },
    delete(id: string) { states.delete(id); },
  };
}
```

### 5. Large Hook Handler Map in `_harness-runtime.ts` (lines ~268-312)

**File:** `packages/aai-server/src/_harness-runtime.ts`

The `invokeHook` function has an inline `handlers` object with 11 hook handlers, each following the same pattern of checking for the hook/middleware, calling it, and returning a response. Extracting each handler to a named function and using a dispatch map would reduce the function's cognitive complexity from ~15 to ~5.

### 6. `builtin-tools.ts` Inline Isolate Harness

**File:** `packages/aai/builtin-tools.ts` (lines ~220-306)

The `createRunCode` function contains a 20-line harness code template as an inline string, a 25-line runtime options object, and a polling loop. These three concerns could be extracted:
- `_run-code-harness.ts` for the harness template
- `buildRunCodeRuntime()` for the options
- `pollIsolateOutput()` for the result collection loop

### 7. Middleware Runner Iteration Patterns

**File:** `packages/aai/middleware.ts`

The 5 exported functions use 3 iteration patterns (forward-with-early-return, reverse, forward-with-accumulation). A pair of helpers would reduce repetition:

```ts
async function forwardMiddleware<T>(mw: Middleware[], key: string, fn: (m: Middleware) => Promise<T | void>): Promise<T | void>
async function reverseMiddleware(mw: Middleware[], key: string, fn: (m: Middleware) => Promise<void>): Promise<void>
```

## Low Impact (Nice-to-Have)

### 8. `types.ts` Organization (442 lines)

**File:** `packages/aai/types.ts`

All agent types, hook types, middleware types, and tool types are in one file. Splitting into `types/hooks.ts`, `types/middleware.ts`, `types/agent.ts` with a barrel re-export would improve navigability without changing the public API.

### 9. Test Utilities Duplication

**File:** `packages/aai-server/src/_test-utils.ts` (247 lines)

`createTestKvStore()` and `createTestVectorStore()` both implement identical `scopedKey` helpers and similar prefix-filtering iteration. A shared `ScopedKeyManager` would eliminate this.

### 10. CLI Command Boilerplate

**File:** `packages/aai-cli/cli.ts`

Every command handler follows: resolve cwd, ensure agent, dynamic import, spread args. A `defineAgentCommand()` helper would reduce per-command boilerplate from ~10 lines to ~3.

## Summary

| # | Refactoring | Lines Saved | Risk |
|---|-------------|-------------|------|
| 1 | Shared middleware runner | ~65 | Medium (isolate bundling) |
| 2 | S2S dispatch map | ~30 | Low |
| 3 | Handler factory | ~25 | Low |
| 4 | Session state manager | ~15 | Low |
| 5 | Hook handler extraction | ~20 | Low |
| 6 | Run-code extraction | ~30 | Low |
| 7 | Middleware iteration helpers | ~15 | Low |
| 8 | Types file split | 0 (reorg) | Low |
| 9 | Test utility dedup | ~20 | Low |
| 10 | CLI command helper | ~30 | Low |

Items 2, 3, 4, and 7 are the best candidates for immediate action: low risk, clear complexity reduction, and no architectural changes needed.
