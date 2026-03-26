# Performance QA Report

## Summary

Reviewed all four packages (aai, aai-ui, aai-cli, aai-server) for performance and resource management issues. Found 15 issues ranging from unbounded memory growth in session state, inefficient polling loops in code execution, to missing cleanup of event listeners and redundant allocations on hot paths. The most critical issues involve unbounded growth of `conversationMessages` arrays in long-running sessions and a busy-wait polling loop in the `run_code` isolate execution path.

## Issues Found

### Issue 1: Unbounded conversationMessages growth in long-running sessions
- **File**: packages/aai/_session-otel.ts:175, packages/aai/session.ts:240
- **Severity**: High
- **Description**: Every user transcript and assistant response is pushed to `ctx.conversationMessages` without any size limit. In a long-running voice session (e.g., a customer service agent running for hours), this array grows indefinitely, consuming increasing memory and making each `executeTool` call pass a larger and larger `messages` array. The `onReset` handler at session.ts:228 clears it, but normal operation never trims it.
- **Recommendation**: Implement a sliding window or maximum message count for `conversationMessages`. For example, keep only the last N messages (e.g., 200) and drop older entries, or provide a configurable `maxHistory` option in `SessionOptions`.

### Issue 2: Busy-wait polling loop in executeInIsolate
- **File**: packages/aai/builtin-tools.ts:300-304
- **Severity**: High
- **Description**: The `executeInIsolate` function uses a `while (Date.now() < deadline)` loop with `setTimeout(r, 50)` polling to detect isolate completion. This polls every 50ms for up to 5 seconds, consuming CPU on every `run_code` tool invocation. The loop runs up to 100 iterations even when the isolate finishes quickly, since it re-checks `stdoutChunks.length > 0 || finished` each tick.
- **Recommendation**: Replace the polling loop with a promise-based approach. Use a `Promise` that resolves when `onStdio` captures output or when `finished` is set to true, and race it against a timeout. This eliminates unnecessary wakeups.

### Issue 3: New Set created on every tool call in checkTurnLimits
- **File**: packages/aai/session.ts:123
- **Severity**: Medium
- **Description**: `checkTurnLimits` creates a `new Set(turnConfig.activeTools)` on every tool call within a turn. Since `activeTools` does not change within a single turn's `resolveTurnConfig` result, this allocation is repeated unnecessarily for each tool call in a multi-tool turn.
- **Recommendation**: Cache the `Set` from `resolveTurnConfig` at the turn level (e.g., on the `turnConfig` object or as a local variable in the caller) rather than reconstructing it per tool call.

### Issue 4: S3 BundleStore cache grows unboundedly
- **File**: packages/aai-server/src/bundle-store-tigris.ts:87
- **Severity**: Medium
- **Description**: The `cache` Map in `createBundleStore` grows without limit. Every S3 object fetched or stored is cached by key with its data and etag. For a platform with many agents, each with worker code, manifest, and client files, this cache will grow indefinitely. Worker bundles can be large (hundreds of KB), so memory consumption could become significant.
- **Recommendation**: Implement an LRU eviction strategy or a maximum cache size. Alternatively, use a TTL-based cache that expires entries after a configurable duration.

### Issue 5: Zod validation on every S2S message (non-audio hot path)
- **File**: packages/aai/s2s.ts:311
- **Severity**: Medium
- **Description**: Every non-audio S2S message is parsed through `S2sServerMessageSchema.safeParse(raw)`, which involves Zod's discriminated union validation. While audio messages are fast-pathed (line 309), all other messages (including high-frequency `transcript.agent.delta` and `transcript.user.delta` events) go through full Zod parsing. In a busy session with rapid transcript deltas, this adds unnecessary overhead.
- **Recommendation**: Consider a lightweight type-check for known high-frequency message types (e.g., check `obj.type` directly and validate only the specific fields needed) before falling back to full Zod parsing for less common messages.

### Issue 6: String concatenation for agent utterance deltas in ClientHandler
- **File**: packages/aai-ui/client-handler.ts:67-69
- **Severity**: Medium
- **Description**: On each `chat_delta` event, the agent utterance is rebuilt via template literal concatenation: `` `${this.#agentUtterance.value} ${e.text}` ``. For long agent responses with many deltas, this creates a new string on each delta, with cost proportional to the total accumulated length (O(n^2) overall for n deltas of similar size). This runs on the client and triggers reactive updates each time.
- **Recommendation**: Accumulate deltas in an array and join only when the final value is needed (e.g., on `chat` event), or use a mutable buffer. Alternatively, since this is a Preact signal that triggers re-renders, at minimum batch multiple rapid deltas.

### Issue 7: Missing removeEventListener cleanup on S2S WebSocket
- **File**: packages/aai/s2s.ts:266-354
- **Severity**: Medium
- **Description**: The `connectS2s` function registers event listeners on the WebSocket using `addEventListener` but never removes them. While the WebSocket eventually gets garbage collected after close, the listeners remain attached until then. If `close()` is called on the handle but the underlying WebSocket object is still referenced somewhere, the closures (which capture `emitter`, `log`, `connectionSpan`, etc.) prevent those objects from being GC'd.
- **Recommendation**: Store listener references and remove them in the `close()` method of the handle, or use an AbortController signal to automatically remove listeners when the handle is closed.

### Issue 8: Per-session state map never cleaned in edge cases
- **File**: packages/aai/direct-executor.ts:99
- **Severity**: Medium
- **Description**: The `sessionState` Map is cleaned in `hookInvoker.onDisconnect` (line 145), but if `onDisconnect` throws or is never called (e.g., due to a crash or the session being abruptly dropped without going through `session.stop()`), the entry persists forever. Over time with many sessions, this can leak memory in the self-hosted server.
- **Recommendation**: Add a periodic sweep or tie cleanup to the session map in `server.ts` (line 71). When a session is removed from the `sessions` Map, also ensure `sessionState` is cleaned up, regardless of whether `onDisconnect` succeeds.

### Issue 9: Unnecessary copy in audio capture buffer
- **File**: packages/aai-ui/audio.ts:108
- **Severity**: Low
- **Description**: `capBuf.slice(0, capOffset).buffer` creates a copy of the captured audio data to send. The `slice` call allocates a new `Uint8Array` and then `.buffer` extracts the underlying `ArrayBuffer`. Since the data is immediately sent over WebSocket and the local buffer is reused, this extra copy is unavoidable for correctness but could be optimized with `ArrayBuffer.transfer` or by using a dedicated send buffer that is swapped rather than copied.
- **Recommendation**: Consider using double-buffering (two pre-allocated buffers that swap) to avoid the `slice` allocation on each send. Or use `Uint8Array.prototype.slice` followed by transferring ownership to the WebSocket via the transferable API in `postMessage`.

### Issue 10: hashApiKey called on every authenticated request without caching
- **File**: packages/aai-server/src/auth.ts:8
- **Severity**: Medium
- **Description**: `hashApiKey` performs a SHA-256 digest using `crypto.subtle.digest` on every call. Since `verifySlugOwner` is invoked for every authenticated API request (deploy, secret management, metrics), the same API key is hashed repeatedly. While SHA-256 is fast, this is a Web Crypto API call that involves async overhead for each request.
- **Recommendation**: Cache the hash result for recently seen API keys using a small LRU map (e.g., 100 entries). Since API keys don't change, the hash is deterministic and safe to cache.

### Issue 11: Zod schema validation on every client WebSocket message
- **File**: packages/aai/ws-handler.ts:107
- **Severity**: Low
- **Description**: Every text message from the client goes through `ClientMessageSchema.safeParse(json)`. While client messages are less frequent than S2S messages, this still creates Zod validation overhead for simple messages like `{ type: "audio_ready" }` or `{ type: "cancel" }`. The `history` message validation is warranted (it has arrays), but simple signal messages could be checked with a lightweight switch.
- **Recommendation**: For simple message types (`audio_ready`, `cancel`, `reset`), check the `type` field directly before falling back to full Zod parsing. Only use Zod for `history` messages that require structural validation.

### Issue 12: Redis SCAN-then-GET pattern in KV list is not atomic
- **File**: packages/aai-server/src/kv.ts:72-101
- **Severity**: Medium
- **Description**: The `list` method first SCANs all matching keys, then sorts them, applies pagination, and pipelines GET for the selected keys. The SCAN operation itself can be expensive for large keyspaces (it iterates the entire keyspace), and the results are not paginated at the Redis level. If an agent has thousands of keys matching a prefix, all keys are loaded into memory, sorted, and only then is the `limit` applied. Additionally, keys found by SCAN may have been deleted by the time the pipeline GET runs.
- **Recommendation**: Consider using Redis sorted sets or a key-range approach to support server-side pagination. At minimum, pass a `COUNT` hint to SCAN to reduce per-iteration work, and handle `null` GET results gracefully (which is already done at line 91).

### Issue 13: filterOutput hook called per-delta on streaming transcript
- **File**: packages/aai/_session-otel.ts:200-207
- **Severity**: Medium
- **Description**: The `filterOutput` middleware hook is invoked asynchronously for every `agent_transcript_delta` event. In a streaming response, deltas arrive rapidly (potentially dozens per second). Each invocation is a separate async call that, in platform mode, makes an HTTP round-trip to the isolate. This can create a backlog of concurrent filter calls and add significant latency to transcript streaming.
- **Recommendation**: Batch deltas and run `filterOutput` on accumulated text at a lower frequency (e.g., debounce to every 100ms), or only run `filterOutput` on the final `agent_transcript` event. Alternatively, document that `filterOutput` on deltas may have performance implications.

### Issue 14: New AbortController created per sidecar Zod schema parse
- **File**: packages/aai-server/src/sandbox.ts:175-179
- **Severity**: Low
- **Description**: Each `callIsolate` invocation creates a new `AbortSignal.timeout()` which internally creates an AbortController and a timer. For tool execution calls that happen frequently during a session, this is a minor but unnecessary overhead. The signal is created even before the fetch starts.
- **Recommendation**: This is a minor issue. `AbortSignal.timeout` is the idiomatic approach and the overhead is negligible. No action needed unless profiling shows this as a bottleneck.

### Issue 15: buildSystemPrompt called once per session but recreates date string
- **File**: packages/aai/system-prompt.ts:37-42
- **Severity**: Low
- **Description**: `buildSystemPrompt` is called once per session creation, which is acceptable. However, `new Date().toLocaleDateString(...)` is called each time. For many concurrent sessions created within the same day, this produces identical results. This is not a significant issue but is a minor inefficiency.
- **Recommendation**: Cache the date string and invalidate it daily, or accept the negligible overhead since it runs only once per session.
