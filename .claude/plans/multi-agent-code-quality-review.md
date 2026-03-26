# Plan: Multi-Agent Code Quality Review

**Status:** in-progress
**Created:** 2026-03-26
**Updated:** 2026-03-26

## Context

Ten engineers independently reviewed the codebase. This plan contains only
the **high-impact, low-effort** items curated by a manager pass. Items that
require large refactors, new infrastructure, breaking API changes, or address
unlikely edge cases have been cut.

Criteria for inclusion: can be done in a focused PR (< 50 lines changed),
fixes a real bug or meaningful risk, and doesn't require architectural changes.

---

## Quick Wins — Security (1-5 lines each)

- [x] **CORS default too permissive**: `orchestrator.ts:63-77` defaults to
  `"*"` origin. Change default to reject or require explicit config.
  *(~1 line change, high security impact)*

- [x] **Secret key names not validated**: `secret-handler.ts:49` — add
  `z.string().regex(/^[a-zA-Z_]\w*$/)` to reject path traversal attempts.
  *(~2 lines)*

- [x] **Secret keys logged in plaintext**: `secret-handler.ts:42` — change
  `keys: Object.keys(updates)` to `keyCount: Object.keys(updates).length`.
  *(~1 line)*

- [x] **Timing-safe comparison misleading**: `auth.ts:34-42` —
  `!timingSafeEqual(bufA, bufA)` is confusing. Use explicit length check
  before `timingSafeEqual(bufA, bufB)`.
  *(~3 lines)*

---

## Quick Wins — Correctness (1-10 lines each)

- [x] **Barge-in filter chain not reset**: `_session-otel.ts:280-288` —
  add `ctx.filterChain = Promise.resolve()` in barge-in handler. Without
  this, stale chat deltas emit after cancellation.
  *(1 line fix, real user-facing bug)*

- [x] **Tool results leak across reply generations**:
  `_session-otel.ts:293-296` — capture `replyGeneration` at
  `handleReplyDone` entry and verify in `sendPending` before sending.
  *(~5 lines, prevents wrong tool results in new replies)*

- [x] **Session state not cleaned on hook errors**:
  `_harness-runtime.ts:284` — add state cleanup in error path, not just
  `onDisconnect`. Prevents memory leak from reconnecting clients.
  *(~3 lines)*

- [x] **Fire-and-forget terminate without await**: `secret-handler.ts:12` —
  await `slot.sandbox.terminate()` before proceeding.
  *(~1 line)*

---

## Quick Wins — Error Visibility (1-3 lines each)

- [x] **Deploy handler swallows errors silently**: `deploy.ts:60-66` —
  add `console.warn` in the `.catch()` blocks instead of empty handlers.
  *(~3 lines, huge debugging improvement)*

- [x] **Shutdown doesn't log rejection reasons**: `index.ts:129-136` —
  inspect `Promise.allSettled()` results and log any rejections.
  *(~5 lines)*

- [x] **Deploy/cleanup errors completely silent**: `deploy.ts:18,60,66` —
  same pattern, add minimal logging to all `.catch(() => {})` blocks.
  *(~3 lines)*

---

## Quick Wins — Type Safety (1-3 lines each)

- [x] **Redundant Zod cast**: `sandbox.ts:201` — remove unnecessary
  `as IsolateConfig` after `IsolateConfigSchema.parse()`.
  *(delete 1 cast)*

- [x] **`.filter(Boolean) as string[]`**: `bundle-store-tigris.ts:135` —
  replace with `.filter((k): k is string => typeof k === "string")`.
  *(1 line)*

- [x] **Unsafe type assertions in S2S parsing**: `s2s.ts:74-76` — add
  `typeof obj.call_id !== "string"` guard before the assertion.
  *(~3 lines)*

---

## Quick Wins — Build Hygiene (1-5 lines each)

- [x] **Unnecessary tsdown entry**: `aai/tsdown.config.ts:20` — remove
  `_mock-ws.ts` from entry array (test-only file being compiled).
  *(delete 1 line)*

- [x] **Private package has `main` pointing to source**:
  `aai-server/package.json:6` — remove `"main": "src/index.ts"` since
  package is `"private": true`.
  *(delete 1 line)*

- [x] **Duplicated error utilities**: `utils.ts` and `_utils.ts` both
  define `errorMessage()` and `errorDetail()`. Consolidate to one file.
  *(~10 lines, prevents drift)*

---

## Quick Wins — Performance (1-5 lines each)

- [x] **O(n^2) delta buffer concatenation**: `client-handler.ts:72` —
  `deltaBuffer.join(" ")` runs on every `chat_delta`. Only join on `chat`
  event completion instead.
  *(~3 lines, eliminates quadratic behavior in long responses)*

---

## Removed Items (and why)

Items cut from the original 70+ findings:

| Category | Reason |
|----------|--------|
| Rate limiting | Needs middleware infrastructure, large effort |
| DNS rebinding race in SSRF | Complex, SSRF already has good protection |
| Vector store filter injection | Backend-dependent, needs design |
| Windows config permissions | Edge case, most devs on Mac/Linux |
| WebSocket message buffer race | Complex state machine change |
| Server/sidecar startup timeouts | Architecture change needed |
| filterOutput chain await on stop | Complex promise chain work |
| Middleware session ID propagation | Requires signature changes across all middleware |
| Request ID propagation | Needs header infrastructure |
| Error classification system | Needs new error taxonomy |
| UI array spread optimization | Requires Preact reactivity redesign |
| Circular buffer for messages | Premature optimization |
| Metrics caching | Premature optimization |
| Event listener cleanup | Unlikely to cause issues in practice |
| ToolContext god-object refactor | Major breaking API change |
| HookInvoker parameter renaming | Breaking API change |
| resetState/reset rename | Breaking API change |
| ToolCallInterceptResult unification | Part of bigger middleware refactor |
| CLI HTTP client extraction | Refactor across 4 files, low bug risk |
| Handler error pattern extraction | Refactor, low bug risk |
| Template test factory | 18 files, low immediate impact |
| Sidecar validation middleware | Refactor, low bug risk |
| Sandbox timing metrics | Observability polish |
| Isolate health check | New infrastructure |
| CSP/scope-token tweaks | Documentation or edge cases |
| Most test coverage items | Huge effort, write tests as code changes |
| Missing package exports | Internal modules, workspace imports work fine |

---

## Notes

- All 10 engineer reviews are complete. This is the manager-curated subset.
- Total: **18 items**, each achievable in < 50 lines of change.
- Estimated total effort: a few focused PRs.
- Original full review preserved in git history for reference.
