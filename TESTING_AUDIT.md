# Testing Strategy Audit & Improvement Plan

**Date**: 2026-04-11
**Scope**: All 5 workspace packages (`aai`, `aai-cli`, `aai-server`, `aai-ui`, `aai-templates`)

---

## 1. Current State Summary

### Test Infrastructure

| Tier | Command | Timeout | Config |
|------|---------|---------|--------|
| Unit | `pnpm test` | 5s | `vitest.config.ts` (5 projects) |
| Integration | `pnpm test:integration` | 30s | `vitest.slow.config.ts` |
| E2E | `pnpm test:e2e` | 300s | `vitest.slow.config.ts` |
| Load | `pnpm test:load` | 300s | `load/vitest.load.config.ts` |
| Adversarial | (manual) | 300s | `vitest.adversarial.config.ts` |
| Type-level | `pnpm vitest --project aai-types` | N/A | tsc-only, no runtime |

**Coverage provider**: v8 via `@vitest/coverage-v8`

### Coverage Numbers (measured 2026-04-11)

| Package | Statements | Branches | Functions | Lines | Target |
|---------|-----------|----------|-----------|-------|--------|
| **aai/sdk** | 93.8% | 80.0% | 93.8% | 94.1% | ~93% |
| **aai/host** | 88.4% | 77.8% | 87.3% | 88.9% | ~93% |
| **aai-cli** | 82.9% | 70.1% | 87.3% | 84.8% | ~75% |
| **aai-server** | 77.8%* | 100%* | 14.3%* | 77.8%* | ~80% |
| **aai-ui** | 63.5% | 48.1% | 68.1% | 65.0% | ~85% |
| **aai-ui/components** | 87.9% | 68.8% | 89.5% | 88.4% | ~85% |
| **Global thresholds** | 33% | 18% | 50% | 35% | — |

*aai-server numbers are incomplete — `fake-vm-integration.test.ts` causes ECONNRESET failures in this environment, masking true coverage. See Finding F1.

### Test Count

- **Total test files**: 93
- **Total test cases**: ~1006
- **Pass rate** (unit, excluding aai-server integration flake): 100% (661/661)

---

## 2. Findings

### F1: `fake-vm-integration.test.ts` not excluded from unit test project (Bug — High)

**Location**: Root `vitest.config.ts`, aai-server project config (line 83-91)

The aai-server project excludes `docker-build.test.ts`, `sandbox-integration.test.ts`, `sandbox-lifecycle.test.ts`, and `ws-integration.test.ts` from unit runs — but **not** `fake-vm-integration.test.ts`. This file spawns real child processes (fake VMs) that fail with `ECONNRESET` in constrained environments, causing **11 test failures and 9 uncaught errors** every run. This makes `pnpm test` unreliable and masks real regressions.

**Fix**: Add `fake-vm-integration.test.ts` to the exclude list in the aai-server project config. Ensure it runs under `pnpm test:integration` instead.

---

### F2: Global coverage thresholds are too low to be useful (Medium)

The global thresholds (statements=33%, branches=18%, functions=50%, lines=35%) are so low they would never fail. They don't prevent regressions — a package could drop from 90% to 40% coverage and the gate would still pass. The per-package targets documented in the comment (`aai ~93%, aai-ui ~85%, aai-cli ~75%, aai-server ~80%`) are not enforced.

**Fix**: Replace global thresholds with per-file or per-package thresholds using vitest's `thresholds` feature. At minimum, set a `thresholds.autoUpdate` or `perFile` strategy to ratchet coverage — it can only go up, never down.

---

### F3: `aai-ui/session-core.ts` has 33% statement coverage (High)

This is the core session management module — the most important file in `aai-ui`. It handles WebSocket connections, audio streaming, message state, and reconnection. At 33% statements / 13% branches / 46% functions, most of the critical paths are untested.

**Key untested paths** (lines ~348-573):
- WebSocket reconnection logic
- Audio stream setup/teardown
- Error handling during connection
- Message buffer overflow handling
- Session state transitions under failure

---

### F4: `aai/host/server.ts` has 53% statement coverage (Medium)

The HTTP/WebSocket server entry point is only half-covered. Untested areas include error handling paths, graceful shutdown, and WebSocket upgrade edge cases.

---

### F5: `aai-ui/components/sidebar-layout.tsx` has 0% coverage (Low)

This component has zero test coverage. While it's a layout component, it's still part of the public API surface.

---

### F6: `aai/sdk/kv.ts` and `aai/sdk/_ws-upgrade.ts` have 0% coverage (Medium)

Two SDK modules have zero unit test coverage:
- `kv.ts` — the KV store interface (tested indirectly via `unstorage-kv.test.ts` on the host side, but the SDK-side `Kv` class itself is untested)
- `_ws-upgrade.ts` — WebSocket upgrade utility

---

### F7: No concurrency/race condition tests (Medium)

No tests verify behavior under concurrent access:
- Simultaneous KV get/set/delete operations
- Concurrent session creation on the same slot
- Parallel deploy requests for the same slug
- WebSocket message interleaving

These are real production scenarios that could surface subtle bugs.

---

### F8: Session lifecycle state machine not exhaustively tested (Medium)

Session tests cover the happy path (create → start → interact → stop) but don't test:
- Double-start (idempotency)
- Operations after close
- Interleaved start/stop calls
- Reconnection after unexpected disconnect
- State consistency after error during tool execution

---

### F9: `aai-cli/test.ts` has 24% statement coverage (Medium)

The `test` subcommand implementation (which runs user agent tests) is barely tested. Only the basic invocation path is covered.

---

### F10: No per-package coverage enforcement in CI (Medium)

The `check.sh` pipeline runs `turbo run test` but never runs `test:coverage`. The documented per-package targets are aspirational comments, not enforced gates. A PR could merge with significant coverage regression.

---

### F11: `aai-cli` command implementations have gaps (Medium)

Several CLI command entry points lack dedicated tests:
- `dev.ts` — the dev server command (complex: file watching, Vite HMR, process management)
- `_templates.ts` — template handling
- `delete.ts` — only 60% covered (missing error paths)

---

### F12: Load tests lack baseline comparisons (Low)

Load tests measure absolute memory usage but don't compare against baselines. There's no mechanism to detect performance regressions over time (e.g., memory-per-session increased by 20% since last release).

---

### F13: Template agent tests don't exist yet (Low)

The templates project config expects `templates/*/agent.test.ts` files, but none exist (`passWithNoTests: true` suppresses the failure). Templates like dispatch-center and solo-rpg have complex tool logic that could break silently.

---

## 3. Improvement Plan

### Phase 1: Fix Broken/Flaky Tests (Week 1)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 1.1 | **Exclude `fake-vm-integration.test.ts` from unit project** — add to `vitest.config.ts` aai-server excludes, verify it still runs under `test:integration` | Unblocks reliable CI | S |
| 1.2 | **Triage the ECONNRESET failures** — determine if `fake-vm-integration.test.ts` is flaky or environment-specific. Add retry logic or skip in environments without process spawning. | Test reliability | M |

### Phase 2: Enforce Coverage Ratchet (Week 1-2)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 2.1 | **Set per-package coverage thresholds** in `vitest.config.ts` using vitest's `thresholds` option per project. Start at current levels minus 2% (ratchet floor). | Prevents regressions | S |
| 2.2 | **Add `test:coverage` to CI pipeline** — add coverage check to `check.sh` full mode so PRs that drop coverage are blocked. | Enforces quality gate | S |
| 2.3 | **Enable `thresholds.autoUpdate`** or use a coverage-diff reporter to show delta in PR comments. | Developer feedback | M |

### Phase 3: Close Critical Coverage Gaps (Weeks 2-4)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 3.1 | **Add tests for `session-core.ts`** — target 70%+ coverage. Focus on: WebSocket connection lifecycle, audio stream setup/teardown, message handling, error recovery, state transitions. | Highest-risk gap | L |
| 3.2 | **Add tests for `aai/host/server.ts`** — target 75%+. Cover: graceful shutdown, WebSocket upgrade errors, malformed requests. | Server reliability | M |
| 3.3 | **Add tests for `aai/sdk/kv.ts`** — unit test the `Kv` class directly (get/set/delete/scoping). | SDK correctness | S |
| 3.4 | **Improve `aai-cli/test.ts` coverage** — test error paths, argument validation, output formatting. | CLI reliability | M |
| 3.5 | **Add tests for `aai-cli/delete.ts`** error paths (network failure, 404, auth errors). | CLI reliability | S |

### Phase 4: Add Missing Test Categories (Weeks 3-5)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 4.1 | **Add concurrency tests for KV** — parallel get/set/delete, verify no data corruption. | Production correctness | M |
| 4.2 | **Add session state machine tests** — exhaustive lifecycle transitions (double-start, ops-after-close, error-during-tool). | Session robustness | M |
| 4.3 | **Add template agent tests** — at minimum, verify each template's `agent.ts` parses, validates manifest, and defines expected tools. | Template quality | M |
| 4.4 | **Add `sidebar-layout.tsx` component test** — basic render test + responsive behavior. | UI completeness | S |
| 4.5 | **Add `_ws-upgrade.ts` unit test** — test upgrade header parsing, error responses. | SDK completeness | S |

### Phase 5: Strengthen Test Infrastructure (Weeks 4-6)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 5.1 | **Add load test baselines** — record baseline metrics, fail if regression exceeds threshold (e.g., >15% memory increase). | Performance safety net | M |
| 5.2 | **Add coverage badge/report to PR workflow** — show per-package coverage delta on each PR. | Developer awareness | M |
| 5.3 | **Document testing conventions** — add a `docs/testing.md` or expand CLAUDE.md with: when to write unit vs integration vs e2e, mock guidelines, fixture format, how to add a new test tier. | Onboarding | S |

---

## 4. Priority Matrix

```
                    HIGH IMPACT
                        |
          F1,F3         |         F2,F10
       (fix flaky,      |      (enforce coverage)
        session-core)   |
                        |
  LOW EFFORT -----------+----------- HIGH EFFORT
                        |
          F5,F6         |         F7,F8
       (0% files,       |      (concurrency,
        quick wins)     |       state machine)
                        |
                    LOW IMPACT
```

**Recommended execution order**: F1 → F2+F10 → F3 → F6 → F4 → F9 → F7 → F8 → F11 → F13 → F12

---

## 5. Target Coverage After Plan Completion

| Package | Current | Target | Delta |
|---------|---------|--------|-------|
| **aai/sdk** | 94% | 96% | +2% |
| **aai/host** | 89% | 93% | +4% |
| **aai-cli** | 83% | 85% | +2% |
| **aai-server** | ~80%† | 85% | +5% |
| **aai-ui** | 65% | 80% | +15% |
| **aai-ui/components** | 88% | 92% | +4% |

†aai-server number estimated; actual measurement blocked by F1.

---

## 6. Quick Wins (can be done today)

1. Add `"fake-vm-integration.test.ts"` to aai-server project excludes in `vitest.config.ts`
2. Add `"aai/sdk/kv.ts"` unit tests (small file, simple interface)
3. Add `"components/sidebar-layout.tsx"` render test
4. Raise global thresholds to at least: statements=60%, branches=40%, functions=65%, lines=60%
