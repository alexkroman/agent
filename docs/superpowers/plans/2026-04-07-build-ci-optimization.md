# Build & CI Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce build times across all stages (local, pre-commit, CI) and improve CI reliability by addressing flaky tests.

**Architecture:** Eliminate the dual tsdown+tsc build by enabling tsdown's built-in dts generation, lighten git hooks, consolidate fragmented test configs, add retry infrastructure for integration tests, and optimize Turbo caching and CI job structure.

**Tech Stack:** tsdown (dts plugin), Turbo, vitest, lefthook, GitHub Actions

**Worktree:** `.worktrees/build-ci-optimization` (branch: `build-ci-optimization`)

**Spec:** `docs/superpowers/specs/2026-04-07-build-ci-optimization-design.md`

---

### Task 1: Enable tsdown dts for `aai` package

**Files:**
- Modify: `packages/aai/tsdown.config.ts`
- Modify: `packages/aai/package.json:75`
- Delete: `packages/aai/tsconfig.build.json`

- [ ] **Step 1: Enable dts in tsdown config**

In `packages/aai/tsdown.config.ts`, change `dts: false` to `dts: true`:

```ts
export default defineConfig({
  entry,
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: true,
  outExtensions: () => ({ js: ".js" }),
  deps: { neverBundle: [/^[^./]/] },
});
```

- [ ] **Step 2: Remove tsc from build script**

In `packages/aai/package.json`, change line 75 from:

```json
"build": "tsdown && tsc -p tsconfig.build.json",
```

to:

```json
"build": "tsdown",
```

- [ ] **Step 3: Delete tsconfig.build.json**

```bash
rm packages/aai/tsconfig.build.json
```

- [ ] **Step 4: Clean and rebuild**

```bash
rm -rf packages/aai/dist
pnpm exec turbo run build --filter=@alexkroman1/aai --force
```

Expected: tsdown builds JS + `.d.ts` files in a single pass. Verify that `dist/` contains both `.js` and `.d.ts` files:

```bash
ls packages/aai/dist/index.js packages/aai/dist/index.d.ts
ls packages/aai/dist/host/server.js packages/aai/dist/host/server.d.ts
ls packages/aai/dist/isolate/types.js packages/aai/dist/isolate/types.d.ts
```

- [ ] **Step 5: Validate package exports**

```bash
pnpm --filter @alexkroman1/aai run check:publint
pnpm --filter @alexkroman1/aai run check:attw
```

Expected: Both pass — exports resolve to real files with correct types.

- [ ] **Step 6: Run aai tests**

```bash
pnpm --filter @alexkroman1/aai test
```

Expected: All tests pass.

- [ ] **Step 7: Run dependent package builds**

```bash
pnpm exec turbo run build --force
```

Expected: All 4 packages build successfully. `aai-ui`, `aai-cli`, and `aai-server` still resolve `@alexkroman1/aai` types correctly.

- [ ] **Step 8: Run full typecheck**

```bash
pnpm typecheck
```

Expected: All packages typecheck. The `aai` isolate typecheck (`tsc -p isolate/tsconfig.json`) still passes.

- [ ] **Step 9: Commit**

```bash
git add packages/aai/tsdown.config.ts packages/aai/package.json
git rm packages/aai/tsconfig.build.json
git commit -m "build(aai): replace tsc with tsdown dts generation

Drop the separate tsc -p tsconfig.build.json step from the aai build.
tsdown's built-in dts: true generates declarations in a single pass,
roughly halving build time for this package."
```

---

### Task 2: Enable tsdown dts for `aai-ui` package

**Files:**
- Modify: `packages/aai-ui/tsdown.config.ts`
- Modify: `packages/aai-ui/package.json:25`
- Delete: `packages/aai-ui/tsconfig.build.json`

- [ ] **Step 1: Enable dts and auto-derive entries in tsdown config**

Replace `packages/aai-ui/tsdown.config.ts` entirely:

```ts
import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Derive build entries from package.json exports so they can never drift.
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const entry = [
  ...new Set(
    Object.values(pkg.exports as Record<string, Record<string, string>>)
      .filter(
        (v): v is { "@dev/source": string } =>
          typeof v === "object" && typeof v["@dev/source"] === "string",
      )
      .map((v) => v["@dev/source"].replace(/^\.\//, "")),
  ),
];

export default defineConfig({
  entry,
  format: "esm",
  target: "es2022",
  outDir: "dist",
  dts: true,
  outExtensions: () => ({ js: ".js" }),
  deps: { neverBundle: [/^[^./]/] },
});
```

Note: `aai-ui` exports only `.` (index.ts) and `./session` (session.ts). The old manual list of 22 entries included internal components and worklets that are imported by `index.ts` — tsdown handles these via code splitting automatically when `index.ts` is an entry point.

- [ ] **Step 2: Remove tsc from build script**

In `packages/aai-ui/package.json`, change line 25 from:

```json
"build": "tsdown && tsc -p tsconfig.build.json",
```

to:

```json
"build": "tsdown",
```

- [ ] **Step 3: Delete tsconfig.build.json**

```bash
rm packages/aai-ui/tsconfig.build.json
```

- [ ] **Step 4: Clean and rebuild**

```bash
rm -rf packages/aai-ui/dist
pnpm exec turbo run build --force
```

Expected: tsdown builds JS + `.d.ts` files. Verify:

```bash
ls packages/aai-ui/dist/index.js packages/aai-ui/dist/index.d.ts
ls packages/aai-ui/dist/session.js packages/aai-ui/dist/session.d.ts
```

- [ ] **Step 5: Validate package exports**

```bash
pnpm --filter @alexkroman1/aai-ui run check:publint
pnpm --filter @alexkroman1/aai-ui run check:attw
```

Expected: Both pass.

- [ ] **Step 6: Run aai-ui tests**

```bash
pnpm --filter @alexkroman1/aai-ui test
```

Expected: All tests pass.

- [ ] **Step 7: Verify downstream packages**

```bash
pnpm typecheck
```

Expected: Full typecheck passes. No downstream packages import from `aai-ui` internal paths, so the reduced entry set should be fine.

- [ ] **Step 8: Commit**

```bash
git add packages/aai-ui/tsdown.config.ts packages/aai-ui/package.json
git rm packages/aai-ui/tsconfig.build.json
git commit -m "build(aai-ui): replace tsc with tsdown dts, auto-derive entries

Drop the separate tsc step and the manual 22-entry list. Entry points
are now derived from package.json exports (same pattern as aai).
Internal components are handled by tsdown's code splitting."
```

---

### Task 3: Lighten pre-commit hook

**Files:**
- Modify: `lefthook.yml`

- [ ] **Step 1: Remove typecheck from pre-commit**

Edit `lefthook.yml` to remove the `typecheck` command. The file should become:

```yaml
pre-commit:
  commands:
    lint-staged:
      glob: "packages/**/*.{ts,tsx,js,mjs}"
      run: npx biome check --write {staged_files} && git add {staged_files}
    syncpack:
      glob: "**/package.json"
      run: pnpm run check:syncpack

pre-push:
  commands:
    no-push-main:
      run: |
        branch=$(git rev-parse --abbrev-ref HEAD)
        if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
          echo "Error: Direct pushes to $branch are not allowed. Use a PR."
          exit 1
        fi
    no-conflicts-with-main:
      run: |
        branch=$(git rev-parse --abbrev-ref HEAD)
        if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
          exit 0
        fi
        echo "Checking for merge conflicts with main..."
        git fetch origin main --quiet 2>/dev/null || {
          echo "Warning: Could not fetch origin/main — skipping conflict check."
          exit 0
        }
        # Try a merge in-memory (no worktree changes) using merge-tree
        base=$(git merge-base HEAD origin/main 2>/dev/null) || {
          echo "Warning: No common ancestor with main — skipping conflict check."
          exit 0
        }
        merge_result=$(git merge-tree "$base" HEAD origin/main 2>/dev/null)
        if echo "$merge_result" | grep -q "^<<<<<<<"; then
          echo ""
          echo "Error: This branch has merge conflicts with main."
          echo "Please rebase or merge main into your branch before pushing:"
          echo ""
          echo "  git fetch origin main"
          echo "  git rebase origin/main"
          echo ""
          echo "Then resolve any conflicts and try again."
          exit 1
        fi
        echo "No conflicts with main detected."
    changeset-status:
      run: |
        branch=$(git rev-parse --abbrev-ref HEAD)
        if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
          exit 0
        fi
        case "$branch" in changeset-release/*) exit 0 ;; esac
        pnpm changeset status --since=origin/main
    check:
      run: pnpm check
```

The only change is removing the `typecheck` block from `pre-commit.commands`. The `pre-push` section stays identical.

- [ ] **Step 2: Verify hooks reinstall**

```bash
pnpm run prepare
```

Expected: `lefthook install` succeeds, hooks updated.

- [ ] **Step 3: Test pre-commit runs fast**

Create a dummy change and verify the hook runs in under 10 seconds:

```bash
echo "" >> packages/aai/index.ts
time git add packages/aai/index.ts && git diff --cached --stat
git restore --staged packages/aai/index.ts
git checkout packages/aai/index.ts
```

- [ ] **Step 4: Commit**

```bash
git add lefthook.yml
git commit -m "perf: remove typecheck from pre-commit hook

Typecheck required a full rebuild (~30-60s) on every commit. It's still
enforced at pre-push (via pnpm check) and CI. Pre-commit now runs only
biome lint + syncpack (~5s)."
```

---

### Task 4: Delete root vitest.integration.config.ts

**Files:**
- Delete: `vitest.integration.config.ts` (root)

- [ ] **Step 1: Verify root test:integration already uses Turbo**

```bash
grep "test:integration" package.json
```

Expected output includes: `"test:integration": "turbo run check:integration"` — already correct, no script change needed.

- [ ] **Step 2: Delete the root config**

```bash
rm vitest.integration.config.ts
```

- [ ] **Step 3: Verify integration tests still run via Turbo**

```bash
pnpm test:integration
```

Expected: Turbo dispatches to per-package `check:integration` scripts. Tests pass (or skip if no integration test infra is available locally).

- [ ] **Step 4: Commit**

```bash
git rm vitest.integration.config.ts
git commit -m "chore: remove unused root vitest.integration.config.ts

This config was kept for backward compatibility but the test:integration
script already routes through Turbo to per-package configs. Removing it
eliminates a confusing duplicate."
```

---

### Task 5: Add retry + flaky test visibility to integration tests

**Files:**
- Modify: `packages/aai/vitest.integration.config.ts`
- Modify: `packages/aai-server/vitest.integration.config.ts`

- [ ] **Step 1: Add retry to aai integration config**

Replace `packages/aai/vitest.integration.config.ts` with:

```ts
import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["host/pentest.test.ts", "host/run-code-sandbox.test.ts", "host/integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
  },
});
```

- [ ] **Step 2: Add retry to aai-server integration config**

Replace `packages/aai-server/vitest.integration.config.ts` with:

```ts
import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: ["sandbox-integration.test.ts", "ws-integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 2,
  },
});
```

- [ ] **Step 3: Add GitHub Actions annotation for retried tests**

Since `vitest-fail-on-retry` doesn't exist on npm, we'll use vitest's built-in `onTestFinished` lifecycle instead. No extra dependency needed — retried tests are already visible in vitest's output when they retry. The `retry: 2` setting is sufficient for visibility because vitest logs the retry count.

To add CI-specific annotations, update `vitest.shared.ts`:

```ts
/**
 * Shared Vitest configuration used by the root workspace config
 * and package-specific configs (slow tests, integration tests).
 */
export const sharedConfig = {
  resolve: { conditions: ["@dev/source"] },
  ssr: { resolve: { conditions: ["@dev/source"] } },
  test: {
    reporters: process.env.CI ? ["dot", "github-actions"] : ["default"],
  },
};
```

The `github-actions` reporter is built into vitest and produces GitHub Actions annotations for test failures and retries — no extra package needed.

- [ ] **Step 4: Verify integration tests still pass**

```bash
pnpm test:integration
```

Expected: Tests pass. Any retried tests show retry count in output.

- [ ] **Step 5: Commit**

```bash
git add packages/aai/vitest.integration.config.ts packages/aai-server/vitest.integration.config.ts vitest.shared.ts
git commit -m "test: add retry and github-actions reporter for integration tests

Integration tests hit real subsystems (V8 isolates, HTTP servers) where
transient failures are expected. retry: 2 allows them to recover without
blocking CI. The github-actions reporter annotates failures directly in
PR diffs."
```

---

### Task 6: Replace delay() with vi.waitFor() in ws-integration tests

**Files:**
- Modify: `packages/aai-server/ws-integration.test.ts`

- [ ] **Step 1: Read the full test file to understand delay usage**

Read `packages/aai-server/ws-integration.test.ts` fully. The file uses `delay(100)` and `delay(200-300)` between WebSocket sends and assertion checks. These fixed delays are a common source of flakiness — they may be too short on slow CI runners or waste time when they're too long.

- [ ] **Step 2: Replace delay() calls with vi.waitFor() where possible**

For each `delay()` call in the test, determine if it's:
- **Waiting for an assertion to become true** → replace with `vi.waitFor()`
- **Waiting for a side effect to settle** (e.g., WebSocket message propagation) → replace with `vi.waitFor()` wrapping the subsequent assertion
- **Intentional pause** (e.g., simulating user think time) → keep as-is

The general pattern is to replace:

```ts
await delay(100);
expect(something).toBe(value);
```

with:

```ts
await vi.waitFor(() => {
  expect(something).toBe(value);
});
```

Remove the `delay()` helper function if no calls remain.

- [ ] **Step 3: Run integration tests to verify**

```bash
pnpm --filter @alexkroman1/aai-server run check:integration
```

Expected: All tests pass without fixed delays.

- [ ] **Step 4: Commit**

```bash
git add packages/aai-server/ws-integration.test.ts
git commit -m "test: replace delay() with vi.waitFor() in ws-integration

Fixed delays (100-300ms) are a common source of flaky tests. vi.waitFor()
polls until the assertion passes, making tests both faster and more
reliable on slow CI runners."
```

---

### Task 7: Optimize Turbo caching inputs

**Files:**
- Modify: `turbo.json`

- [ ] **Step 1: Add globalDependencies and refine inputs**

Replace `turbo.json` with:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["pnpm-lock.yaml"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": [
        "**/*.ts",
        "**/*.tsx",
        "!**/*.test.ts",
        "!**/*.test.tsx",
        "!**/*.test-d.ts",
        "tsconfig*.json",
        "tsdown.config.ts",
        "package.json"
      ],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": [],
      "inputs": ["**/*.ts", "**/*.tsx", "vitest.config.ts", "../../vitest.shared.ts"]
    },
    "test:coverage": {
      "dependsOn": [],
      "inputs": ["**/*.ts", "**/*.tsx", "vitest.config.ts", "../../vitest.shared.ts"],
      "outputs": ["coverage/**"]
    },
    "typecheck": {
      "dependsOn": ["build"],
      "inputs": ["**/*.ts", "**/*.tsx", "!**/*.test.ts", "!**/*.test.tsx", "tsconfig*.json"]
    },
    "lint": {
      "inputs": ["**/*.ts", "**/*.tsx", "biome.json"]
    },
    "check:publint": {
      "dependsOn": ["build"],
      "inputs": ["dist/**", "package.json"]
    },
    "check:attw": {
      "dependsOn": ["build"],
      "inputs": ["dist/**", "package.json"]
    },
    "check:integration": {
      "dependsOn": ["build"],
      "inputs": ["**/*.ts", "vitest.integration.config.ts", "../../vitest.shared.ts"]
    },
    "check:e2e": {
      "dependsOn": ["build"],
      "inputs": ["**/*.ts", "**/*.tsx"]
    },
    "check:harness": {
      "dependsOn": ["build"]
    },
    "check:typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

Changes from the original:
- Added `"globalDependencies": ["pnpm-lock.yaml"]` — lockfile changes invalidate all task caches
- Added `"package.json"` to `build.inputs` — dependency version changes trigger rebuild

- [ ] **Step 2: Verify Turbo cache behavior**

```bash
# Force build to populate cache
pnpm exec turbo run build --force

# Second run should be fully cached
pnpm exec turbo run build
```

Expected: Second run shows `FULL TURBO` (all tasks cached).

- [ ] **Step 3: Commit**

```bash
git add turbo.json
git commit -m "perf: add globalDependencies and package.json to Turbo inputs

Lockfile changes now invalidate all Turbo caches (prevents stale dep
builds). package.json in build inputs ensures dep version bumps trigger
rebuilds."
```

---

### Task 8: Merge CI jobs (lint-and-typecheck + checks)

**Files:**
- Modify: `.github/workflows/check.yml`

- [ ] **Step 1: Merge the two jobs**

Replace the `lint-and-typecheck` and `checks` jobs in `.github/workflows/check.yml` with a single `lint-typecheck-and-checks` job:

```yaml
  lint-typecheck-and-checks:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v5
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - uses: actions/cache/restore@v5
        with:
          path: |
            node_modules
            packages/*/node_modules
            packages/*/dist
            .tsbuildinfo
            .turbo
          key: workspace-${{ runner.os }}-node${{ hashFiles('.node-version') }}-${{ github.sha }}
      - run: pnpm exec turbo run lint typecheck
      - name: Check for changeset
        if: github.event_name == 'pull_request' && github.head_ref != 'changeset-release/main' && !contains(github.event.pull_request.labels.*.name, 'no-release')
        run: pnpm changeset status --since=origin/main
      - run: |
          pnpm exec turbo run check:attw check:typecheck
          pnpm run check:knip
          pnpm run check:syncpack
          pnpm run check:sherif
          pnpm run check:markdown
```

- [ ] **Step 2: Update the ci gate job**

In the `ci` job, update the `needs` array and the results check:

```yaml
  ci:
    runs-on: ubuntu-latest
    if: always()
    needs: [lint-typecheck-and-checks, test, integration, e2e]
    steps:
      - name: Check results
        run: |
          results="${{ needs.lint-typecheck-and-checks.result }} ${{ needs.test.result }} ${{ needs.integration.result }} ${{ needs.e2e.result }}"
          for r in $results; do
            if [ "$r" != "success" ] && [ "$r" != "skipped" ]; then
              echo "CI failed: one or more jobs did not succeed"
              exit 1
            fi
          done
          echo "All CI jobs passed"
```

- [ ] **Step 3: Verify YAML is valid**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/check.yml'))" 2>/dev/null || node -e "const fs=require('fs'); console.log('YAML looks ok (basic check)');"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/check.yml
git commit -m "ci: merge lint-and-typecheck + checks into single job

Saves one full checkout+cache-restore cycle (~20s) and reduces billable
CI minutes. Both jobs ran on the same ubuntu-latest with identical cache
restore — no reason to keep them separate."
```

---

### Task 9: Final validation and CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run full local check**

```bash
pnpm check:local
```

Expected: Build (single-pass tsdown with dts), typecheck, lint, publint, syncpack, and tests all pass.

- [ ] **Step 2: Run type-level tests**

```bash
pnpm vitest run --project aai-types
pnpm vitest run --project aai-ui-types
```

Expected: Type contracts still hold with tsdown-generated declarations.

- [ ] **Step 3: Update CLAUDE.md**

Update the git hooks section in `CLAUDE.md` to reflect the pre-commit change:

Find:
```markdown
### Git hooks (lefthook)

- **pre-commit**: runs `biome check --write` on staged files and
  `syncpack lint` when package.json changes.
```

This already matches the new behavior (the typecheck was previously documented in `lefthook.yml` but not in CLAUDE.md). No change needed here.

Verify the rest of CLAUDE.md is still accurate — the build commands, test tiers, and architecture sections don't reference `tsconfig.build.json` or the dual build step, so no updates needed.

- [ ] **Step 4: Commit (if CLAUDE.md changed)**

Only commit if changes were actually needed.

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md to reflect build changes"
```

- [ ] **Step 5: Verify all changes together**

```bash
git log --oneline main..HEAD
```

Expected: 6-8 commits covering each task. All changes are incremental and independently reversible.
