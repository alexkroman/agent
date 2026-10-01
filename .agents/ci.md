---
summary: >-
  The required check job, `pnpm check`, turbo strict env mode, task `inputs`,
  and the cache paths.
read_when: >-
  touching `turbo.json` or `.github/workflows/check.yml`, or CI disagrees with
  a local run
---

# CI and turbo

## The required check is one job, and it must NOT accept `skipped`

`.github/workflows/check.yml`'s `ci` job is the only required check on `main`.

- **`setup` is in its `needs`** — it runs `pnpm install --frozen-lockfile` and
  `turbo run build`, and every other job depends on it.
- **Only `"success"` passes.** No downstream job has an `if:`, so `skipped` can
  only mean a dependency failed; accepting it turns a failed build into a green
  gate. A job that legitimately skips itself needs its own accepted-result list.
- **`main` — and only `main` — is in its `push` list**, with
  `cancel-in-progress` scoped to pull requests and a per-SHA push group, so every
  commit on `main` gets its own verdict. Specced in
  `packages/aai-gates/CLAUDE.md`.
- **The test matrix names every package with a `test:coverage` script**
  (`aai-evals` included); `check.mjs` runs `turbo run test:coverage` unfiltered,
  so a package missing from the matrix is gated locally and not in CI.
- The matrix runs `turbo run test:coverage --filter`, not `pnpm --filter`, so a
  missing dependency `dist` is rebuilt rather than failing the suite.

## Full CI check (`pnpm check`)

`scripts/check.mjs` is a table plus one runner: the `GATES` rows (`phase`,
`fatal`, `fix`; catalogue in [`ratchets.md`](ratchets.md)) and the turbo task
lists in `scripts/_check-turbo-tasks.mjs`. It runs the ratchet gates in
parallel, then ONE turbo call per mode (dependency-free tasks start at once,
build-dependent ones after `build`, `--continue`), then the after-tests gates,
the later turbo calls (the stubbed `check:eval`, then `check:e2e` alone), and
the after-build gates in source order.

- **`pnpm check:local`** is what the pre-push hook runs. Full mode is a strict
  SUPERSET of it (the runner refuses to start otherwise), and it ends by naming
  what it skipped — computed as full minus local: `check:attw`,
  `check:dedupe`, `check:markdown`, `check:shell`, `check:integration`,
  `check:scenario`, `docs`, `check:e2e` — so a green subset is not read as a
  green branch.
- **`pnpm fix`** runs every auto-fixer: `pnpm format`, then each row's `fix` in
  table order (the `sync:*` copies, `api-report`, `docs:md`, the lower-only
  baseline `*:update`s).
- **CI derives both lists.** The lint job runs `node scripts/check.mjs --turbo ci`
  (full mode's first call minus `CI_ELSEWHERE`, the tasks another job or step
  owns) and `node scripts/check.mjs --gates ci`; `gate-wiring.test.ts` fails if
  either is restated in the workflow.
- **Both modes run `test:coverage`, not `test`**, because the coverage floors
  are what CI gates on. `pnpm check:affected` (and
  `pnpm test:coverage:affected`) use turbo `--affected` against the default
  branch.

**Turbo runs in strict env mode, which strips any undeclared variable.**

- Ambient machine config (`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, …)
  goes in `globalPassThroughEnv`: passed through, kept out of cache hashes.
  Without it, network-using tasks fail only under `turbo run` (e.g. instant
  `ERR_PNPM_FETCH_404`s from the e2e registry uplink).
- A variable that selects what a task DOES (`AAI_TEST_PM`, `VITEST_POOL`,
  `AAI_REQUIRE_*`) goes in that task's `env`, which passes it AND hashes it, so
  two modes cannot share a cache entry. Undeclared, a command-line
  `AAI_TEST_PM=npm pnpm test:e2e` silently runs pnpm.

**Every file a task reads must be hashed by that task.**

- `inputs` globs resolve relative to the PACKAGE, so a repo-root file every task
  reads (the root `tsconfig.json`, `scripts/ensure-guest-harness.mjs`) belongs
  in `globalDependencies`.
- Use `$TURBO_DEFAULT$` (every git-tracked file in the package), not an
  extension list, which misses fixtures, snapshots, CSS and Vite inputs.
  `**/*.md` is subtracted except in `aai-cli` (bundles templates and scaffold)
  and `aai-templates` (its suites read root guides, `scripts/check-*.mjs` and
  `check.yml`).
- `typecheck` must keep `**/*.test.ts` in its `inputs`, since every tsconfig
  includes tests.
- To prove a file is hashed: capture the hash from
  `turbo run <task> --filter <pkg> --dry=json`, touch the file, capture again.
  An identical hash is the bug.

**Caches must point at the directory that is written, in the job that writes
it.**

- `turbo.json`'s `cacheDir` (`.turbo/cache`) and the CI cache `path` must name
  the same directory.
- The `.tsbuildinfo` cache is an `actions/cache` (restore AND save) in the
  typecheck job — the build job never writes it (`incremental: false`) — keyed
  on the tsconfigs plus lockfile with the run SHA appended, since an existing
  key is never re-saved.
