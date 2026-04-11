# Testing Strategy Audit & Improvement Plan

**Date**: 2026-04-11
**Scope**: All 5 workspace packages

## 1. Current State Summary

### Test Infrastructure

| Tier | Command | Timeout | Config |
| ---- | ------- | ------- | ------ |
| Unit | `pnpm test` | 5s | `vitest.config.ts` |
| Integration | `pnpm test:integration` | 30s | `vitest.slow.config.ts` |
| E2E | `pnpm test:e2e` | 300s | `vitest.slow.config.ts` |
| Load | `pnpm test:load` | 300s | `load/vitest.load.config.ts` |
| Adversarial | (manual) | 300s | `vitest.adversarial.config.ts` |
| Type-level | `vitest --project aai-types` | N/A | tsc-only |

**Coverage provider**: v8 via `@vitest/coverage-v8`

### Coverage Numbers (measured 2026-04-11)

| Package | Stmts | Branch | Funcs | Lines | Target |
| ------- | ----- | ------ | ----- | ----- | ------ |
| aai/sdk | 93.8% | 80.0% | 93.8% | 94.1% | ~93% |
| aai/host | 88.4% | 77.8% | 87.3% | 88.9% | ~93% |
| aai-cli | 82.9% | 70.1% | 87.3% | 84.8% | ~75% |
| aai-server | 77.8%\* | 100%\* | 14.3%\* | 77.8%\* | ~80% |
| aai-ui | 63.5% | 48.1% | 68.1% | 65.0% | ~85% |
| aai-ui/components | 87.9% | 68.8% | 89.5% | 88.4% | ~85% |
| Global thresholds | 33% | 18% | 50% | 35% | — |

\*aai-server numbers are incomplete — `fake-vm-integration.test.ts`
causes ECONNRESET failures in this environment, masking true
coverage. See Finding F1.

### Test Count

- Total test files: 93
- Total test cases: ~1006
- Pass rate (unit, excluding server integration flake): 100%

## 2. Findings

### F1: `fake-vm-integration.test.ts` not excluded from unit project

**Severity**: High (Bug)
**Location**: Root `vitest.config.ts`, aai-server project (line 83)

The aai-server project excludes `docker-build.test.ts`,
`sandbox-integration.test.ts`, `sandbox-lifecycle.test.ts`, and
`ws-integration.test.ts` — but **not** `fake-vm-integration.test.ts`.
This file spawns real child processes that fail with `ECONNRESET` in
constrained environments, causing **11 test failures and 9 uncaught
errors** every run. This makes `pnpm test` unreliable and masks real
regressions.

**Fix**: Add `fake-vm-integration.test.ts` to the exclude list.
Ensure it runs under `pnpm test:integration` instead.

### F2: Global coverage thresholds too low to be useful

**Severity**: Medium

The global thresholds (statements=33%, branches=18%, functions=50%,
lines=35%) are so low they would never fail. A package could drop
from 90% to 40% and the gate would still pass. The per-package
targets in the comment are not enforced.

**Fix**: Replace global thresholds with per-file or per-package
thresholds. At minimum, set `thresholds.autoUpdate` or a `perFile`
strategy to ratchet coverage.

### F3: `session-core.ts` has 33% statement coverage

**Severity**: High

This is the core session management module in `aai-ui`. It handles
WebSocket connections, audio streaming, message state, and
reconnection. At 33% statements / 13% branches / 46% functions,
most critical paths are untested.

Key untested paths (lines ~348-573):

- WebSocket reconnection logic
- Audio stream setup/teardown
- Error handling during connection
- Message buffer overflow handling
- Session state transitions under failure

### F4: `server.ts` has 53% statement coverage

**Severity**: Medium

The HTTP/WebSocket server entry point (`aai/host/server.ts`) is only
half-covered. Untested areas include error handling paths, graceful
shutdown, and WebSocket upgrade edge cases.

### F5: `sidebar-layout.tsx` has 0% coverage

**Severity**: Low

This component has zero test coverage. While it is a layout
component, it is still part of the public API surface.

### F6: `kv.ts` and `_ws-upgrade.ts` have 0% coverage

**Severity**: Medium

Two SDK modules have zero unit test coverage:

- `kv.ts` — the KV store interface (tested indirectly via
  `unstorage-kv.test.ts` on host side, but the SDK `Kv` class
  itself is untested)
- `_ws-upgrade.ts` — WebSocket upgrade utility

### F7: No concurrency/race condition tests

**Severity**: Medium

No tests verify behavior under concurrent access:

- Simultaneous KV get/set/delete operations
- Concurrent session creation on the same slot
- Parallel deploy requests for the same slug
- WebSocket message interleaving

### F8: Session lifecycle state machine not exhaustively tested

**Severity**: Medium

Session tests cover the happy path (create, start, interact, stop)
but do not test:

- Double-start (idempotency)
- Operations after close
- Interleaved start/stop calls
- Reconnection after unexpected disconnect
- State consistency after error during tool execution

### F9: `aai-cli/test.ts` has 24% statement coverage

**Severity**: Medium

The `test` subcommand implementation is barely tested. Only the
basic invocation path is covered.

### F10: No per-package coverage enforcement in CI

**Severity**: Medium

The `check.sh` pipeline runs `turbo run test` but never runs
`test:coverage`. The per-package targets are aspirational comments,
not enforced gates. A PR could merge with significant coverage
regression.

### F11: CLI command implementations have gaps

**Severity**: Medium

Several CLI command entry points lack dedicated tests:

- `dev.ts` — the dev server command (file watching, Vite HMR,
  process management)
- `_templates.ts` — template handling
- `delete.ts` — only 60% covered (missing error paths)

### F12: Load tests lack baseline comparisons

**Severity**: Low

Load tests measure absolute memory usage but do not compare against
baselines. There is no mechanism to detect performance regressions
over time.

### F13: Template agent tests do not exist yet

**Severity**: Low

The templates project config expects `templates/*/agent.test.ts`
files, but none exist (`passWithNoTests: true` suppresses the
failure). Templates like dispatch-center and solo-rpg have complex
tool logic that could break silently.

## 3. Improvement Plan

### Phase 1: Fix Broken/Flaky Tests (Week 1)

| ID | Task | Effort |
| -- | ---- | ------ |
| 1.1 | Exclude `fake-vm-integration.test.ts` from unit project | S |
| 1.2 | Triage ECONNRESET failures — flaky or environment-specific? Add retry or conditional skip. | M |

### Phase 2: Enforce Coverage Ratchet (Week 1-2)

| ID | Task | Effort |
| -- | ---- | ------ |
| 2.1 | Set per-package coverage thresholds at current levels minus 2% | S |
| 2.2 | Add `test:coverage` to `check.sh` full mode | S |
| 2.3 | Enable `thresholds.autoUpdate` or coverage-diff reporter | M |

### Phase 3: Close Critical Coverage Gaps (Weeks 2-4)

| ID | Task | Effort |
| -- | ---- | ------ |
| 3.1 | Add tests for `session-core.ts` — target 70%+ | L |
| 3.2 | Add tests for `server.ts` — target 75%+ | M |
| 3.3 | Add tests for `kv.ts` (SDK-side) | S |
| 3.4 | Improve `aai-cli/test.ts` coverage | M |
| 3.5 | Add tests for `delete.ts` error paths | S |

### Phase 4: Add Missing Test Categories (Weeks 3-5)

| ID | Task | Effort |
| -- | ---- | ------ |
| 4.1 | Add concurrency tests for KV | M |
| 4.2 | Add session state machine tests | M |
| 4.3 | Add template agent tests | M |
| 4.4 | Add `sidebar-layout.tsx` component test | S |
| 4.5 | Add `_ws-upgrade.ts` unit test | S |

### Phase 5: Strengthen Test Infrastructure (Weeks 4-6)

| ID | Task | Effort |
| -- | ---- | ------ |
| 5.1 | Add load test baselines and regression detection | M |
| 5.2 | Add coverage badge/report to PR workflow | M |
| 5.3 | Document testing conventions in CLAUDE.md or a testing guide | S |

## 4. Priority Matrix

```text
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

**Recommended order**:
F1 > F2+F10 > F3 > F6 > F4 > F9 > F7 > F8 > F11 > F13 > F12

## 5. Target Coverage After Plan Completion

| Package | Current | Target | Delta |
| ------- | ------- | ------ | ----- |
| aai/sdk | 94% | 96% | +2% |
| aai/host | 89% | 93% | +4% |
| aai-cli | 83% | 85% | +2% |
| aai-server | ~80% | 85% | +5% |
| aai-ui | 65% | 80% | +15% |
| aai-ui/components | 88% | 92% | +4% |

aai-server number estimated; actual measurement blocked by F1.

## 6. Quick Wins (can be done today)

1. Add `"fake-vm-integration.test.ts"` to aai-server excludes
2. Add `aai/sdk/kv.ts` unit tests (small file, simple interface)
3. Add `components/sidebar-layout.tsx` render test
4. Raise global thresholds to: stmts=60%, branches=40%,
   funcs=65%, lines=60%
