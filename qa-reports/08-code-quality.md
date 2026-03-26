# Code Quality QA Report

## Summary

Audit of all four workspace packages (`aai`, `aai-ui`, `aai-cli`, `aai-server`) identified 15 concrete code quality issues. The most significant findings are duplicated middleware runner logic between the SDK and the harness runtime, inconsistent read-only filesystem permission checks written in two different styles, and several magic numbers/strings scattered across the codebase. The codebase is generally well-structured, but the issues below represent opportunities to reduce maintenance burden and improve clarity.

## Issues Found

### Issue 1: Duplicated middleware runner logic between SDK and harness runtime
- **File**: `packages/aai-server/src/_harness-runtime.ts:194-258` (duplicated from `packages/aai/middleware.ts:16-166`)
- **Severity**: High
- **Description**: Five middleware runner functions (`runMiddlewareBeforeTurn`, `runMiddlewareAfterTurn`, `runMiddlewareToolIntercept`, `runMiddlewareAfterToolCall`, `runMiddlewareOutputFilter`) are reimplemented inline in the harness runtime. They mirror the logic in `packages/aai/middleware.ts` (`runBeforeTurnMiddleware`, `runAfterTurnMiddleware`, `runToolCallInterceptors`, `runAfterToolCallMiddleware`, `runOutputFilters`) nearly line-for-line. The file's own comment at line 192 acknowledges this: "Middleware runner (inline -- cannot import from middleware.ts in isolate)". While the isolate constraint is valid, having two independent copies of the same business logic creates a drift risk -- changes to middleware semantics in the SDK will not automatically propagate to the harness.
- **Recommendation**: Extract the pure middleware-running logic into a standalone module with zero external dependencies (no Zod, no npm packages) that can be bundled into the harness entry point via the build step. Alternatively, add integration tests that explicitly verify both implementations produce identical results for the same inputs.

### Issue 2: Duplicated `toAgentConfig` / `buildAgentConfig` functions
- **File**: `packages/aai-server/src/sandbox.ts:254-266` and `packages/aai/direct-executor.ts:55-67`
- **Severity**: Medium
- **Description**: `toAgentConfig` in `sandbox.ts` and `buildAgentConfig` in `direct-executor.ts` perform nearly identical field-by-field construction of an `AgentConfig` object. Both conditionally set `sttPrompt`, `maxSteps`, `toolChoice`, `builtinTools`, and `activeTools` with the same pattern. The sandbox version takes an `IsolateConfig` while the direct-executor version takes an `AgentDef`, but the mapping logic is structurally the same.
- **Recommendation**: Create a shared helper in `_internal-types.ts` or a new utility that accepts a common subset interface, reducing the two implementations to one.

### Issue 3: Duplicated read-only filesystem permission checks with inconsistent style
- **File**: `packages/aai/builtin-tools.ts:232` and `packages/aai-server/src/sandbox.ts:97-100`
- **Severity**: Medium
- **Description**: The read-only filesystem permission check is implemented in two different styles. In `builtin-tools.ts`, it uses a `Set`: `const READ_ONLY_FS_OPS = new Set(["read", "stat", "readdir", "exists"])` followed by `READ_ONLY_FS_OPS.has(req.op)`. In `sandbox.ts`, it uses an inline chain of `||` comparisons: `req.op === "read" || req.op === "stat" || req.op === "readdir" || req.op === "exists"`. Both express the same policy but differently. If a new filesystem operation needs to be allowed, both locations must be updated independently.
- **Recommendation**: Extract a shared `isReadOnlyFsOp(op: string): boolean` helper or export the `READ_ONLY_FS_OPS` Set from a shared location. Both sandbox and builtin-tools should reference the same definition.

### Issue 4: Magic number for WebSocket readyState (1 = OPEN) used inconsistently
- **File**: `packages/aai/ws-handler.ts:57,64,179` and `packages/aai/s2s.ts:34`
- **Severity**: Medium
- **Description**: The `s2s.ts` file correctly defines `const WS_OPEN = 1` and uses it. However, `ws-handler.ts` uses the raw literal `1` three times (lines 57, 64, 179) instead of a named constant. Similarly, `packages/aai-ui/session.ts` uses `WebSocket.OPEN` (the browser constant) at line 88 and elsewhere. There are three different approaches to the same value across the codebase.
- **Recommendation**: Use a single named constant `WS_OPEN = 1` defined in a shared location (e.g., `_utils.ts` or `protocol.ts`) and reference it consistently across `ws-handler.ts` and `s2s.ts`. The UI package can continue using the browser's `WebSocket.OPEN` since it runs in a different environment.

### Issue 5: Mutable module-level state in `builtin-tools.ts` for lazy import
- **File**: `packages/aai/builtin-tools.ts:203-207`
- **Severity**: Medium
- **Description**: The `_secureExec` variable is a mutable module-level `let` used for lazy import caching: `let _secureExec: typeof import("secure-exec") | undefined`. While the pattern works, it introduces shared mutable state at module scope that persists across all callers. In a long-running server process, this is effectively a singleton cache with no way to reset it (e.g., for testing or module hot-reloading).
- **Recommendation**: Consider using a `Promise`-based lazy pattern that is idempotent: `const secureExecPromise = import("secure-exec")` evaluated once, or encapsulate the caching in a function-scoped closure to make the state less globally accessible.

### Issue 6: `_net.ts` redundant hostname check for `169.254.169.254`
- **File**: `packages/aai-server/src/_net.ts:71`
- **Severity**: Low
- **Description**: The `assertPublicUrl` function explicitly checks `lower === "169.254.169.254"` in the hostname blocklist at line 71. However, the IP range `169.254.0.0/16` is already covered by the `privateBlocks` BlockList at line 11 (`["169.254.0.0", 16]`). The `isPrivateIp(hostname)` call at line 60 will already catch this IP. The explicit string comparison is redundant dead code.
- **Recommendation**: Remove the `lower === "169.254.169.254"` check from line 71 since it is already handled by the CIDR-based BlockList. Add a comment to the BlockList noting that it covers cloud metadata IPs.

### Issue 7: `_harness-runtime.ts` invokeHook uses a handlers map rebuilt on every call
- **File**: `packages/aai-server/src/_harness-runtime.ts:260-309`
- **Severity**: Medium
- **Description**: The `invokeHook` function creates a `handlers` object literal with 11 entries on every single hook invocation. Each entry creates closures over `ctx`, `req`, `agent`, and `middleware`. Since hooks fire frequently (onTurn, onStep, etc.), this allocates a new object and 11 closures per invocation. Only one handler is ever called per invocation.
- **Recommendation**: Refactor to a `switch` statement or a static dispatch table that does not require rebuilding the entire map on each call. This reduces allocation pressure and makes the control flow more explicit.

### Issue 8: `deploy.ts` does not await `sandbox.terminate()` on hot replacement
- **File**: `packages/aai-server/src/deploy.ts:29`
- **Severity**: High
- **Description**: When replacing an existing deployment, `existing.sandbox.terminate()` is called without `await` at line 29. The `terminate()` method is `async` (it awaits session stops and runtime disposal per `sandbox.ts:338-359`). By not awaiting it, the old sandbox's resource cleanup races with the new sandbox's initialization, potentially causing port conflicts, orphaned isolates, or in-flight requests hitting a half-disposed sandbox.
- **Recommendation**: Add `await` before `existing.sandbox.terminate()` to ensure the old sandbox is fully cleaned up before proceeding with the new deployment.

### Issue 9: `session.ts` buildCtx uses mutable object with method-level side effects
- **File**: `packages/aai/session.ts:90-143`
- **Severity**: Medium
- **Description**: The `buildCtx` function constructs an `S2sSessionCtx` object where `checkTurnLimits` has a hidden side effect: it mutates `ctx.toolCallCount++` at line 114. The method name "check" implies a read-only operation, but it also increments state. This makes the function non-idempotent and could cause subtle bugs if called more than once per tool call or reordered. The method signature `checkTurnLimits(turnConfig, name): string | null` gives no indication that it mutates state.
- **Recommendation**: Rename to `consumeToolCallStep` or separate the mutation (`ctx.toolCallCount++`) from the limit check, making the side effect explicit in the API.

### Issue 10: `_harness-protocol.ts` ToolCallRequestSchema includes unused `env` field
- **File**: `packages/aai-server/src/_harness-protocol.ts:54`
- **Severity**: Low
- **Description**: The `ToolCallRequestSchema` includes an `env: z.record(z.string(), z.string())` field. However, in `sandbox.ts:buildExecuteTool` (lines 188-198), the tool call RPC sends `{ name, args, sessionId, messages }` -- there is no `env` field. The harness runtime at `_harness-runtime.ts:141-163` also does not read `req.env` for tool calls; it uses the module-level `agentEnv` instead. The `env` field in the schema is never populated or consumed for tool calls, making it dead schema.
- **Recommendation**: Remove the `env` field from `ToolCallRequestSchema` (and `HookRequestSchema` at line 75, which has the same issue) to keep the schema honest about what is actually transmitted.

### Issue 11: `sandbox-network.ts` creates a new Zod schema per call inside `buildNetworkPolicy`
- **File**: `packages/aai-server/src/sandbox-network.ts:32-39`
- **Severity**: Low
- **Description**: Inside `buildNetworkPolicy`, the `AllowedRequestSchema` Zod schema is created fresh every time the function is called, which happens once per sandbox. While this is not on a hot path, the schema could be parameterized and reused. More importantly, the schema uses `.refine()` with a closure over `allowedHost` and `allowedPort`, making it a new schema definition every time. This is atypical compared to the rest of the codebase where Zod schemas are defined at module scope.
- **Recommendation**: This is a minor style inconsistency. If `buildNetworkPolicy` is called infrequently (once per sandbox), this is acceptable. Consider adding a comment explaining why the schema is defined inside the function (needs closure over config values).

### Issue 12: Polling loop with `setTimeout` in `builtin-tools.ts` executeInIsolate
- **File**: `packages/aai/builtin-tools.ts:300-304`
- **Severity**: Medium
- **Description**: The `executeInIsolate` function uses a polling loop with 50ms sleeps to check if the isolate has produced output: `while (Date.now() < deadline) { await new Promise(r => setTimeout(r, 50)); if (stdoutChunks.length > 0 || finished) break; }`. This is an inefficient busy-wait pattern that adds up to 50ms of unnecessary latency to every `run_code` invocation and wastes CPU cycles on repeated checks.
- **Recommendation**: Replace with a `Promise`-based notification pattern. Create a `resolve`-able promise that the `onStdio` callback triggers when output arrives, and race it against the timeout. This eliminates polling and provides instant notification.

### Issue 13: `_discover.ts` getApiKey mutates `process.env` as a side effect
- **File**: `packages/aai-cli/_discover.ts:67,80`
- **Severity**: Medium
- **Description**: The `getApiKey` function reads the API key from config and then writes it back to `process.env.ASSEMBLYAI_API_KEY` at lines 67 and 80. This mutates global process state as a side effect of what appears to be a getter function. Other parts of the codebase may depend on this side effect (e.g., the dev server reading `process.env`), creating an implicit coupling. If `getApiKey` is called multiple times or from tests, the mutation is non-obvious.
- **Recommendation**: Make the `process.env` mutation explicit by documenting it in the function's JSDoc, or separate the "get" and "set" concerns. Consider returning the key and letting the caller decide whether to set it on `process.env`.

### Issue 14: Inconsistent error object creation patterns
- **File**: `packages/aai-server/src/_harness-runtime.ts:143` and `packages/aai-server/src/sandbox-sidecar.ts:107`
- **Severity**: Low
- **Description**: Error objects with extra properties are created using `Object.assign(new Error(...), { status: 404 })` at `_harness-runtime.ts:143` and `Object.assign(new Error(...), { status: 503 })` at `sandbox-sidecar.ts:107`. Elsewhere in the codebase (e.g., `orchestrator.ts:87`), errors are handled via `HTTPException` from Hono. The `Object.assign` pattern is non-standard and relies on the catch handler knowing to inspect `.status`, while the Hono approach is framework-native. Within the same package (`aai-server`), two different error signaling patterns are used.
- **Recommendation**: Standardize on a single error pattern within `aai-server`. Since the harness runtime cannot use Hono (it uses raw `node:http`), document that `Object.assign(new Error(), { status })` is the convention for the harness, and ensure all handlers that catch these errors consistently read the `.status` property.

### Issue 15: `_session-otel.ts` setupListeners function has high cyclomatic complexity
- **File**: `packages/aai/_session-otel.ts:158-278`
- **Severity**: Medium
- **Description**: The `setupListeners` function is 120 lines long and registers 11 event handlers, each with its own logic including conditional middleware invocations, promise chaining, error handling, and state mutations. The `reply_done` handler alone (lines 231-266) contains nested conditionals with two code paths (interrupted vs. normal), a closure (`sendPending`), and conditional promise chaining. The function handles too many concerns: event routing, middleware integration, state management, and client event emission.
- **Recommendation**: Extract individual event handlers into named functions (e.g., `handleReplyDone`, `handleUserTranscript`, `handleAgentTranscript`) to reduce the complexity of `setupListeners` to a simple event-wiring function. Each extracted handler can be independently tested.
