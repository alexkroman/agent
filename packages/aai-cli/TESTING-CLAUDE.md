---
summary: >-
  Testing the CLI against a dying server (`AAI_FAULT_PROFILE`, the
  SIGKILL-and-restart fault mode, and how it differs from aai-runtime's socket
  fault proxy) and the pnpm-only e2e suite (`AAI_TEST_PM`,
  `AAI_REQUIRE_REGISTRY`)
read_when: >-
  running or changing the e2e suite, `_fault-mode.ts`, or a fault profile
---

# packages/aai-cli — fault mode and the e2e suite

## Fault mode: a suite run against a server that keeps dying

`AAI_FAULT_PROFILE=<name>` makes every test that boots via
`startSupervisedDevServer` (`_fault-mode.ts`) run against an `aai dev` child
that is **SIGKILLed and restarted** at declared points; unset, it is a plain
spawn.

```sh
AAI_FAULT_PROFILE=restart-on-boot pnpm test:e2e     # the whole suite, under faults
```

- **SIGKILL only** — a graceful stop releases graphile-worker's locks and skips
  the recovery path under test.
- **No seed, no PRNG**: points are keyed on logical events, so runs are
  reproducible. Randomized exploration uses fast-check elsewhere.
- **A profile that matches nothing FAILS**: `awaitSettled()` throws naming
  unfired points plus recent server lines; `stop()` warns on zero injections.
- **`afterHealthy` exists because JSON mode silences `aai dev`'s boot line**;
  workflow log lines go straight to stderr and are valid triggers.
- **Assert from `awaitSettled()`** (all kills done and `/health` answers).
  `assertPlanConsumed()` is for tests whose subject is the profile.
  `restart-on-boot` is the whole-suite profile.
- `AAI_FAULT_PROFILE` is declared in `check:e2e` and `check:integration` `env`
  in `turbo.json` (strict env mode, and separate cache entries).
- **Not in CI**: a hard-killed in-flight step is never redelivered
  (graphile-worker's `is_available` has no time term), so mid-run profiles are
  red for a real reason. CI runs `_fault-mode.scenario.test.ts`, the
  supervisor's own spec against a fake server.

### The other fault mode lives in `aai-runtime`, and faults a SOCKET

`packages/aai-runtime/src/server/_fault-socket.ts` is a TCP proxy that SEVERS
live connections, to test session resume. Choose correctly:

- **This mode kills a PROCESS; that one cuts a CONNECTION.** A restart preserves
  durable slot state (`aai-runtime/session-state/store.ts`) but not the call; a
  socket drop is the only disconnect a session survives.
- **It severs (`destroy()`), never closes** — a clean close is "user hung up",
  which aai-ui does not reconnect from;
  `aai-runtime/src/server/session-resume.scenario.test.ts` asserts **1006**.
- **It is a proxy** so no fault injector lives in production code.

## The e2e suite is pnpm-only in CI

`e2e.test.ts` installs an `aai init` project from a mock verdaccio registry. CI
runs pnpm only; `publint` + `attw` cover non-pnpm `exports` resolution.
`AAI_TEST_PM` (`_e2e-test-utils.ts`, in `check:e2e`'s `env`) switches the
install to reproduce a user report — a debugging tool, not covered ground:

```sh
AAI_TEST_PM=npm pnpm test:e2e
```

**`AAI_REQUIRE_REGISTRY`**, also in `check:e2e`'s `env`, disables the
`isRegistryProxyFailure` excuse for a failed install; CI sets it.
