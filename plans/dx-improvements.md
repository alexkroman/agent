# DX Improvements: Test Parallelism, Config Consolidation, and API Boundaries

**Status**: in-progress
**Branch**: `claude/parallelize-test-execution-vcWmX`

## Tasks

### 6. Parallelize Test Execution / Test Sharding
- [x] Split CI `test` job into 4 parallel jobs (one per vitest project)
- [x] Update `scripts/check.sh` to shard tests by package in Phase 3
- [x] Keep single `pnpm test` for local dev (all projects)

### 7. Add Single-Package Dev Mode and Filter Shortcuts
- [x] Add `test:aai`, `test:aai-ui`, `test:aai-cli`, `test:aai-server` to root package.json
- [x] Add `dev:aai-server` shortcut
- [x] Document single-package workflows in CLAUDE.md

### 8. Merge Multiple Vitest Config Files Into One
- [x] Move slow test (e2e, pack-build) and integration test configs into root vitest.config.ts as additional projects
- [x] Delete `packages/aai-cli/vitest.slow.config.ts` and `packages/aai-server/vitest.integration.config.ts`
- [x] Update package.json scripts to reference root config with `--project` filter

### 9. Replace setTimeout Patterns With Deterministic Test Helpers
- [x] Create shared `flush()` helper in root test setup
- [x] Replace `await new Promise(r => setTimeout(r, 0))` (microtask flush) with `flush()`
- [x] Replace small-delay setTimeout patterns with `vi.waitFor` where appropriate
- [x] Leave integration/e2e tests (real network waits) unchanged

### 10. Enforce Public/Internal API Boundaries & Automated Break Detection
- [x] Add CI step to detect breaking API changes by diffing `.api.md` reports
- [x] Document public vs internal exports in CLAUDE.md
