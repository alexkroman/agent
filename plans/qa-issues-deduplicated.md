# Deduplicated QA Issues — AAI Voice Agent SDK

After collecting 100 issues from 10 QA engineer subagents, the following 45 unique issues remain after deduplication and merging overlapping findings.

---

## Issue 1: Unsafe passthrough cast in S2S message parsing
- **Files**: `packages/aai/s2s.ts:84-85`
- **Description**: The `passthrough` function casts arbitrary `Record<string, unknown>` directly to `S2sServerMessage` without validation, bypassing type checking and allowing malformed messages downstream.
- **Category**: Type Safety
- **Found by**: Pedant

## Issue 2: Missing validation of required string fields in S2S parser
- **Files**: `packages/aai/s2s.ts:88-92`
- **Description**: `requireFields()` checks fields are strings but then immediately casts to `S2sServerMessage` without narrowing. Messages with incomplete fields pass as valid.
- **Category**: Type Safety
- **Found by**: Pedant

## Issue 3: Hook name mismatch between public type and internal invoker
- **Files**: `packages/aai/middleware.ts:34`, `packages/aai/types.ts:129`, `packages/aai-server/src/_harness-runtime.ts:242`
- **Description**: Public `Middleware` type uses `beforeInput` but internal `HookInvoker` uses `filterInput`, creating an undocumented translation layer that confuses contributors.
- **Category**: Type Safety / DX
- **Found by**: Pedant

## Issue 4: sendUpdate accepts `unknown` with no serialization guard
- **Files**: `packages/aai/types.ts:278`
- **Description**: `sendUpdate(data: unknown): void` has no guarantee the data is JSON-serializable. Circular references, functions, or BigInts would crash at runtime.
- **Category**: Type Safety
- **Found by**: Pedant

## Issue 5: Missing validation of maxSteps return value
- **Files**: `packages/aai-server/src/_harness-runtime.ts:226`
- **Description**: `agent.maxSteps(ctx)` result is used without validating it's a positive integer. Could return -1, 0, NaN, or non-integer.
- **Category**: Validation
- **Found by**: Pedant

## Issue 6: Unsafe tool call args casting in harness middleware
- **Files**: `packages/aai-server/src/_harness-runtime.ts:255-256`
- **Description**: `req.step?.toolCalls[0]?.args` is cast to `Record<string, unknown>` without checking toolCalls is non-empty, potentially passing undefined to middleware.
- **Category**: Type Safety
- **Found by**: Pedant

## Issue 7: Middleware args transformation bypasses tool parameter schema
- **Files**: `packages/aai/middleware-core.ts:129`
- **Description**: Middleware can return transformed args that don't match the tool's parameter schema. No runtime validation ensures conformance.
- **Category**: Validation
- **Found by**: Pedant

## Issue 8: Race condition in deploy lock — doesn't prevent concurrent delete
- **Files**: `packages/aai-server/src/deploy.ts:7-30`, `packages/aai-server/src/delete.ts:8-20`
- **Description**: Deploy lock serializes deploys for same slug but doesn't account for concurrent deletes. Delete can race with a terminating sandbox from deploy, causing state corruption.
- **Category**: Concurrency
- **Found by**: Breaker, Concurrency Expert, Test Skeptic

## Issue 9: Sandbox termination race with idle eviction
- **Files**: `packages/aai-server/src/sandbox-slots.ts:65-84`
- **Description**: Idle timer deletes `slot.sandbox` and starts async termination. Concurrent `ensureAgent()` can retrieve sandbox just before deletion, then use a terminating instance.
- **Category**: Concurrency
- **Found by**: Breaker, Concurrency Expert

## Issue 10: Concurrent manifest reads during putEnv — lost update
- **Files**: `packages/aai-server/src/bundle-store-tigris.ts:218-227`
- **Description**: `putEnv` reads manifest, modifies, writes back without optimistic locking. Concurrent calls overwrite each other, losing environment variables.
- **Category**: Concurrency / Data Loss
- **Found by**: Breaker

## Issue 11: Unhandled isolate crash leaves in-flight tool calls hanging
- **Files**: `packages/aai-server/src/sandbox.ts:147-154`
- **Description**: If the isolate crashes after port announcement, in-flight tool calls have no timeout enforcement, causing them to hang indefinitely.
- **Category**: Reliability
- **Found by**: Breaker

## Issue 12: Request body size bypass via chunked encoding
- **Files**: `packages/aai-server/src/_harness-runtime.ts:316-332`
- **Description**: `readBody` calls `req.destroy()` on oversize but doesn't wait for stream drain. Partial chunks over 5MB can crash the server or corrupt subsequent requests.
- **Category**: Security / Reliability
- **Found by**: Breaker

## Issue 13: Vector store upsert has no idempotency guarantee
- **Files**: `packages/aai-server/src/sandbox-sidecar.ts:158-161`
- **Description**: No transaction semantics on vector upsert. Network failure mid-upsert + client retry = duplicate vectors or partial data.
- **Category**: Data Integrity
- **Found by**: Breaker

## Issue 14: WebSocket upgrade sends incomplete HTTP responses
- **Files**: `packages/aai-server/src/index.ts:90,97`
- **Description**: Raw `socket.write("HTTP/1.1 401 ...\r\n\r\n")` without Content-Length, Connection, or WWW-Authenticate headers. Violates HTTP/1.1 spec.
- **Category**: Protocol Compliance
- **Found by**: API Purist, Breaker

## Issue 15: CORS wildcard origin defeats CSRF protection
- **Files**: `packages/aai-server/src/orchestrator.ts:67-71`
- **Description**: When `allowedOrigins` includes `"*"`, user-supplied origin is reflected. Combined with missing origin returning `"*"`, this defeats CSRF protection on state-changing endpoints.
- **Category**: Security
- **Found by**: Security Hawk, API Purist

## Issue 16: AWS/Redis credentials default to empty strings instead of failing fast
- **Files**: `packages/aai-server/src/index.ts:36-45`
- **Description**: S3 and Redis credentials fall back to `""` instead of throwing at startup. Server starts in broken state with silent failures.
- **Category**: Configuration / Ops
- **Found by**: Security Hawk, Ops Engineer

## Issue 17: Vector store filter parameter passed without validation
- **Files**: `packages/aai-server/src/vector.ts:32-43`, `packages/aai-server/src/vector-handler.ts:29-32`
- **Description**: User-supplied `filter` is forwarded directly to Upstash Vector API without validation. Could enable extraction from other namespaces.
- **Category**: Security
- **Found by**: Security Hawk

## Issue 18: Secret PUT endpoint allows overwriting reserved keys
- **Files**: `packages/aai-server/src/secret-handler.ts:38`
- **Description**: `handleSecretSet` merges user-provided key-value object without checking for reserved keys like `ASSEMBLYAI_API_KEY`. Attacker could override platform credentials.
- **Category**: Security
- **Found by**: Security Hawk

## Issue 19: Missing rate limiting on authentication endpoints
- **Files**: `packages/aai-server/src/middleware.ts:23-41`
- **Description**: API key verification has no rate limiting. Attackers can make unlimited brute-force attempts. Timing-safe comparison is good but insufficient alone.
- **Category**: Security
- **Found by**: Security Hawk

## Issue 20: Unvalidated S3 endpoint URL allows SSRF via env var
- **Files**: `packages/aai-server/src/index.ts:37`
- **Description**: `AWS_ENDPOINT_URL_S3` is passed directly to S3 client. Attacker with env var control could redirect S3 operations to a malicious endpoint.
- **Category**: Security
- **Found by**: Security Hawk

## Issue 21: Duplicate sandbox termination logic (DRY violation)
- **Files**: `packages/aai-server/src/deploy.ts:56-72`, `packages/aai-server/src/delete.ts:8-19`
- **Description**: Nearly identical code for terminating sandbox active/initializing instances. DRY violation makes maintenance harder and invites divergence bugs.
- **Category**: Code Quality
- **Found by**: Perfectionist

## Issue 22: Console.log/warn used instead of structured logger
- **Files**: `packages/aai-server/src/sandbox.ts:361`, `packages/aai-server/src/deploy.ts:58`, `packages/aai/server.ts:207-221`
- **Description**: Raw console calls in production code paths. Auth failures silently destroy sockets without logging. Makes production debugging impossible.
- **Category**: Observability
- **Found by**: Perfectionist, User Advocate, Ops Engineer

## Issue 23: Empty catch blocks in delete operations swallow errors
- **Files**: `packages/aai-server/src/delete.ts:10-18`
- **Description**: `.catch(() => {})` silently swallows sandbox termination errors with no logging. Hides critical cleanup failures.
- **Category**: Observability / Reliability
- **Found by**: Perfectionist, Test Skeptic, Ops Engineer

## Issue 24: Silent middleware errors with no user feedback
- **Files**: `packages/aai/middleware-core.ts:29,56,79,124,161`
- **Description**: Middleware hook errors are caught and only `console.warn()`'d. Users without logging configured get zero feedback on failed middleware.
- **Category**: DX
- **Found by**: User Advocate

## Issue 25: Tool error context lost — no tool name or args in validation errors
- **Files**: `packages/aai/worker-entry.ts:96-101`
- **Description**: When tool arg validation fails, only Zod error messages shown. No context about which tool failed or what args were provided.
- **Category**: DX
- **Found by**: User Advocate

## Issue 26: Vector store lazy init fails late with confusing error
- **Files**: `packages/aai/lancedb-vector.ts:120-126`
- **Description**: Missing `OPENAI_API_KEY` only errors when vector store is first used (lazy init), not at startup. Developers see confusing runtime failures.
- **Category**: DX
- **Found by**: User Advocate

## Issue 27: KV expireIn units footgun — milliseconds easily confused with seconds
- **Files**: `packages/aai/kv.ts:72-73`
- **Description**: `expireIn` param is in milliseconds but this is easy to miss. No runtime guard against accidentally passing seconds (which would set TTL to 1/1000th of intended).
- **Category**: DX
- **Found by**: User Advocate

## Issue 28: Unbounded conversation history creates GC pressure
- **Files**: `packages/aai/session.ts:232-236`
- **Description**: `pushMessages` trims via `.slice(-maxHistory)` creating a new array every time the limit is exceeded. Frequent allocation/GC during long sessions.
- **Category**: Performance
- **Found by**: Performance Nut

## Issue 29: Unbounded pendingTools array — memory leak
- **Files**: `packages/aai/session.ts:103,166-167`
- **Description**: `pendingTools` grows indefinitely in long sessions with many tool invocations. No eviction or max size bound. `maxHistory` protects messages but not pending tools.
- **Category**: Performance / Memory Leak
- **Found by**: Performance Nut

## Issue 30: SQLite KV list/keys loads all rows before pagination
- **Files**: `packages/aai/sqlite-kv.ts:137-146,154-171`
- **Description**: `list()` and `keys()` fetch ALL matching rows, then apply in-memory sort/limit. Glob query on large prefix loads millions of rows into memory.
- **Category**: Performance
- **Found by**: Performance Nut

## Issue 31: Sessions Map potential memory leak — no explicit cleanup
- **Files**: `packages/aai/server.ts:132,137-143`
- **Description**: `sessions` Map populated on connect but no explicit `sessions.delete(sid)` on disconnect. If cleanup races or exceptions prevent removal, unbounded growth.
- **Category**: Memory Leak
- **Found by**: Performance Nut

## Issue 32: No error path tests for store.deleteAgent failure
- **Files**: `packages/aai-server/src/delete.ts:22`
- **Description**: `handleDelete` calls `store.deleteAgent(slug)` without error handling. Tests never verify store failure scenarios — zero coverage on this path.
- **Category**: Test Coverage
- **Found by**: Test Skeptic

## Issue 33: Deploy concurrent request lock never tested for races
- **Files**: `packages/aai-server/src/deploy.ts:7-30`
- **Description**: `deployLocks` map prevents concurrent deploys but tests only test sequential deploys. Lock cleanup at line 29 has no failure scenario coverage.
- **Category**: Test Coverage
- **Found by**: Test Skeptic

## Issue 34: Health check endpoint doesn't verify dependencies
- **Files**: `packages/aai-server/src/orchestrator.ts:104`
- **Description**: `/health` returns `{ status: "ok" }` without checking Redis, S3, or Vector store. Creates false positives in load balancer health checks.
- **Category**: Ops
- **Found by**: Ops Engineer

## Issue 35: KV store operations have no timeout or retry logic
- **Files**: `packages/aai-server/src/kv.ts:40-104`
- **Description**: All Redis operations lack timeout/retry. Transient network issues cause immediate failures with no exponential backoff.
- **Category**: Reliability
- **Found by**: Ops Engineer

## Issue 36: Graceful shutdown doesn't drain WebSocket connections
- **Files**: `packages/aai-server/src/index.ts:126-143`
- **Description**: Shutdown handler closes WebSocket server immediately without draining active connections. No grace period before killing isolates.
- **Category**: Ops
- **Found by**: Ops Engineer

## Issue 37: Sidecar server startup has no timeout — can hang forever
- **Files**: `packages/aai-server/src/sandbox-sidecar.ts:228-231`
- **Description**: `startSidecarServer()` waits for "listening" event with no timeout. If server never emits it, the promise hangs indefinitely.
- **Category**: Concurrency / Reliability
- **Found by**: Concurrency Expert

## Issue 38: S2S connection generation guard has ordering race
- **Files**: `packages/aai/session.ts:299-334`
- **Description**: Between abort signal check and setting `ctx.s2s = handle`, another `connectAndSetup()` invocation could complete, causing intermediate state corruption despite generation checks.
- **Category**: Concurrency
- **Found by**: Concurrency Expert

## Issue 39: onDisconnect hook fires without await before session teardown
- **Files**: `packages/aai/session.ts:349`
- **Description**: `fireHook("onDisconnect")` not awaited in `stop()`. Hook may perform KV writes that race with session cleanup. `ctx.s2s` may no longer exist.
- **Category**: Concurrency
- **Found by**: Concurrency Expert

## Issue 40: WebSocket message buffer race during session ready transition
- **Files**: `packages/aai/ws-handler.ts:183-197`
- **Description**: Between `session.start()` resolving and `sessionReady = true`, incoming messages queue in buffer. If error occurs in the gap, buffered messages are lost when buffer is nulled.
- **Category**: Concurrency
- **Found by**: Concurrency Expert

## Issue 41: DELETE returns 200 instead of 204 No Content
- **Files**: `packages/aai-server/src/delete.ts:26`
- **Description**: DELETE handler returns `c.json({ ok: true })` with 200. REST convention: successful DELETE should return 204 No Content.
- **Category**: API Design
- **Found by**: API Purist

## Issue 42: POST /deploy returns 200 instead of 201 Created
- **Files**: `packages/aai-server/src/deploy.ts:94`
- **Description**: Deploy endpoint creates resources but returns 200 instead of 201 Created. Violates REST conventions.
- **Category**: API Design
- **Found by**: API Purist

## Issue 43: Inconsistent JSON response structures across endpoints
- **Files**: `packages/aai-server/src/secret-handler.ts:24,43,61`
- **Description**: Secret endpoints return different response shapes: `{ vars }`, `{ ok, keys }`, `{ ok }`. Inconsistent structures make client code fragile.
- **Category**: API Design
- **Found by**: API Purist

## Issue 44: POST endpoints missing Content-Type request validation
- **Files**: `packages/aai-server/src/deploy.ts:39`, `packages/aai-server/src/kv-handler.ts:14`
- **Description**: POST endpoints call `c.req.json()` without validating Content-Type is `application/json`. Allows malformed requests with wrong content types.
- **Category**: API Design
- **Found by**: API Purist

## Issue 45: WebSocket upgrade failure with no HTTP response for invalid sandbox
- **Files**: `packages/aai-server/src/index.ts:109-112`
- **Description**: When sandbox resolution fails, `socket.destroy()` is called with no HTTP response. Client receives zero indication of why the upgrade failed.
- **Category**: API Design / DX
- **Found by**: API Purist
