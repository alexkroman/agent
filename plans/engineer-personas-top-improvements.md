# Top 10 Improvements by Engineer Consensus (Condorcet Vote)

**Status:** draft
**Date:** 2026-03-26
**Method:** 10 engineer personas each proposed 10-14 improvements after exploring the codebase. All ~130 suggestions were deduplicated into 50 canonical items. Each persona then ranked their top 10. Results computed via Condorcet/Copeland method (pairwise majority wins).

## Personas

| # | Persona | Focus |
|---|---------|-------|
| 1 | Senior Frontend Engineer | UI/UX, accessibility, component architecture |
| 2 | Senior Backend/Systems Engineer | Server performance, connections, resource management |
| 3 | Security Engineer | Attack surfaces, credentials, isolation boundaries |
| 4 | Developer Experience / CLI Engineer | Onboarding friction, CLI ergonomics, error messages |
| 5 | Test/Quality Engineer | Coverage, property testing, meaningful assertions |
| 6 | API Design Engineer | Type safety, composability, progressive disclosure |
| 7 | Observability/SRE Engineer | Logging, metrics, tracing, debugging |
| 8 | Build/Infrastructure Engineer | Build times, dependencies, CI/CD, monorepo health |
| 9 | Product-Minded Engineer | End users, use cases, feature gaps, developer journey |
| 10 | TypeScript/Type System Engineer | Type safety, generics, discriminated unions |

## Final Top 10

### #1. Graceful server shutdown with timeout
**Pairwise wins: 37/37 (Condorcet winner) | Voted by 8/10 engineers**

`server.ts` `close()` calls `Promise.allSettled()` on all session `stop()` promises with no timeout. If any session's `stop()` hangs, the entire shutdown blocks indefinitely. Add a configurable shutdown timeout (e.g. 30s) and force-close remaining sessions.

---

### #2. Session initialization timeout
**Pairwise wins: 36/37 | Voted by 7/10 engineers**

`session.start()` in `ws-handler.ts` is awaited without a timeout. If S2S connection setup hangs, the client connection hangs forever. Wrap in `Promise.race()` with a configurable timeout (e.g. 10s).

---

### #3. Session cleanup race condition fix
**Pairwise wins: 35/37 | Voted by 6/10 engineers**

`session.stop()` doesn't fully drain in-flight hooks before closing the S2S connection. A hook launched between the `turnPromise` check and `s2s.close()` may try to send on a closed connection. Ensure `drainHooks()` completes before closing.

---

### #4. WebSocket backpressure handling
**Pairwise wins: 34/37 | Voted by 6/10 engineers**

`safeSend()` in `ws-handler.ts` sends without checking `ws.bufferedAmount`. Under sustained audio streaming, this causes unbounded memory growth. Add backpressure detection and a bounded send queue.

---

### #5. Handle S2S disconnect during tool execution
**Pairwise wins: 33/37 | Voted by 6/10 engineers**

When S2S drops mid-tool-call, `finishToolCall()` is never called. The tool remains in `pendingTools` indefinitely. Wire S2S close/error events to fail in-flight tool calls with a connection error.

---

### #6. SQLite KV store close/cleanup method
**Pairwise wins: 31/37 | Voted by 5/10 engineers**

`sqlite-kv.ts` creates a cleanup interval that's never cleared. Even with `.unref()`, it persists for the process lifetime. Expose a `close()` method that clears the interval and closes the database.

---

### #7. Memory leak and resource cleanup detection
**Pairwise wins: 30/37 | Voted by 6/10 engineers**

No tests verify proper cleanup of WebSocket connections, timers, audio worklet nodes, or media streams on disconnect. Add systematic resource tracking tests to catch leaks before production.

---

### #8. Structured logging
**Pairwise wins: 28/37 | Voted by 4/10 engineers**

The `consoleLogger` in `runtime.ts` outputs unstructured `console.log/warn/error`. Replace with a structured JSON logger that includes timestamp, level, context, trace_id, and span_id for production diagnostics.

---

### #9. `aai doctor` diagnostic command
**Pairwise wins: 26/37 | Voted by 4/10 engineers**

No single command verifies environment health. Add `aai doctor` that checks: Node version, API key validity, dependency health, `.env` loading, port availability, and `agent.ts` syntax. Print results with actionable fix suggestions.

---

### #10. S2S idle timeout and connection pooling
**Pairwise wins: 25/37 | Voted by 4/10 engineers**

Each session creates a new S2S WebSocket with no keepalive or idle timeout. If a client disconnects mid-session, the S2S connection can remain open indefinitely. Add configurable idle timeout and heartbeat mechanism.

---

## Honorable Mentions (11-15)

| Rank | Item | Wins | Description |
|------|------|------|-------------|
| 11 | Correlation IDs across session lifecycle | 24/37 | OTel baggage propagation through sidecar calls |
| 12 | Observable failure handling | 23/37 | Replace silent `.catch()` with metrics/logging |
| 13 | Env var status in dev startup | 23/37 | Show loaded/missing vars when running `aai dev` |
| 14 | Explicit tool error codes | 22/37 | Distinguish timeout vs validation vs execution errors |
| 15 | Consistent discriminated unions | 19/37 | Standardize all API result types with `type` field |

## Key Themes

The top 10 clusters into three themes:

1. **Connection lifecycle safety** (#1, #2, #3, #5, #10): Session start/stop, S2S disconnect, and shutdown all have timeout or race condition gaps that can cause hangs or resource leaks in production.

2. **Resource management** (#4, #6, #7): WebSocket buffers, KV cleanup, and memory leak detection address unbounded resource growth.

3. **Operational readiness** (#8, #9): Structured logging and diagnostics are prerequisites for running in production.
