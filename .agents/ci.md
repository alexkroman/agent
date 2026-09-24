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

`scripts/check.mjs` runs every gate in one turbo invocation from its `GATES`
table (`phase`, `fatal`, one runner); turbo starts dependency-free tasks at once
and build-dependent ones after `build`.

- **`pnpm check:local`** runs the subset build, typecheck, lint, publint,
  syncpack, sherif, knip, `test:coverage` with `--continue`, and ends by naming
  the gates it skipped (`check:attw`, `check:markdown`, `check:integration`,
  `check:e2e`, `docs`) so a green subset is not read as a green branch.
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
- To prove a file is hashed: capture `turbo run <task> --filter <pkg>
  --dry=json`'s hash, touch the file, capture again. An identical hash is the
  bug.

**Caches must point at the directory that is written, in the job that writes
it.**

- `turbo.json`'s `cacheDir` (`.turbo/cache`) and the CI cache `path` must name
  the same directory.
- The `.tsbuildinfo` cache is an `actions/cache` (restore AND save) in the
  typecheck job — the build job never writes it (`incremental: false`) — keyed
  on the tsconfigs plus lockfile with the run SHA appended, since an existing
  key is never re-saved.
