# Error Handling QA Report

## Summary

Audit of error handling across all four packages (`aai`, `aai-ui`, `aai-cli`, `aai-server`). Found 15 concrete issues ranging from unhandled promise rejections and missing error propagation to resource leaks on error paths and race conditions. The most critical issues involve fire-and-forget promises that can lose errors silently, missing cleanup in error paths, and timeout handling gaps.

## Issues Found

### Issue 1: Unhandled promise rejection from `sandbox.terminate()` in deploy handler
- **File**: `packages/aai-server/src/deploy.ts:29`
- **Severity**: High
- **Description**: When replacing an existing deployment, `existing.sandbox.terminate()` is called without `await` and without a `.catch()` handler. Since `terminate()` returns `Promise<void>`, any rejection becomes an unhandled promise rejection that can crash the Node process. The `initializing` path on line 31-35 has a `.catch()`, but the synchronous sandbox path on line 29 does not.
- **Recommendation**: Either `await existing.sandbox.terminate()` with a try/catch, or append `.catch(() => { /* best-effort */ })` to match the pattern used on line 31-35 for the `initializing` case.

### Issue 2: Unhandled promise rejection from `sandbox.terminate()` in idle eviction
- **File**: `packages/aai-server/src/sandbox-slots.ts:67`
- **Severity**: High
- **Description**: `slot.sandbox.terminate()` is called inside a `setTimeout` callback without `await` or `.catch()`. The `terminate()` method is async and can reject (e.g., if the isolate is already disposed or the sidecar close fails). Any rejection becomes an unhandled promise rejection.
- **Recommendation**: Add `.catch()` to the terminate call: `slot.sandbox.terminate().catch(() => { /* idle eviction cleanup */ })`.

### Issue 3: `connectAndSetup` swallows S2S connection failure without closing the session
- **File**: `packages/aai/session.ts:196-200`
- **Severity**: High
- **Description**: When `connectS2s` fails in `connectAndSetup`, the error is caught and an error event is sent to the client, but the session is not stopped or cleaned up. The session remains in the `sessions` map (managed by `ws-handler.ts`) in a broken state where `ctx.s2s` is null, so subsequent `onAudio` calls will silently no-op. The client receives an error event but has no mechanism to know the session is permanently dead.
- **Recommendation**: After sending the error event, either throw the error so the caller can clean up, or explicitly trigger session teardown (e.g., close the client sink or signal the session is unrecoverable).

### Issue 4: `session.stop()` error in WebSocket close handler is silently discarded
- **File**: `packages/aai/ws-handler.ts:197-201`
- **Severity**: Medium
- **Description**: In the WebSocket `close` event handler, `session.stop()` is called with `void` and `.finally()`, but there is no error handling. If `session.stop()` rejects, the rejection is unhandled. The `finally` block only deletes the session from the map but the error is lost. There should be a `.catch()` to log the error.
- **Recommendation**: Add `.catch((err) => log.error("Session stop failed", { error: err }))` before the `.finally()`.

### Issue 5: Server `listen()` never resolves if the port is already in use
- **File**: `packages/aai/server.ts:127-129`
- **Severity**: Medium
- **Description**: The `listen()` method waits for the `listening` event on `nodeServer`, but does not handle the `error` event. If the port is already in use, Node's `http.Server` emits an `error` event (EADDRINUSE) instead of `listening`. The promise will hang forever, never resolving or rejecting.
- **Recommendation**: Listen for the `error` event on `nodeServer` and reject the promise. Same issue exists in `packages/aai-server/src/sandbox-sidecar.ts:180-182`.

### Issue 6: Sidecar server `listen()` hangs on port conflict
- **File**: `packages/aai-server/src/sandbox-sidecar.ts:180-182`
- **Severity**: Medium
- **Description**: Same as Issue 5. `startSidecarServer` awaits the `listening` event but does not handle the `error` event from the underlying Node HTTP server. If port allocation fails, the promise hangs indefinitely, which will block sandbox initialization.
- **Recommendation**: Add an `error` listener that rejects the promise.

### Issue 7: Isolate port announcement has no timeout and can hang forever
- **File**: `packages/aai-server/src/sandbox.ts:88-91,144`
- **Severity**: Medium
- **Description**: `startIsolate` creates a promise `portPromise` that resolves when the isolate's stdout emits a JSON message containing a `port` field. If the isolate fails to boot, crashes, or never emits this message, the `await portPromise` on line 144 hangs forever. The `runtime.exec().catch(() => {})` on lines 135-142 swallows the exec error, so the host has no signal that the isolate died.
- **Recommendation**: Add `AbortSignal.timeout()` or `Promise.race` with a timeout to `portPromise`, and propagate the exec rejection as a port-resolution failure.

### Issue 8: `initAudioCapture` rejection is silently discarded
- **File**: `packages/aai-ui/session.ts:275`
- **Severity**: Medium
- **Description**: `initAudioCapture` is called with `void` (fire-and-forget). While it has internal error handling that sets `error.value`, the `void` prefix means if there is an unexpected error that escapes the try/catch (e.g., a bug in the error handler itself), it becomes an unhandled promise rejection in the browser.
- **Recommendation**: Replace `void initAudioCapture(...)` with `initAudioCapture(...).catch((err) => { ... })` to ensure any unexpected errors are caught.

### Issue 9: `runMain` rejection is unhandled in CLI entry point
- **File**: `packages/aai-cli/cli.ts:221`
- **Severity**: Medium
- **Description**: `void runMain(mainCommand)` fires and forgets the CLI main function. If `runMain` rejects with an unexpected error, it becomes an unhandled promise rejection. While `citty` (the CLI framework) likely handles errors internally, there is no explicit fallback. This could result in the process hanging or exiting without a useful error message.
- **Recommendation**: Add a `.catch()` handler that logs the error and calls `process.exit(1)`.

### Issue 10: `link` and `unlink` commands do not await their async operations
- **File**: `packages/aai-cli/cli.ts:195-196,203`
- **Severity**: Medium
- **Description**: The `link` and `unlink` command `run()` handlers call `runLinkCommand(resolveCwd())` and `runUnlinkCommand(resolveCwd())` without `await`. Since these are async functions, their returned promises are discarded. Any errors will become unhandled rejections, and the CLI will report success before the operation completes.
- **Recommendation**: Add `await` before both calls: `await runLinkCommand(resolveCwd())` and `await runUnlinkCommand(resolveCwd())`.

### Issue 11: `harness-runtime` tool execution has no timeout protection
- **File**: `packages/aai-server/src/_harness-runtime.ts:141-163`
- **Severity**: Medium
- **Description**: The `executeTool` function in the harness runtime executes agent-provided tool code (`tool.execute(parsed, ctx)`) without any timeout. If the tool hangs (e.g., infinite loop in user code, or a deadlocked network call to the sidecar), the isolate's HTTP server thread is blocked and the tool call RPC from the host will only fail when the host's `TOOL_TIMEOUT_MS` (30s) fires. This is less severe because the host has a timeout, but the isolate thread remains blocked until the isolate is disposed.
- **Recommendation**: Add a `Promise.race` with a timeout inside the isolate's `executeTool`, matching or slightly under the host's `TOOL_TIMEOUT_MS`, to cleanly fail the tool call.

### Issue 12: Missing error handling for `resp.json()` in `web_search` tool
- **File**: `packages/aai/builtin-tools.ts:78`
- **Severity**: Low
- **Description**: In `createWebSearch`, `await resp.json()` is called without try/catch after confirming `resp.ok`. If the Brave API returns a 200 with invalid JSON (e.g., empty body, HTML error page from a CDN), this will throw an unhandled error. The `fetch_json` tool (line 159-163) correctly wraps `resp.json()` in a try/catch, but `web_search` does not.
- **Recommendation**: Wrap `resp.json()` in a try/catch like the `fetch_json` tool does.

### Issue 13: `secret.ts` `runSecretList` trusts server response shape without validation
- **File**: `packages/aai-cli/secret.ts:48`
- **Severity**: Low
- **Description**: `resp.json()` is cast directly to `{ vars: string[] }` with a type assertion and no runtime validation. If the server returns an unexpected shape (e.g., `{ vars: null }` or `{ error: "..." }`), the subsequent `vars.length` access will throw an unhandled TypeError with no meaningful error message.
- **Recommendation**: Use Zod or a manual check to validate the response shape before accessing `vars`.

### Issue 14: Race condition between `onReset` and `connectAndSetup`
- **File**: `packages/aai/session.ts:227-237`
- **Severity**: Low
- **Description**: `onReset` calls `ctx.s2s?.close()` to close the current S2S connection, then fires `connectAndSetup()` to create a new one. However, if `onReset` is called rapidly in succession, multiple `connectAndSetup` calls can be in flight simultaneously. There is no cancellation of the previous `connectAndSetup`. The `sessionAbort` check on line 185 only guards against `stop()` racing with `start()`, not against multiple resets. The last `connectAndSetup` to complete will set `ctx.s2s`, but earlier completions could overwrite it.
- **Recommendation**: Add a generation counter or cancellation token to `connectAndSetup` so that only the most recent invocation sets `ctx.s2s`.

### Issue 15: `playAudioDone` swallows all errors including programming bugs
- **File**: `packages/aai-ui/client-handler.ts:154-162`
- **Severity**: Low
- **Description**: The `.catch(() => { /* swallow */ })` on `io.done()` suppresses all errors, including potential programming errors (null reference, type errors). While swallowing audio playback errors is reasonable (the audio may have been flushed/cancelled), the catch block provides no logging, making it impossible to diagnose audio playback issues in production.
- **Recommendation**: At minimum, log a warning in the catch block: `.catch((err) => { console.warn("Audio playback done failed:", err); })`.
