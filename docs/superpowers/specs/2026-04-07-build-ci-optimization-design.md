# Build, CI & Monorepo Optimization

**Date:** 2026-04-07
**Status:** Approved
**Goal:** Reduce build times across all stages (local, pre-commit, CI) and improve CI reliability by addressing flaky tests.
**Approach:** Moderate — swap individual tools where there's a clear win, keep overall stack (tsdown, Turbo, vitest).

## Context

AAI is a pnpm workspace monorepo with 5 packages under `packages/`. The build
pipeline uses tsdown for bundling, tsc for declaration generation, Turbo for
orchestration, and vitest for testing. CI runs on GitHub Actions with matrix
jobs across OS/Node/package-manager combinations.

**Pain points addressed:**
- Build speed across all stages (local dev, pre-commit hooks, CI wall clock)
- Flaky tests — tests that pass locally but fail intermittently in CI

## 1. Eliminate Dual Build (tsdown `dts: true`)

**Problem:** `aai` and `aai-ui` run `tsdown && tsc -p tsconfig.build.json`.
The tsc step only generates `.d.ts` files, roughly doubling build time for
those packages.

**Changes:**
- Set `dts: true` in `packages/aai/tsdown.config.ts` and
  `packages/aai-ui/tsdown.config.ts`
- Remove `&& tsc -p tsconfig.build.json` from the `build` scripts in both
  `package.json` files
- Delete `tsconfig.build.json` from both packages
- Keep `tsc --noEmit` for typechecking (already runs via `pnpm typecheck`)
- Validate with `publint` and `attw` (already in CI) to ensure exports resolve

**Files:**
- `packages/aai/tsdown.config.ts` — set `dts: true`
- `packages/aai/package.json` — update build script
- `packages/aai/tsconfig.build.json` — delete
- `packages/aai-ui/tsdown.config.ts` — set `dts: true`
- `packages/aai-ui/package.json` — update build script
- `packages/aai-ui/tsconfig.build.json` — delete

**Risk:** tsdown's dts generation may produce slightly different output than
tsc. Mitigated by `attw` + `publint` validation already in the pipeline.

## 2. Lighten Pre-commit Hook

**Problem:** Pre-commit runs `pnpm -r run build && pnpm typecheck` on every
commit — a full rebuild + typecheck even for a one-line change. Adds 30-60s
to every commit.

**Changes:**
- Remove the `typecheck` command from pre-commit in `lefthook.yml`
- Keep biome lint + syncpack (fast, catches real issues)
- Type errors caught at pre-push (which runs `pnpm check`) and CI

**Files:**
- `lefthook.yml` — remove typecheck command from pre-commit

**Result:** Pre-commit drops from ~45s to ~5s.

## 3. Auto-derive aai-ui Entry Points

**Problem:** `aai-ui/tsdown.config.ts` manually lists 22 entry points. If a
new component is added but not listed, it won't be built. `aai` already
auto-derives entries from `package.json` exports.

**Complication:** Unlike `aai` (which has many exports), `aai-ui` only exports
`.` (index.ts) and `./session` (session.ts). The other 20 entries (components,
worklets, audio, etc.) are internal files — not in the exports map. They're
listed as separate entries to preserve the file structure in `dist/` so
internal imports between built files resolve correctly.

**Changes:**
- Port the dynamic entry derivation pattern from `aai/tsdown.config.ts` to
  `aai-ui/tsdown.config.ts` for the public exports
- Test whether tsdown's code splitting handles internal imports correctly with
  only the 2 public entries. If it does, remove the manual list entirely.
- If internal imports break, use a hybrid approach: derive public entries from
  exports + use a glob pattern (`components/**/*.tsx`, `worklets/*.ts`) for
  internal entries, so new files are picked up automatically.

**Files:**
- `packages/aai-ui/tsdown.config.ts` — replace manual entry list with dynamic
  derivation (+ optional glob fallback for internals)

**Risk:** Medium — needs validation that the built output works. `publint` +
`attw` will catch export issues but not internal import breakage. Test by
running `pnpm build` and verifying the dist/ structure, then running the
aai-ui test suite.

## 4. Consolidate Test Configs

**Problem:** Integration test configs live in 3 places: root
`vitest.integration.config.ts`, plus per-package configs in `aai` and
`aai-server`. The root config is self-described as "backward compatibility"
and Turbo already runs per-package configs.

**Changes:**
- Delete `vitest.integration.config.ts` at root
- Update root `package.json` `test:integration` script to run
  `turbo run check:integration` instead of
  `vitest run -c vitest.integration.config.ts`
- Per-package integration configs stay as-is

**Files:**
- `vitest.integration.config.ts` (root) — delete
- `package.json` (root) — update `test:integration` script

**Result:** One fewer config, one clear path for integration tests.

## 5. Flaky Test Infrastructure

**Problem:** Flaky tests are the main CI reliability pain. Tests pass locally
but fail intermittently in CI, eroding trust and slowing merges.

### 5a. Integration test retries

Add `retry: 2` to per-package integration test configs. Integration tests hit
real subsystems (V8 isolates, HTTP servers) where transient failures are
expected. Unit tests get no retries — a flaky unit test is a bug.

### 5b. Flaky test reporter

Add `vitest-fail-on-retry` as a dev dependency. This reporter flags tests
that passed only after retry — visible as warnings in CI without blocking.

Configuration in integration vitest configs:
```ts
reporters: [process.env.CI ? "dot" : "default", "vitest-fail-on-retry"]
```

### 5c. `vi.waitFor()` audit

Audit integration tests for timing-dependent patterns:
- `await new Promise(r => setTimeout(r, ...))` — replace with `vi.waitFor()`
- `flush()` followed by immediate assertions on async results
- Missing `await` on async operations before assertions

Targeted pass on integration tests only, not repo-wide.

**Files:**
- `packages/aai/vitest.integration.config.ts` — add retry + reporter
- `packages/aai-server/vitest.integration.config.ts` — add retry + reporter
- `package.json` (root) — add `vitest-fail-on-retry` dev dependency
- Integration test files — case-by-case `vi.waitFor()` fixes

**Risk:** Verify `vitest-fail-on-retry` supports vitest 4.x. If not, a
custom reporter is ~20 lines.

## 6. Turbo Caching & CI Restructure

### 6a. Precise Turbo inputs

- Add `package.json` to build inputs (dep changes trigger rebuild)
- Add `pnpm-lock.yaml` as a `globalDependency` in `turbo.json` so lockfile
  changes invalidate all caches

### 6b. No remote caching

Rely on GitHub Actions cache (already in place) + Turbo's local `.turbo`
cache. The existing `actions/cache` setup for `.turbo` provides cross-run
caching within CI.

### 6c. Merge CI jobs

Merge `lint-and-typecheck` and `checks` into a single
`lint-typecheck-and-checks` job. Both run on `ubuntu-latest` with the same
cache restore. Saves one checkout+restore cycle (~20s) and one billable job.

Test/integration/e2e matrix jobs stay separate for parallelism.

**Files:**
- `turbo.json` — add `globalDependencies`, refine inputs
- `.github/workflows/check.yml` — merge two jobs into one

## 7. Pre-push Build Caching (No Extra Work)

Sections 1 + 2 together solve pre-push speed. Once dts is handled by tsdown,
the entire build is a single Turbo-cached step. If source files haven't
changed since last build, Turbo replays cached output in ~1s. The pre-push
path becomes: Turbo cache hit (~1s) → typecheck (incremental via
`.tsbuildinfo`) → lint → tests (Turbo cached if unchanged).

No additional changes needed.

## Out of Scope

- Windows CI support (tsdown/rolldown `.ts` export resolution)
- Coverage ratchet (auto-increasing thresholds)
- Nx migration (Turbo replacement)
- Unit test retries (flaky unit tests are bugs, not infrastructure issues)

## Expected Impact

| Stage | Before | After |
|-------|--------|-------|
| Pre-commit | ~45s (build + typecheck + lint) | ~5s (lint + syncpack only) |
| Local build (`aai` + `aai-ui`) | 2x (tsdown + tsc) | 1x (tsdown with dts) |
| Pre-push | Full rebuild even if cached | Turbo cache hit (~1s) if unchanged |
| CI wall clock | 7 parallel jobs + per-job overhead | 6 jobs, one fewer restore cycle |
| Flaky tests | Block CI, no visibility | Retried + flagged, visible not blocking |
