<!-- Moved out of AGENTS.md so it is read ON DEMAND rather than loaded into
every task's context. AGENTS.md's "Detailed references" table points here. -->

# CI and turbo

## The required check is one job, and it must NOT accept `skipped`

`.github/workflows/check.yml`'s `ci` job is the only required check on `main`.
Two things about it are load-bearing, and both were missing:

- **`setup` is in its `needs`.** Every other job declares `needs: setup`, and
  `setup` is what runs `pnpm install --frozen-lockfile` and `turbo run build`.
- **Only `"success"` passes.** Under `if: always()`, a loop that also accepted
  `"skipped"` meant a failing build failed `setup`, GitHub reported all five
  downstream jobs as `skipped`, and the gate printed **"All CI jobs passed"**
  and exited 0. No downstream job carries an `if:` of any kind, so `skipped`
  can only ever mean "a dependency failed"; a job that legitimately skips
  ITSELF would need its own accepted-result list, never a blanket `skipped`.

**And `main` is in its `push` list — ONLY main.** Without it nothing evaluated
the branch, only merge refs (#1112: Release broke on 20 of 30 pushes), and the
version branch beside it ran every Version Packages push through this matrix
TWICE. Each commit needs its own verdict, which takes `cancel-in-progress`
scoped to pull requests AND a per-SHA push group. A PR result is also never
recomputed after its base moves, which only branch protection can close. Both
push-list rules and the group are specced — see `packages/aai-templates/CLAUDE.md`.

**The test matrix names every package with a `test:coverage` script**, which
now includes `aai-evals` — absent for a long time, so its seven unit suites and
its four coverage floors were gated by nothing in CI while passing locally
(`check.mjs` runs `turbo run test:coverage` unfiltered). That is the
green-locally/red-in-CI asymmetry running backwards, and it made a PR that
breaks those suites fully green. It is NOT the documented eval-tier exemption,
which is scoped to `check:eval`.

## Full CI check (`pnpm check`)

Runs via `scripts/check.mjs` in a single turbo invocation for maximum
parallelism. Turbo handles the dependency graph — tasks with no
dependencies (lint, test, syncpack, sherif) start immediately while
build-dependent tasks (typecheck, publint, attw) wait for build.
The gates are a `GATES` **table** there (`phase`, `fatal`, one runner);
that file's doc carries the argument.

Turbo runs tasks in **strict env mode**, so proxy/CA variables
(`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, …) are listed in
`globalPassThroughEnv` in `turbo.json` — passed through to tasks but kept
out of cache hashes. Without this, any task that makes real network calls
(the e2e suite's verdaccio→npmjs uplink) silently loses its egress config
in proxied environments and fails with misleading errors (instant
`ERR_PNPM_FETCH_404`s) that only reproduce under `turbo run`, never when
running the underlying script directly.

**Strict mode also silently drops any variable a HUMAN sets on the command
line**, which is the failure mode the passthrough list does not cover.
`AAI_TEST_PM=npm pnpm test:e2e` — the documented way to reproduce a user
report under another package manager — ran pnpm, because `pnpm test:e2e` is
`turbo run check:e2e` and `AAI_TEST_PM` was declared nowhere. Same for
`VITEST_POOL`. Both now sit in the owning task's **`env`** rather than
`globalPassThroughEnv`: `env` passes the variable through AND puts it in the
hash, so an npm run and a pnpm run cannot share a cache entry — which
passthrough alone would let them do. A variable that selects what a task
actually does belongs in `env`; `globalPassThroughEnv` is for ambient
machine config (proxies, CA bundles) that must not fragment the cache.

**A file a task depends on must be hashed by that task, and `inputs` globs
resolve RELATIVE TO THE PACKAGE — so anything at the repo root belongs in
`globalDependencies`.** This is the same failure the `typecheck` task's
`**/*.test.ts` note below describes, and the root `tsconfig.json` sat in it:
every package `extends` that file, so it defines `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `target` and
`customConditions` for the whole repo, and `tsconfig*.json` in the task's
`inputs` matched only the package's own copy. Demonstrated on a clean tree:
warm the cache, weaken the root config until `tsc -p packages/aai` reports an
error, re-run — `2 cached, 40ms >>> FULL TURBO`, and `build` the same. CI was
safe only by accident (its turbo cache does not survive between runs), so the
gate this actually broke was the PRE-PUSH HOOK, i.e. green locally and red in
CI. `lint` had it right all along with `../../biome.json`, and `test` with
`../../vitest.shared.ts`; a per-task `$TURBO_ROOT$/…` entry works too, but the
global is the one the next task cannot forget.

**The other half of that rule is that an EXTENSION LIST is not a description
of a task's inputs, and `$TURBO_DEFAULT$` is.** The same audit found five more
of these, all with the same shape — the glob list named the file types that
existed when it was written. `test` hashed `**/*.ts` only, so every JSON
fixture (`aai/host/fixtures/`, `aai-ui/fixtures/`, `aai-server/
compat-fixtures/`) and every `__snapshots__/*.snap` could change under a cached
green run — including the obsolete snapshot that `update: "none"` exists to
turn into a failure. `build` missed the Vite inputs of the two packages that
have them (`index.html`, `styles.css`, `public/**`, `src/fonts/*.woff2`), so a
Tailwind-only change was a FULL TURBO replay and CI's setup job handed that
stale `dist` to every downstream job. `lint` hashed no JSON or CSS although
`biome check .` lints both. Those tasks now take `$TURBO_DEFAULT$` — every
git-tracked file in the package — minus `**/*.md` (no build or test reads it,
and CHANGELOG.md is rewritten by every release). The two packages that DO read
markdown re-include it: `aai-cli`, which bundles the templates and scaffold as
shipped product, and `aai-templates`, whose suites read repo-root files —
`../../CLAUDE.md`, `../*/CLAUDE.md`, `scripts/check-*.mjs`, `scripts/check.mjs`,
`.github/workflows/check.yml` — and so had the gates-that-guard-the-gates
served from cache exactly when the file they check changed. Prove any of this
the same way: capture `turbo run <task> --filter <pkg> --dry=json`'s hash,
touch the file, capture again. An identical hash is the bug.

Three live instances of both rules were found by the documented A/B and fixed
together: `scripts/ensure-guest-harness.mjs` is `aai-server#test`'s own vitest
`globalSetup` and was in neither `inputs` nor `globalDependencies` (it is a
repo-root file, so it is in the global list now); `check:e2e` hashed neither
`vitest.shared.ts`, which it reaches through the slow config, nor `VITEST_POOL`,
which the other four test tasks all declare.

Relatedly, **`cacheDir` and the CI cache path have to name the same
directory.** They did not: `turbo.json` set
`node_modules/.cache/turbo` while `check.yml` cached `path: .turbo`, which
does not exist (it IS in `.gitignore`, which is what made it look plausible),
so the "Cache Turborepo" step saved and restored nothing and every CI run
type-checked cold. `cacheDir` is now `.turbo/cache`, which is what the
workflow and `.gitignore` already assumed.

**And a cache has to live in the job that WRITES the thing.** The
`.tsbuildinfo` cache sat in the `setup` job, which only runs `turbo run
build` — and the build configs set `incremental: false`, so that job never
creates the directory (verified: `turbo run build --force` leaves no
`.tsbuildinfo/`; `pnpm --filter aai typecheck` writes two files into it).
The job that does write it, `lint-typecheck-and-checks`, only ever restored.
So nothing was saved and tsc ran cold on every turbo cache miss, for the same
reason as the `cacheDir` bug and with the same symptom of a step that looks
right in the diff. The cache is now a `actions/cache@v6` (restore AND save)
in the typecheck job, keyed on the tsconfigs plus the lockfile with the run
SHA appended — a key that already exists is skipped on save, so a SHA-less
key would pin the first run's buildinfo forever.

The `test` matrix goes through `turbo run test:coverage --filter` rather than
`pnpm --filter` for a related reason: run directly, it assumes the workspace
cache restored every dependency's `dist`, and when that assumption fails the
suite dies on a missing built artifact rather than rebuilding one.

`pnpm check:local` uses the same script with `--local` flag, running a
subset: build, typecheck, lint, publint, syncpack, sherif, knip,
test:coverage — all in one turbo call with `--continue` (shows all failures
at once). It ends by NAMING the gates it did not run (`check:attw`,
`check:markdown`, `check:integration`, `check:e2e`, `docs`), because a green
subset otherwise reads as a green branch and those are the failures hardest
to predict from a diff.

**Both modes run `test:coverage`, not `test`** — see the coverage ratchet
below: the floors are what CI's test matrix gates on, so running plain `test`
locally made a floor failure invisible until CI. It costs almost nothing
(measured on aai-ui: 17.0s → 17.9s).

`pnpm check:affected` uses turbo's `--affected` to run tasks only for packages
changed since the default branch (also `test:coverage`, same reason);
`pnpm test:coverage:affected` is the coverage half on its own.
