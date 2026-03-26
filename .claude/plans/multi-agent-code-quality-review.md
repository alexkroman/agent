# Plan: Multi-Agent Code Quality Review

**Status:** draft
**Created:** 2026-03-26
**Updated:** 2026-03-26

## Context

Ten engineers each independently reviewed the AAI codebase from different
specialization angles. This plan consolidates their findings into actionable
improvements organized by priority. The review covers all four workspace
packages (`aai`, `aai-ui`, `aai-cli`, `aai-server`).

### Reviewers

| # | Role | Focus Area |
|---|------|------------|
| 1 | Security Engineer | Input validation, injection, auth, SSRF, timing attacks |
| 2 | Reliability Engineer | Error handling, unhandled promises, resource cleanup |
| 3 | TypeScript Engineer | Type safety, `any` usage, unsafe assertions |
| 4 | Performance Engineer | Allocations, memory leaks, hot-path inefficiencies |
| 5 | API Design Engineer | Public API consistency, docs, naming, abstractions |
| 6 | QA/Test Engineer | Test coverage gaps, weak assertions, missing edge cases |
| 7 | DRY/Maintainability Engineer | Code duplication, shared utilities |
| 8 | DevOps/Infra Engineer | Dependencies, build config, bundle size |
| 9 | SRE/Observability Engineer | Logging, metrics, correlation IDs, debugging |
| 10 | Distributed Systems Engineer | Race conditions, state machines, protocol correctness |

---

## Goals

- [ ] Fix critical security issues (CORS defaults, rate limiting, SSRF gaps)
- [ ] Resolve race conditions in barge-in and session lifecycle
- [ ] Improve error handling (eliminate silent promise swallowing)
- [ ] Strengthen type safety (eliminate unsafe `as` casts)
- [ ] Optimize hot-path performance (UI array spreads, audio encoding)
- [ ] Improve observability (structured logging, correlation IDs)
- [ ] Reduce code duplication across CLI commands
- [ ] Improve public API consistency and documentation
- [ ] Expand test coverage for under-tested modules
- [ ] Clean up dependency hygiene

---

## P0 — Critical (Security & Correctness)

### Security

- [ ] **CORS default too permissive**: `orchestrator.ts:63-77` defaults to
  `"*"` origin. Change default to require explicit configuration.
  *(Engineer 1, #16)*

- [ ] **Missing rate limiting on sensitive endpoints**: `orchestrator.ts` has
  no rate limiting on deploy, delete, or secret management endpoints.
  *(Engineer 1, #18)*

- [ ] **DNS rebinding race in SSRF protection**: `_ssrf.ts:89-106` — resolved
  IP is not re-validated after DNS lookup. Re-validate `isPrivateIp(resolved)`
  after extraction.
  *(Engineer 1, #4)*

- [ ] **Secret key names not validated**: `secret-handler.ts:49` — no regex
  validation on key parameter. Add `z.string().regex(/^[a-zA-Z_]\w*$/)`.
  *(Engineer 1, #6)*

- [ ] **Secret keys logged in plaintext**: `secret-handler.ts:42` logs key
  names. Only log the count of updates.
  *(Engineer 1, #7)*

- [ ] **Vector store filter injection**: `vector-handler.ts:31` passes
  `msg.filter` directly to `vectorStore.query()` without validation.
  *(Engineer 1, #17)*

- [ ] **Windows config file permissions**: `_discover.ts:50-52` skips
  permission enforcement on Windows.
  *(Engineer 1, #20)*

### Concurrency & Correctness

- [ ] **Barge-in filter chain not reset**: `_session-otel.ts:280-288` —
  `replyGeneration` is bumped but `ctx.filterChain` is NOT reset, allowing
  stale `chat_delta` to emit after cancellation. Add
  `ctx.filterChain = Promise.resolve()`.
  *(Engineer 10, #3)*

- [ ] **Tool results leak across reply generations**: `_session-otel.ts:293-296`
  — `sendPending` doesn't verify generation matches when sending tool results.
  Capture generation at `handleReplyDone` entry and verify in `sendPending`.
  *(Engineer 10, #5)*

- [ ] **Race in WebSocket message buffering**: `ws-handler.ts:207-219` —
  between checking `sessionReady` and pushing to `messageBuffer`, session can
  fail, setting buffer to null. Use atomic flag.
  *(Engineer 10, #1)*

- [ ] **Concurrent session state mutation in harness**: `_harness-runtime.ts:121-127`
  — `sessionStates` Map has no protection against concurrent `agent.state()`.
  *(Engineer 10, #6)*

- [ ] **Session state not cleaned on hook errors**: `_harness-runtime.ts:284`
  — `sessionStates.delete()` only runs on `onDisconnect`, not on error paths.
  *(Engineer 10, #18)*

---

## P1 — High (Reliability & Error Handling)

### Error Handling

- [ ] **Fire-and-forget terminate without await**: `secret-handler.ts:12` —
  `slot.sandbox.terminate()` not awaited. Store the termination promise.
  *(Engineer 2, #1; Engineer 2, #18)*

- [ ] **Session cleanup has no timeout**: `ws-handler.ts:225-233` —
  `session.stop()` has no timeout; hangs prevent session map cleanup.
  Add AbortSignal timeout with forced cleanup fallback.
  *(Engineer 2, #4)*

- [ ] **Server startup has no timeout**: `index.ts:70-71` — waiting for
  "listening" event without timeout can hang indefinitely.
  *(Engineer 2, #8)*

- [ ] **Sidecar startup has no timeout**: `sandbox-sidecar.ts:228-231` —
  same issue as server startup.
  *(Engineer 2, #9)*

- [ ] **Deploy handler swallows errors silently**: `deploy.ts:60-66` —
  sandbox termination errors swallowed without logging.
  *(Engineer 2, #6)*

- [ ] **Shutdown doesn't log rejection reasons**: `index.ts:129-136` —
  `Promise.allSettled()` results not inspected.
  *(Engineer 2, #7)*

- [ ] **filterOutput chain not awaited on stop**: `session.ts:343-352` —
  in-flight filter promises cause unhandled rejections after disconnect.
  *(Engineer 10, #12)*

- [ ] **Missing generation guard in barge-in**: `_session-otel.ts:280-288` —
  late-finishing `filterOutput` from interrupted reply can emit after cancel.
  *(Engineer 10, #4)*

### Observability

- [ ] **Middleware errors lack session ID**: `middleware-core.ts` all 5 error
  handlers log without session context. Pass through HookContext.
  *(Engineer 9, #1-2)*

- [ ] **Deploy/cleanup errors completely silent**: `deploy.ts:18,60,66` —
  `.catch(() => {})` blocks have zero logging.
  *(Engineer 9, #4)*

- [ ] **No request ID propagation through KV/Vector ops**: `kv-handler.ts`,
  `vector-handler.ts` — can't correlate failures to HTTP requests.
  *(Engineer 9, #16)*

- [ ] **Missing error classification**: Multiple error logging sites use
  `errorMessage(err)` but don't classify (network/timeout/permission/logic).
  *(Engineer 9, #20)*

---

## P2 — Medium (Type Safety, Performance, API Design)

### Type Safety

- [ ] **Unsafe type assertions in S2S parsing**: `s2s.ts:74-76` —
  `obj.call_id as string` without runtime verification.
  *(Engineer 3, #2)*

- [ ] **Unsafe regex match access**: `_ssrf.ts:62,67-68` — `match[1] as string`
  without checking capture group exists.
  *(Engineer 3, #4)*

- [ ] **Unsafe property access in getServerPort**: `_utils.ts:29-39` — uses
  `as { port: unknown }` without type guard.
  *(Engineer 3, #1)*

- [ ] **Redundant Zod cast**: `sandbox.ts:201` —
  `IsolateConfigSchema.parse(...) as IsolateConfig` is unnecessary.
  *(Engineer 3, #14)*

- [ ] **`.filter(Boolean) as string[]`**: `bundle-store-tigris.ts:135` — use
  `(k): k is string => typeof k === "string"` instead.
  *(Engineer 3, #7)*

### Performance

- [ ] **Array spreads in UI hot paths**: `client-handler.ts:66,78,82-102` —
  every message/tool event creates a full array copy. O(n) per event with
  100+ messages.
  *(Engineer 4, #1)*

- [ ] **O(n^2) delta buffer concatenation**: `client-handler.ts:72` —
  `deltaBuffer.join(" ")` on every `chat_delta`. Only join when needed.
  *(Engineer 4, #2)*

- [ ] **Message history slicing**: `session.ts:235` — use circular buffer
  instead of `slice(-maxHistory)` on every trim.
  *(Engineer 4, #5)*

- [ ] **Missing event listener cleanup**: `s2s.ts:311,366,368,386` and
  `session.ts:200-236` — no explicit `removeEventListener` on reconnect.
  *(Engineer 4, #7,11)*

- [ ] **Metrics rebuilt from scratch per scrape**: `metrics.ts:55-58,140` —
  cache formatted output, invalidate on change.
  *(Engineer 4, #9)*

### API Design

- [ ] **Inconsistent parameter naming in HookInvoker**: `middleware.ts:24-55`
  — mixes `sessionId`/`sid`, `timeoutMs`/`ms`.
  *(Engineer 5, #3)*

- [ ] **ToolContext bundles too many concerns**: `types.ts:255-290` — 8
  different capabilities in one type. Consider capabilities-based design.
  *(Engineer 5, #4)*

- [ ] **Inconsistent error result formats in built-in tools**: `builtin-tools.ts:74-103`
  — some return `{ error }` objects, others use `toolError()` strings.
  *(Engineer 5, #1)*

- [ ] **Duplicate ToolCallInterceptResult types**: `types.ts:32-36` vs
  `middleware-core.ts:34-39` — nearly identical with subtle differences.
  *(Engineer 5, #10)*

- [ ] **Missing validation on `maxHistory`**: `session.ts:71-74` — accepts
  negative or NaN without validation.
  *(Engineer 5, #11)*

- [ ] **Confusing `resetState()` vs `reset()` naming**: `session.ts:180-183`
  — both clear state, one reconnects. Rename for clarity.
  *(Engineer 5, #12)*

---

## P3 — Low (Code Duplication, Polish)

### Code Duplication

- [ ] **Duplicated HTTP client in CLI**: `_deploy.ts`, `_delete.ts`,
  `secret.ts`, `rag.ts` all construct fetch with auth headers independently.
  Extract shared `apiClient()`.
  *(Engineer 7, #2)*

- [ ] **Duplicated error utilities**: `utils.ts` and `_utils.ts` both define
  `errorMessage()` and `errorDetail()`. Consolidate.
  *(Engineer 7, #1)*

- [ ] **Duplicated handler error patterns**: `kv-handler.ts` and
  `vector-handler.ts` — identical schema validation and error formatting.
  Extract generic handler wrapper.
  *(Engineer 7, #5)*

- [ ] **Duplicated server bootstrap**: `dev.ts:52-80` and `start.ts:8-21` —
  identical boot sequence. Extract `bootServerAndLog()`.
  *(Engineer 7, #7)*

- [ ] **Duplicated config file read/write**: `_discover.ts:39-53,106-123` —
  both follow identical JSON parse/validate pattern. Generalize.
  *(Engineer 7, #8)*

- [ ] **Template test boilerplate**: All 18 templates duplicate ~15 lines of
  identical test structure. Extract test factory.
  *(Engineer 7, #4)*

- [ ] **Duplicated sidecar request validation**: `sandbox-sidecar.ts:128-180`
  — each endpoint validates identically. Use middleware.
  *(Engineer 7, #6)*

### Observability Polish

- [ ] **Sandbox lifecycle missing timing metrics**: `sandbox-slots.ts:49,69,107`
  — eviction and discovery lack performance timing.
  *(Engineer 9, #10)*

- [ ] **Barge-in events lack context**: `_session-otel.ts:281` — counter
  incremented but no log about what was interrupted.
  *(Engineer 9, #14)*

- [ ] **No health check for isolate HTTP server**: `sandbox.ts:192-200` —
  fetch `/config` succeeds but no ongoing readiness probe.
  *(Engineer 9, #12)*

### Minor Security

- [ ] **Timing-safe comparison misleading**: `auth.ts:34-42` — `!timingSafeEqual(bufA, bufA)`
  always returns false. Use explicit length check first.
  *(Engineer 1, #2)*

- [ ] **CSP policy allows ws:/wss: broadly**: `transport-websocket.ts:22-24`
  — document assumption. Consider `upgrade-insecure-requests`.
  *(Engineer 1, #11)*

- [ ] **Scope token lacks clock skew tolerance**: `scope-token.ts:24-33` —
  add configurable ±30s skew.
  *(Engineer 1, #14)*

### Test Coverage (Engineer 6)

- [ ] **KV store has zero tests**: `aai-server/src/kv.ts` — critical Redis
  scanning logic (scopedKey, scanAll pagination) completely untested. Add scope
  isolation and pagination edge case tests.
  *(Engineer 6, #3)*

- [ ] **Vector store has zero tests**: `aai-server/src/vector.ts` — namespace
  construction and scope isolation untested. Add injection and boundary tests.
  *(Engineer 6, #4)*

- [ ] **Transport WebSocket untested**: `aai-server/src/transport-websocket.ts`
  — CSP headers, SafePathSchema validation, content-type detection have no tests.
  *(Engineer 6, #5)*

- [ ] **Harness runtime untested**: `aai-server/src/_harness-runtime.ts` — 80+
  lines of core isolate runtime with sidecar RPC, middleware, KV/vector
  bindings. No direct tests.
  *(Engineer 6, #7)*

- [ ] **16 UI components untested**: All `_components/*.tsx` files in `aai-ui`
  lack component tests. Priority: `message-bubble.tsx` (role-based rendering),
  `chat-view.tsx`, `error-banner.tsx`.
  *(Engineer 6, #10-25)*

- [ ] **CLI commands untested**: `_init.ts`, `_link.ts`, `delete.ts`,
  `dev.ts`, `secret.ts`, `start.ts` — no tests for error handling paths,
  edge cases, or permission errors.
  *(Engineer 6, #28-35)*

- [ ] **Sandbox test weak assertions**: `sandbox.test.ts:102-253` — hook
  invoker tests verify fetch calls but not error handling, timeout scenarios,
  or state management after failed hooks.
  *(Engineer 6, sandbox)*

- [ ] **Deploy test weak coverage**: `deploy.test.ts` — 14 assertions across
  10 tests. Missing: malformed worker code, concurrent deploy conflicts, env
  var size limits.
  *(Engineer 6, deploy)*

- [ ] **46% of source files have no test coverage**: 64 of 139 source files
  are untested. Overall test-to-source ratio needs improvement.
  *(Engineer 6, summary)*

---

## Design Decisions

- **Fail-open vs fail-closed middleware**: Current middleware errors fail-open
  (tool call proceeds). This is intentional per `middleware-core.ts` but should
  be documented and configurable per-middleware.

- **Array immutability in UI**: The spread-based immutable pattern in
  `client-handler.ts` is correct for Preact reactivity but inefficient. Any
  optimization must preserve signal reactivity semantics.

- **Type assertion trade-offs**: Some `as` casts exist at trust boundaries
  (e.g., Zod `.parse()` results). These are safe but noisy. Removing them
  requires verifying Zod's type inference is sufficient.

---

## Open Questions

- Should rate limiting live in `orchestrator.ts` or as a separate middleware?
- Is the `ToolContext` god-object worth breaking up now, or is it a future
  major version change?
- Should the duplicate `ToolCallInterceptResult` types be unified in one PR
  or as part of a broader middleware refactor?
- What's the right approach for circular buffers in `conversationMessages` —
  custom implementation or a library?

---

## Notes

- Engineer 8 (Dependencies) review was still in progress at plan creation
  time. Findings will be appended when available.
- Many findings overlap across reviewers (e.g., the barge-in race condition
  was flagged by both the Concurrency and Reliability engineers). These have
  been deduplicated and cross-referenced.
- Priority levels are suggestive. Security P0 items should be addressed
  first regardless of effort.
