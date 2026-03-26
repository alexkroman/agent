# Test Coverage QA Report

## Summary

Analysis of all four workspace packages reveals 27 source files with no corresponding test file, several tests with missing or weak assertions, untested security-critical code paths, and potential flakiness from timing-dependent patterns. The most concerning gaps are in security-related modules (`sandbox-network.ts`, `sandbox-sidecar.ts`, `_harness-runtime.ts`) and client-side logic (`client-handler.ts`, `signals.ts`).

## Issues Found

### Issue 1: No test file for `memory-tools.ts` -- public API with KV interaction
- **File**: `packages/aai/memory-tools.ts:25`
- **Severity**: High
- **Description**: `memoryTools()` is a public API exported from the main SDK entry point. It defines four KV-backed tools (`save_memory`, `recall_memory`, `list_memories`, `forget_memory`) that interact with `ctx.kv`. None of these tool execute functions are tested, including edge cases like saving empty strings, recalling non-existent keys, or listing with various prefix values.
- **Recommendation**: Add `memory-tools_test.ts` that exercises each tool's `execute` function using `createMemoryKv()`, including edge cases: empty key, empty value, `null` return from `kv.get`, and prefix-filtered listing.

### Issue 2: No test file for `sandbox-network.ts` -- security-critical network policy
- **File**: `packages/aai-server/src/sandbox-network.ts:27`
- **Severity**: High
- **Description**: `buildNetworkPolicy()` and `buildNetworkAdapter()` are the sandbox network isolation boundary. They restrict isolate network access to the sidecar loopback server only. Neither function has direct unit tests. The `buildNetworkPolicy` function has distinct branches for `listen`, `dns`, and URL-based operations, none of which are verified. The `buildNetworkAdapter` has an SSRF bypass for sidecar URLs that should be tested to ensure it only bypasses the exact sidecar origin and not similar-looking URLs.
- **Recommendation**: Add `sandbox-network.test.ts` covering: (1) policy allows listen ops, (2) policy allows loopback DNS only, (3) policy blocks external URLs, (4) policy allows sidecar URL, (5) adapter routes sidecar calls directly, (6) adapter delegates non-sidecar calls to default adapter, (7) rejects non-loopback sidecar URL in `SidecarUrlSchema`.

### Issue 3: No test file for `sandbox-sidecar.ts` -- scoped KV/vector isolation
- **File**: `packages/aai-server/src/sandbox-sidecar.ts:20`
- **Severity**: High
- **Description**: `scopedKv()` wraps a KV store with scope-based isolation, and `scopedVector()` does the same for vector stores. The sidecar HTTP server routes agent requests to these scoped adapters. There are no direct tests verifying that the scoping actually prevents cross-agent data access, that JSON parse errors in `scopedKv.get()` are handled (line 28 catch block), or that the TTL conversion from milliseconds to seconds (line 33) is correct.
- **Recommendation**: Add `sandbox-sidecar.test.ts` testing: scoped KV isolation between different scopes, JSON parse fallback behavior, expireIn ms-to-seconds conversion, and scoped vector namespace isolation.

### Issue 4: `server.test.ts` -- test with no meaningful assertion ("/health returns ok JSON")
- **File**: `packages/aai/server.test.ts:27`
- **Severity**: Medium
- **Description**: The test "/health returns ok JSON" creates a server, calls `listen(0)`, but then immediately calls `close()` without ever making a request to `/health`. The comment says "Hono's serve binds on port 0, need to get actual port / We'll use a known port for testing" but no request is made. This test asserts nothing about the health endpoint. A later test (line 73) does test `/health` properly, making this test redundant dead code that gives false confidence.
- **Recommendation**: Remove this empty test or fix it to actually fetch the health endpoint. The test at line 73 already covers this functionality properly.

### Issue 5: Flaky port allocation in `server.test.ts` tests
- **File**: `packages/aai/server.test.ts:46`
- **Severity**: Medium
- **Description**: Multiple tests use `const port = 19_876 + Math.floor(Math.random() * 1000)` for port allocation. This is a classic source of flakiness: two parallel test runs could pick the same port, or the port could already be in use. The range of only 1000 ports combined with random selection makes collisions likely under CI parallelism. Tests at lines 46, 59, 74, and 88 all use this pattern.
- **Recommendation**: Use port 0 to let the OS assign an ephemeral port, then extract the actual port from the server instance. Alternatively, use a sequential port counter or a port-finding utility.

### Issue 6: `middleware.test.ts` -- empty afterTurn test has no assertion
- **File**: `packages/aai/middleware.test.ts:265`
- **Severity**: Medium
- **Description**: The test "empty middleware array is a no-op for afterTurn" calls `runAfterTurnMiddleware([], "hello", makeCtx())` but has no assertion whatsoever. It only verifies the call does not throw, which is weak -- it should at minimum verify that the function resolves (explicit `await expect(...).resolves.toBeUndefined()`).
- **Recommendation**: Add an explicit assertion that the promise resolves without error, or verify that the context remains unchanged after execution.

### Issue 7: No test for `_utils.ts:errorDetail()` function
- **File**: `packages/aai/_utils.ts:10`
- **Severity**: Medium
- **Description**: `_utils.test.ts` tests `errorMessage()` and `filterEnv()` but completely omits testing `errorDetail()`. This function has branching logic: it returns `err.stack` if available, falls back to `err.message` for Error instances, and uses `String()` for non-Error values. The stack trace extraction path is never verified. `errorDetail` is used in production code for diagnostic logging of tool execution failures (`_session-otel.ts:134`).
- **Recommendation**: Add tests for `errorDetail()` covering: Error with stack, Error without stack (stack property undefined), string input, and null/undefined inputs.

### Issue 8: No test file for `_session-otel.ts` -- session lifecycle and tool call orchestration
- **File**: `packages/aai/_session-otel.ts:43`
- **Severity**: High
- **Description**: `_session-otel.ts` contains `handleToolCall()` and `setupListeners()`, which form the core session orchestration logic: tool call execution, middleware interception, barge-in handling, reply lifecycle, and OpenTelemetry instrumentation. This file has 278 lines of complex async logic including generation-based stale callback detection (lines 30-41), middleware interception chains (lines 102-127), and the entire S2S event wiring (lines 158-278). None of this is directly tested. The integration test (`integration.test.ts`) may cover some paths but does not unit-test individual branches like `resolveTurnConfig` errors (line 68), tool refusal (line 78), or the `reply_done` pending-tools flush logic (line 243-265).
- **Recommendation**: Add `_session-otel.test.ts` with unit tests for `handleToolCall` (covering: normal execution, refused tool call, middleware block, middleware cached result, middleware arg transform, execution error, and stale generation discard) and `setupListeners` (covering: barge-in generation bump, reply_done with pending tools, reply_done without pending tools).

### Issue 9: `_net.test.ts` -- missing test for `0.0.0.0` and CIDR edge cases
- **File**: `packages/aai-server/src/_net.test.ts:5`
- **Severity**: Medium
- **Description**: The SSRF protection test suite does not test `assertPublicUrl("http://0.0.0.0/")` (the `0.0.0.0/8` block is registered at `_net.ts:9`). It also lacks tests for `100.64.0.0/10` (CGN range), `192.0.0.0/24`, `198.18.0.0/15` (benchmarking), and `240.0.0.0/4` (reserved). The `_net.ts` code explicitly registers all these ranges but the tests only check `10.x`, `172.16.x`, `192.168.x`, and `127.x` for `isPrivateIp`. A misconfiguration in any of the untested ranges would go undetected.
- **Recommendation**: Add tests for every registered CIDR block: `0.0.0.0`, `100.64.0.1`, `192.0.0.1`, `198.18.0.1`, and `240.0.0.1`. Also test boundary IPs like `172.31.255.255` (last address in 172.16.0.0/12).

### Issue 10: No test file for `client-handler.ts` -- critical UI state machine
- **File**: `packages/aai-ui/client-handler.ts:15`
- **Severity**: High
- **Description**: `ClientHandler` is a 208-line class that implements the entire client-side state machine: processing all server-to-client event types (`speech_started`, `transcript`, `turn`, `chat_delta`, `chat`, `tool_call_start`, `tool_call_done`, `tts_done`, `cancelled`, `reset`, `error`), audio chunk routing, and WebSocket message parsing with Zod validation. While `session.test.ts` tests the `ClientHandler` class through the re-export in `session.ts`, the `client-handler.ts` module itself has no dedicated test file. There are missing edge case tests: `handleMessage` with malformed JSON (line 190 catch block), `handleMessage` with valid JSON that fails schema validation (line 185-187), `playAudioChunk` when state is `error` (line 143 early return), `playAudioDone` generation mismatch after cancellation (line 157), and binary frame handling in `handleMessage` (line 176-178).
- **Recommendation**: Add `client-handler.test.ts` or extend `session.test.ts` to cover: malformed JSON messages, schema validation failures, audio chunk rejection in error state, generation-based stale callback suppression in `playAudioDone`, and binary frame dispatch.

### Issue 11: No test file for `system-prompt.ts` -- prompt construction logic
- **File**: `packages/aai/system-prompt.ts:21`
- **Severity**: Low
- **Description**: `buildSystemPrompt()` is tested indirectly via `session.test.ts` which imports and re-exports it. However, the function lives in its own module and is imported by `session.ts`. The `session.test.ts` tests cover the basic cases well, but the function uses `new Date().toLocaleDateString()` (line 37-41) which makes tests time-dependent -- the expected date string in `session.test.ts:56` will produce different values on different days. While this is technically correct (the test generates the expected date the same way), it means the test can never catch a bug where the date format is wrong.
- **Recommendation**: Consider using `vi.useFakeTimers()` to pin the date and assert against a known string value, ensuring the date format is exactly as expected.

### Issue 12: No test file for `signals.ts` -- Preact session controls and hooks
- **File**: `packages/aai-ui/signals.ts:50`
- **Severity**: Medium
- **Description**: `createSessionControls()` contains reactive UI logic: `start()`, `toggle()`, and `reset()` methods that manage session state transitions, and an `effect()` that auto-sets `running=false` on error. The `useSession()` hook throws when used outside a provider (line 119). The `useToolResult()` hook has deduplication logic with a `seenRef` set. None of these are tested. Given that `signals.ts` is publicly exported in `components.ts` and is the primary way users interact with session state, this is a notable gap.
- **Recommendation**: Add `signals.test.ts` using `@testing-library/preact` or direct signal manipulation to test: `start()` sets both signals and calls `connect()`, `toggle()` disconnects when running and reconnects when stopped, error state sets `running=false`, `useSession()` throws outside provider, and `Symbol.dispose` calls dispose.

### Issue 13: `auth.test.ts` -- no test for timing-safe comparison
- **File**: `packages/aai-server/src/auth.ts:13`
- **Severity**: Medium
- **Description**: `timingSafeCompare()` is a security-critical function used to prevent timing attacks on API key verification. The test file (`auth.test.ts`) tests `verifySlugOwner` which uses `timingSafeCompare` internally, but never directly tests the timing-safe property. More importantly, the `timingSafeCompare` function has a length-check short-circuit at line 14 (`if (a.length !== b.length) return false`) which technically leaks length information -- this is an accepted tradeoff for SHA-256 hashes (always 64 chars) but is not documented or tested.
- **Recommendation**: Add a test verifying that `timingSafeCompare` returns `false` for different-length strings and `true`/`false` for same-length strings correctly. Consider adding a comment documenting that the length leak is acceptable because inputs are always fixed-length SHA-256 hex digests.

### Issue 14: No test file for `_deploy.ts` -- CLI deploy logic
- **File**: `packages/aai-cli/_deploy.ts:1`
- **Severity**: Medium
- **Description**: While `deploy.test.ts` exists, it tests the `deploy.ts` entry point (subcommand dispatch). The internal `_deploy.ts` module contains the actual deploy logic including API calls, bundle upload, and error handling. There is no `_deploy.test.ts` file to test this internal logic in isolation. The `deploy.test.ts` tests may exercise some paths via integration, but internal error handling and edge cases (network failures, auth errors, malformed server responses) are likely untested.
- **Recommendation**: Add `_deploy.test.ts` with mocked `fetch` to test: successful deploy flow, authentication failure handling, network error handling, and malformed response handling.

### Issue 15: `server.test.ts` -- flaky timing-dependent assertion
- **File**: `packages/aai/server.test.ts:99`
- **Severity**: Medium
- **Description**: The test "404 triggers error-level logging" uses `await new Promise((r) => setTimeout(r, 50))` to wait for async logging before asserting. This is a classic flaky test pattern -- on slow CI machines or under load, 50ms may not be enough. The comment even acknowledges the timing dependency: "Give a moment for async logging."
- **Recommendation**: Replace the sleep-based wait with a proper polling mechanism or use `vi.waitFor()` / `expect.poll()` to retry the assertion until it passes or times out.
