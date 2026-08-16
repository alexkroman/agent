# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

The root `CLAUDE.md` is a one-line import of this file (`@AGENTS.md`) and
carries no content of its own — `AGENTS.md` is the name every other agent tool
looks for, so keeping the guide here means one canonical copy rather than a
per-tool set that drifts. Edit THIS file; never paste content into
`CLAUDE.md` (`check-claude-md.mjs` and
`packages/aai-templates/claude-md-limit.test.ts` both fail if you do — this
line used to cite an `agents-md-shim.test.ts` that has never existed in the
tree, which mattered because the parenthetical is the whole reason an author
believes the rule is checked). Package guides stay
named `CLAUDE.md`: Claude Code auto-loads a package's guide when you work in
that directory, which is the behaviour those files exist for, and
`konsistent.json` requires one per package.

## Overview

AAI is a voice agent development kit. Users define agents as directories
containing `agent.ts`. The CLI bundles and deploys them to the managed platform.

- **Platform**: `agent.ts` → CLI bundle → deploy to managed server

## Commands

```sh
pnpm install             # Install dependencies
pnpm test                # Run all unit tests (vitest)
pnpm lint                # Run Biome linter (all packages)
pnpm typecheck           # Type-check all packages
pnpm lint:fix            # Auto-fix lint issues
pnpm check:konsistent    # Structural conventions (konsistent.json)
pnpm check:local         # Fast pre-commit gate (single turbo invocation, max parallelism)
pnpm check:affected      # Only check packages affected by changes since main
```

### Test tiers

**Tiers are cut by what a test may TOUCH: pick the tightest one that can express
the assertion.**

| Tier | Command | Membership rule | Timeout |
| --- | --- | --- | --- |
| Unit | `pnpm test` | no filesystem writes, subprocess, or real network | 5s |
| Integration | `pnpm test:integration` | multiple modules **in memory** | 30s |
| Scenario | `pnpm test:scenario` | a real subprocess, port, bundler, or Postgres | 120s |
| Scenario + real Postgres | `pnpm test:pg` | the above, `AAI_TEST_PG_URL` resolved | 120s |
| E2E | `pnpm test:e2e` | full process spawn + Playwright browser | 300s |
| Eval | `pnpm test:eval` | a live model on a real key, `*.eval.test.ts` | 1800s |
| Templates | `pnpm test:templates` | template agent example tests | 5s |

**The eval tier REPORTS and does not gate** — absent from `pnpm check` and CI,
because a measurably noisy instrument must not block a merge. Runs repeat and the
report carries a spread; `packages/aai-evals/CLAUDE.md` owns it.

They used to be separated by TIMEOUT, a proxy for the rule above that stops being
one as soon as two tests are slow for unrelated reasons. `pipeline-fuzz` (pure
memory) and `platform-schema` (needs a database) shared one tier, timeout, retry
policy and serial block, so neither was configured for its own failure mode — and
`pnpm test:integration` took **721 seconds to evaluate twelve tests**, 50 of 63
skipping for want of a database. It is 10 seconds now.

**Membership is a NAMING CONVENTION** — `*.integration.test.ts`,
`*.scenario.test.ts` and `*.eval.test.ts`, excluded by every unit config and
selected one each by the scripts, so a new test needs no config edit (see
"Integration- and scenario-tier membership" below for the deliberate exceptions).

**No tier carries a `retry`** — a tier that retries has classified its own
failures as noise; `vitest.slow.config.ts` carries the argument.

**Seven scenario suites need a real Postgres, and without one they SKIP** — a
silent skip being the worst outcome available, since that tier is the only thing
in the repo that can see a driver-level bug. `pnpm test:pg` resolves a local
database and runs the tier against it; a skip ANNOUNCES itself via
`describeWithPg` / `describeWithStack`; and `AAI_REQUIRE_PG` / `AAI_REQUIRE_STACK`
turn a skip into a hard failure, declared in the `check:scenario` task's `env` in
`turbo.json` because strict env mode would otherwise strip them and the
enforcement would silently do nothing. **`AAI_REQUIRE_STACK` is only exported
when a stack really resolved, so `scripts/with-test-pg.mjs --require-stack` is
what makes "no stack" a FAILURE** — without the flag every failure path (no
CLI, stack down, unparsable `supabase status -o env`) printed two lines and
exited 0, so `supabase start` succeeding while that output changes shape gave a
green platform-stack job in which `realtime-rls.scenario.test.ts`, the only
walrus/RLS leak test in the repository, never ran. CI passes the flag; `pnpm
test:pg` deliberately does not, because a developer on a plain 5432 is entitled
to the narrow arm with a printed reason. **`AAI_REQUIRE_REGISTRY` is the same shape
one tier up**, in `check:e2e`'s `env` — see `packages/aai-cli/CLAUDE.md`. The
whole gate, including the vitest collection trap that makes `pgUrl()` illegal at
the top of a gated `describe` body, is in `packages/aai-server/CLAUDE.md`,
"Gating a suite on a real Postgres".

### Single-package shortcuts

```sh
pnpm test:aai-core       # Run only aai unit tests
pnpm test:aai-ui         # Run only aai-ui unit tests
pnpm test:aai-cli        # Run only aai-cli unit tests
pnpm test:aai-server     # Run only aai-server unit tests
pnpm test:aai-studio-client  # Run studio front-end unit tests
pnpm test:templates      # Run template agent tests
pnpm dev:aai-server      # Start aai-server in dev mode
```

### Running specific tests

```sh
pnpm vitest run --project aai                   # Single package via --project
pnpm vitest run packages/aai/types.test.ts      # Single file
pnpm vitest run session                         # All files matching "session"
pnpm --filter @alexkroman1/aai test             # Single package via pnpm filter
```

### The required check is one job, and it must NOT accept `skipped`

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

**And `main` is in its `push` list.** Without it every run evaluated a merge
ref and nothing evaluated the branch, so "PRs are green" said nothing about
main — while `release.yml` / `deploy.yml` / `docs.yml`, which no PR runs, broke
unreported (Release: 20 of 30 consecutive pushes; #1112 has the shape).
`cancel-in-progress` is scoped to pull requests for the same reason: each
commit on main needs its own verdict. A PR result is also never recomputed
after its base moves, which only branch protection can close.

**The test matrix names every package with a `test:coverage` script**, which
now includes `aai-evals` — absent for a long time, so its seven unit suites and
its four coverage floors were gated by nothing in CI while passing locally
(`check.sh` runs `turbo run test:coverage` unfiltered). That is the
green-locally/red-in-CI asymmetry running backwards, and it made a PR that
breaks those suites fully green. It is NOT the documented eval-tier exemption,
which is scoped to `check:eval`.

### Full CI check (`pnpm check`)

Runs via `scripts/check.sh` in a single turbo invocation for maximum
parallelism. Turbo handles the dependency graph — tasks with no
dependencies (lint, test, syncpack, sherif) start immediately while
build-dependent tasks (typecheck, publint, attw) wait for build.

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
`../../CLAUDE.md`, `../*/CLAUDE.md`, `scripts/check-*.mjs`, `scripts/check.sh`,
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

`pnpm check:affected` uses turbo's `--affected` flag to only run tasks
for packages changed since the default branch (also `test:coverage`, same
reason); `pnpm test:coverage:affected` is the coverage half on its own.

### Quality ratchets

Beyond lint/typecheck/test, `scripts/check.sh` **and the CI check job** run
nine **gates** (all also runnable standalone) that hold the line on technical
debt. Two compare against a COMMITTED PER-FILE BASELINE
(`check:hatches`, `check:invariants`); the rest are absolute. They must stay
wired into BOTH: for a long time they lived only in `check.sh`, which CI never
invokes, so the only thing enforcing them was the pre-push hook — and
`git push --no-verify` skipped them entirely.

**None of them resolves a git ref any more, and that is deliberate.** The
escape-hatch gate used to diff the work tree against its merge-base with
`origin/main`, which had three failure modes documented as known weaknesses
rather than fixed: a grand total let a branch trade a removed hatch for a new
one elsewhere; a stale branch was charged for every occurrence its ancestors
added (+47 when `as unknown as` was first counted, hence the standing advice to
"land a new pattern directly on top of origin/main" — i.e. work around the
gate); and with no `origin/main` to resolve, it printed "skipping ratchet" and
exited 0, which is the shape of failure this repo keeps finding, a gate
reporting success while checking nothing, in exactly the environments that get
one commit of history. A file in the tree has no merge base and no such modes.

- **`pnpm check:hatches`** (`scripts/check-escape-hatches.mjs`) — counts
  static-analysis escape hatches (`@ts-expect-error`, `@ts-ignore`,
  `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `as any`,
  `as unknown as`, `as never`) across `packages/` and `scripts/` and holds each
  FILE to the count recorded in `scripts/escape-hatch-baseline.json`. A file
  may hold fewer; it may never hold more; a file absent from a pattern may
  hold none.
  Fix the underlying type/lint error instead of suppressing it. On failure it
  **names the offending lines** (`file:line` plus the source line) under each
  file over budget.

  **Per-file, not a grand total**, which is what makes the ratchet actually
  ratchet: the old total-based version passed a branch that removed one hatch
  and added another somewhere else — verified by A/B, the total stayed at 122
  and the per-file gate caught it.
  **The engine counts OCCURRENCES, not matching lines** — `git grep -o`. Both
  baselines describe themselves as recording occurrences and for a long time
  recorded lines: three casts on one line reported `found 1`, the same three on
  three lines reported `found 3`. Honest when it was measured (94 lines against
  94 occurrences) and structurally wrong, because a file at its budget could
  absorb more by appending them to the line that bought the budget. The scan is
  two passes: `-n` for the source line the report prints and the comment filter
  decides on, `-o` for the count.

  **And `assertScanCorpus` diffs `git ls-files` against `git grep -lI`, because
  ONE control character makes a whole file invisible.** A single raw NUL makes
  a file BINARY to `git grep`, which silently exempts it from every line rule
  and every hatch pattern — and the corpus floor cannot catch it BY DESIGN,
  since the file is still in `git ls-files`. It has cost this repo three times
  now (`host/workflow-notify.ts`, `host/workflow-keys.ts`, and
  `konsistent-config.test.ts`, which used raw NULs as regex placeholder
  sentinels); the first two were fixed one byte at a time with no detector
  added, which is the argument for the detector. Spell the character as an
  escape — byte-identical behaviour, and the file is text again. A genuinely
  binary extension goes in `KNOWN_BINARY` in `scripts/_ratchet.mjs`, which is a
  DENY-list so a new source extension defaults into being checked.

  **The three CAST patterns skip COMMENT-ONLY lines; the five suppression
  patterns do not.** A `biome-ignore` genuinely is a comment, and suppressing
  the rule is what the comment does — but a cast named in prose is prose. Of
  119 counted hatches, 25 sat on comment lines; 21 were correct and all four
  cast hits were JSDoc, two of them the ENTIRE `as any` budget. So a real
  `export const smuggled = (globalThis as any).x;` could move into that budget
  with the gate still printing `as any allowed=2 now=2 … ✓`, demonstrated on
  the real gate. `guard-invariants` had solved this all along with a per-rule
  `skipComments` flag; this gate called the same `scanGroups` with no filter.

  **`as never` is counted, and it is strictly worse than `as unknown as`.**
  `never` is assignable to everything, so `{ … } as never` passes any parameter
  position, and like the double cast it stops reporting the moment a field is
  ADDED to the type it stands in for. It was the dominant type-laundering idiom
  here while uncounted — 110 occurrences in tests against 62 of the counted
  `as unknown as`, and 98 -> 110 over three days while the counted pattern went
  63 -> 62. Uncounted patterns grow; that is the argument. The campaign to
  remove them is the one that halved `as unknown as`: a TYPED SEAM per
  concentration, never a cast per assertion.

  `node scripts/check-escape-hatches.mjs --update` lowers the baseline to match
  the tree and **refuses to raise anything**, so recording a removal is one
  command and blessing an addition needs a hand edit that lands in a reviewable
  diff. A run that is under budget WARNS, naming the entries to give back —
  unclaimed headroom is a hatch the next branch gets for free.

  **Both baseline ratchets now share one engine (`scripts/_ratchet.mjs`), and
  both take a CORPUS FLOOR: the pathspecs must resolve to at least 800 files or
  the run fails.** `git grep` exits 1 both for "no matches" and for "pathspec
  matched nothing", and the two are indistinguishable from the exit code — so a
  package rename or a typo'd `:!` exclusion made every pattern report `now=0`,
  which then degraded to the stale-warning path and printed a checkmark. The
  floor is on the CORPUS rather than on the match count deliberately: these are
  DEBT ratchets whose goal is zero, so a minimum match count would eventually
  block the very campaign the gate exists to encourage.

  **Markdown is not scanned**, and the reason is worth keeping: the patterns
  are plain substrings with no notion of code versus prose, so any doc that
  *discusses* a hatch scores as one. `CHANGELOG.md` is the sharp edge —
  changesets generates it from changeset summaries, so a summary describing
  this script's own `as any` / `as unknown as` patterns rendered into
  `packages/aai/CHANGELOG.md` and failed the **Version Packages PR**, on a
  file no human wrote and with nothing an author could see at review time.
  A changeset summary may name a pattern freely. `escape-hatch-scope.test.ts`
  guards the exclusion, and asserts the patterns really do match prose so the
  test can't pass by the patterns quietly becoming narrower.

  **`as unknown as` is the one to watch, and the reason it is counted.** It
  launders a value past the checker without tripping `as any`, and while it
  went uncounted it became the dominant idiom here: 210 of them against 3
  `as any` (all three of which are prose in comments, not casts). Counting it
  came with halving it to 105, and the removals are the pattern to copy — a
  concentration of identical casts is a missing **typed seam**, one narrowing
  in one helper that every call site goes through (`fakeOf(session)`,
  `asSessionWs(ws)`, `MockWebSocketConstructor`), not a cast repeated per
  assertion. Some need no cast at all once the tool's own affordance is used:
  `vi.mocked(fn)` instead of casting a mock back to a spy, and typing a
  recorder with `Parameters<T>` instead of widening to
  `Record<string, unknown>` and re-narrowing at each read.

  One property to know before editing the baseline: it is itself a file whose
  content is a list of the pattern names, so it needs the same pathspec
  exclusion the script does. That was not theoretical — the first run after the
  per-file conversion scored its own `"as unknown as": { … }` keys as four fresh
  hatches. Same trap as markdown above, arriving by a new route.
- **`pnpm check:file-length`** (`scripts/check-file-length.mjs`) — caps
  source files at 500 lines and test files at 700. Files that already
  exceed the cap are grandfathered in `scripts/file-length-allowlist.json`,
  which records each file's current ceiling; a grandfathered file may not
  grow past its ceiling, and ceilings should only ever be lowered as files
  are split up. New files must come in under the cap. Templates under
  `packages/aai-templates/templates/` are exempt.

  **Its `scripts/` pathspec measured nothing at the top level for as long as it
  existed**, which is worth keeping because the trap generalizes to every git
  pathspec in the repo. A pathspec is fnmatch WITHOUT `FNM_PATHNAME`, so `*`
  already crosses `/` and `scripts/**/*.mjs` parses as "scripts/" + anything +
  "/" + anything + ".mjs" — the literal slash makes a subdirectory MANDATORY. It
  therefore matched the files under `scripts/starter-eval/` and not one of
  the ~29 at the top level — exactly where an unreviewed harness hides — while
  printing "all files within caps ✓".
  Adding `scripts/*.mjs`/`scripts/*.ts` took the measured set from 6 files to 35.
  **The same trap was live in both ratchets' `:!scripts/**/*.md` exclusions**,
  which excluded nothing at the `scripts/` top level for the identical reason;
  `:!scripts/*.md` now sits beside each of them.
  `packages/**/*.ts` is unaffected and not by luck — every source file there is
  at least one directory deep — which is why the miss survived review. Verify any
  pathspec with `git ls-files "<glob>"` rather than reading it;
  `file-length-gate.test.ts` now pins both shapes.
- **`pnpm check:test-assertions`** (`scripts/check-test-assertions.mjs`) —
  fails on any `test()`/`it()` body containing no `expect` / `expectTypeOf` /
  `assert`. A test with no assertion still runs the code, still counts in the
  green total, and still shows up in COVERAGE, while checking nothing but "did
  not throw synchronously" — indistinguishable from real coverage at every
  level anyone looks at. Nine were found: `"/health returns ok JSON"` never
  sent a request (a real version lived 30 lines below it),
  `"onHistory appends and onUserTranscript pushes user messages"` checked none
  of its three claims, and `"does not block different keys on each other"`
  encoded its invariant as a bare `await`, so a regression would HANG to the
  suite timeout rather than fail. **"Does not throw" is legitimate — it just
  has to be said**: `expect(fn).not.toThrow()`,
  `await expect(p).resolves.toBeUndefined()`, `expect.fail(msg)` in place of a
  bare `throw`.

  There is deliberately **no allowlist**: an entry would assert that some test
  rightly checks nothing, which is never true. It does carry FLOORS (200 files,
  2,000 tests), for the reason the corpus floor above exists: its whole success
  output is a count, so a glob or a parser that stopped matching would print
  "all 0 test(s) assert something ✓" and pass. Two things the gate needs to
  stay trustworthy, both learned by getting them wrong: it masks comments and
  string literals before scanning (a JSDoc paragraph *about* `test()` is not a
  test, and three files here have one), and it excludes
  `RegExp.prototype.test` via a lookbehind — `/re/.test(x)` produced five of
  the first run's eight reported offenders. Its own parser is specced in
  `packages/aai-templates/test-assertion-gate.test.ts`, because a gate whose
  entire success output is a count fails SILENTLY: a parser that stopped
  recognising `test(` would print "all 0 test(s) assert something ✓", which is
  the same shape as the bug it exists to catch.
- **`pnpm check:claude-md`** (`scripts/check-claude-md.mjs`) — caps every guide
  (this file, each package's `CLAUDE.md`, the scaffold's included) at
  **120,000 characters**, 20% under
  the ~150k ceiling past which an agent's context silently drops the rest of
  the file. Silently is the problem: nothing warns, the guide is just
  half-absent, which is how the root file reached 233k one well-justified
  paragraph at a time. The fix when it fails is to MOVE a section into the
  owning package's guide and leave a pointer (see "Package guides" and
  "Updating AGENTS.md"), not to delete rationale — except in the scaffold
  guide, which ships to users and has no packages to push sections into.
  It also PINS the root `CLAUDE.md` to the single line `@AGENTS.md`: an
  11-character file passing a 120k cap proves nothing, and a shim that grew
  back into a second copy of the guide is the failure this two-name pattern
  invites — Claude Code would read it and every other agent tool would read
  `AGENTS.md`, with no symptom until the two halves disagreed.
  **The same cap is also a TEST**
  (`packages/aai-templates/claude-md-limit.test.ts`), so it fails in the
  ordinary test run and not only in `pnpm check` — an agent editing a guide
  sees it without knowing this gate exists. It asserts both lines separately
  (over budget = refactor before adding more; over 150k = a guide is being
  truncated right now), that the root still links every package guide, and
  that the script and CI wiring still agree with it.
- **`pnpm check:konsistent`** ([konsistent], config in root `konsistent.json`)
  — enforces **structural** conventions: the shapes that are wrong only in
  relation to their siblings, which is why no per-file tool can see them.
  Biome lints statements and tsc type-checks a program; neither can say "every
  module in this directory must look like the others." The thirteen
  conventions cover the four things this repo restates by hand — the
  per-package file set (`package.json`, `tsconfig.json`, `vitest.config.ts`,
  `CLAUDE.md`, plus README/`tsconfig.build.json`/`tsdown.config.ts` on the
  three published ones) and each `vitest.config.ts` importing `sharedConfig`;
  `*-barrel.ts` files being pure re-export surfaces; the **dependency-graph
  boundaries** under "Dependency flow" (aai imports no sibling, the CLI
  imports neither server nor guest, the guest imports no server code, aai-ui
  imports only the core SDK); and the repeated-by-construction shapes — every
  STT/TTS/LLM/S2S provider module's `*_KIND` / `*_API_KEY_ENV` / `*Options` /
  `*Provider` / factory / `resolve*Settings` set, and every template's
  `agent.ts` + `client.tsx`. `pnpm check:konsistent-config` (`konsistent
  validate`) checks the config against its schema without touching the tree.

  It used to be fourteen: `template-tools` checked an export NAME that no longer
  exists. A tool is now DISCOVERED — a file in `tools/` is the tool, named by its
  own filename, registered by no one — so there is nothing per-file left to
  assert. See "A `tools/` file IS the tool" in `packages/aai-templates/CLAUDE.md`.

  Two things to know before editing `konsistent.json`. **A convention that
  matches nothing passes** — a typo'd `paths` glob checks zero files and prints
  the same "No violations found" as a healthy run, with no error anywhere, so
  `packages/aai-templates/konsistent-config.test.ts` asserts every pattern's
  literal prefix exists (plus that each convention is named, described, and
  declares at least one predicate). And **the case maps compose**:
  `kebabToCamelMap` is DERIVED from `kebabToPascalMap` when absent, so
  declaring `openai: OpenAI` for the type names silently turns the expected
  factory name into `openAI`. The identity entries in `kebabToCamelMap`
  (`openai: openai`, `openrouter`, `elevenlabs`) look redundant and are what
  keep `openai()` right.

  The version is pinned **exactly** (`1.0.0-beta.4`, the registry's `latest`)
  rather than caret-ranged, because a `^` range over a prerelease drifts onto
  `1.0.0-beta.6` — which renames the predicates (`export` → `exportValues`,
  `import` → `importValues`, `importFrom` → `importValuesFrom`). Read the
  predicate catalog from `node_modules/konsistent/docs/`, not the GitHub
  README, until that pin moves; the two disagree.

  [konsistent]: https://github.com/vercel-labs/konsistent

- **`pnpm check:invariants`** (`scripts/guard-invariants.mjs`, rules in
  `scripts/guard-invariants-rules.mjs`) — **the mechanical half of this file.**
  Seventeen numbered rules, each printing WHY the invariant exists and what to use
  instead, so a violation is self-correcting and a reviewer never re-explains
  it. Every one used to live only as prose here, and prose is enforcement
  exactly as long as somebody remembers it at review time.

  | # | Rule | Instead |
  | --- | --- | --- |
  | 1 | no symlinks anywhere | a real file, or a module that re-exports |
  | 2 | no conditional spread of an object literal — the ternary, the inverted ternary, or the `&&` form | `omitUndefined()` |
  | 3 | no `Promise.race` against a `setTimeout`, WRAPPED FORM INCLUDED | `p-timeout` |
  | 4 | no inline `new Promise(r => setTimeout(r, 0))`, `setImmediate` and `<T>` included | `flush()` / `tick()` |
  | 5 | no `delete process.env.X` | `vi.stubEnv(name, undefined)` |
  | ~~6~~ | *retired — `ctx.state` no longer exists* | `sessionSlot()` |
  | 7 | no floating-tag GitHub Action | a 40-char commit SHA |
  | 8 | no `if (m.get(k) === mine) m.delete(k)` | `createOwnedMap()` |
  | 9 | no `tails.get(k) ?? Promise.resolve()` | `createKeyedLock()` / `slot.update` |
  | ~~10~~ | *retired — `research/` no longer exists* | — |
  | 11 | no hardcoded `/tmp` in shipped source | `join(tmpdir(), …)` |
  | 12 | every guest route literal is in `GUEST_ROUTES` — `aai-guest` AND the `aai/host` modules it bundles | declare it + its exposure |
  | 13 | no template import escaping its template dir | move it in, or publish it |
  | 14 | no fixture directory nothing reads | delete it, or add the reader |
  | 16 | no new `on*` on a SESSION callback surface | an event + `report(event)` |
  | 17 | no open-coded record guard, in either polarity | `isRecord()` |
  | 18 | no `req.url.split("?")` | `requestPath()` / `requestQuery()` |
  | 19 | no hand-rolled sleep (or `node:timers/promises`), `<T>` included | `sleep()` |
  | 20 | no changeset naming a package or bump type that does not exist | the real name from its package.json |

  Rule IDs are **stable** — the numbers appear in commit messages and in the
  baseline, so a deleted rule leaves its number retired rather than letting a
  later rule inherit it (rule 6, retired when `ctx.state` stopped existing;
  rule 10, retired with the `research/` directory it checked; and 15,
  reserved). Rules 1, 7, 9, 12, 13, 14 and 20 are at zero and enforced
  absolutely; the rest carry per-file baselines. **Rule 3 left that list when it
  was widened**: `git grep` is line-based, so the wrapped `Promise.race([` form
  Biome emits can only be matched by reporting the OPENING line, which cannot
  see whether a timer is among the elements — so a timer-free wrapped race is a
  legitimate baseline entry (`aai-server/guest-readiness.ts` is the one).
  Over-reporting a race is the cheap error; every finding in this family is a
  guard that under-reports silently.

  **Five scopes, five corpus FLOORS**, and three of the five were missing —
  rule 11's shipped-source corpus (~1,027 files, covered by neither existing
  call, and the Windows-portability rule whose regressions are invisible on
  every machine that runs CI), rule 12's guest HTTP surface, and rule 13's 175
  template files. The last two derive their corpus from `git ls-files`, which
  exits **0** on a pathspec matching nothing where `git grep` exits 1 — that
  asymmetry is exactly why the grep-based rules announced their own blindness
  and these two could not.

  **The rule definitions are five modules behind one barrel.**
  `guard-invariants-rules.mjs` re-exports `LINE_RULES` (sorted by id) and the
  five scope constants, so nothing downstream changed; under it sit
  `-ere.mjs` (the regex vocabulary), `-scopes.mjs` (the five corpora), and
  `-rules-timing.mjs` / `-rules-shape.mjs` / `-rules-state.mjs`. **Every one of
  them is in the gate's `SELF_REFERENTIAL` set**, because each `label` and `re`
  is a description of the thing it bans — a split that forgot one file would be
  the fifth time this repo pays for that trap. A rule may also carry its own
  `samples: { matches, ignores }`, which is where a widened pattern's proof
  belongs: rule 3 shipped for months with a single-line positive sample in
  another package while the rule was blind to the multi-line form.
  `node scripts/guard-invariants.mjs --rules` prints the whole catalogue,
  DERIVED from the rule definitions — the prose copy that used to live in the
  script's header went three rules stale (17, 18 and 19 were absent) while the
  one computed line, the printed count, stayed right. The per-file baselines
  carry the same `--update`-only-lowers contract as `check:hatches`.

  **Every baselined occurrence is legitimate, and the JSON is NOT where it says
  so** — that file is a bare `{path: count}` map written by `--update`, with
  `_description` its only prose, so a reason recorded there would be erased by
  the next regeneration. A reason lives at the OCCURRENCE, in a comment beside
  the line, and the roster is here: three spread-ternaries where **the guard
  is not the value** (`String(params.port)` would stringify `undefined` into
  `"undefined"`; `{ mode: 0o700 }` sets a different value from the one it
  tests), the CLI test setup's env scrub, one hand-rolled owned-map in
  `studio-sse.ts`, the two `/tmp` literals that name a path inside the Linux
  sandbox rather than on this machine, one record guard over a declared
  union, one `.split("?")` that cuts a Vite module id rather than a
  request target, one hand-rolled sleep inside a fixture of USER code (a
  user's own agent may not import an SDK internal, so the hand-rolled form is
  what that fixture is demonstrating), and the two `scripts/*.mjs` guards that a
  plain-node gate cannot replace with an SDK import.

  Rule 4's nine are zero-delay yields that cannot use `flush()`/`tick()`:
  `tool-executor.ts`'s `setImmediate` between tool calls (shipped source, where
  a test helper is not the remedy), the S2S fuzz harness's `drain()` — its own
  doc has the measurement, `setTimeout(0)`'s ~1 ms floor costing that suite
  ~60 s across tens of thousands of yields with no timer in the path to jump
  ahead of — and six in packages not importing `aai/host/_test-utils.ts`.

  **The frozen `contracts/compatibility/**` examples are no longer baselined at
  all** — they are excluded from every line rule by a pathspec in
  `SOURCE_PATHSPECS` (read the comment there). That is the rule, not a
  convenience: an exemption is per FILE *and* per RULE, so the next widened rule
  re-opens the hole a per-file baseline had closed. Which is exactly what rule
  2's widening did — four reviewers reported the same frozen file
  independently.

  **Three of these rules found real bugs on the day they were written**, which is
  the argument for the whole gate. Rule 2 caught two `omitUndefined`
  conversions the documented 44-site sweep had missed (`host/s2s.ts`,
  `secret-handler.test.ts`). Rule 11 came out of a Windows CI leg that failed on
  two shipped modules writing to a literal `/tmp` — a path that is
  drive-relative on Windows — both of which run on a developer's own machine
  under `aai dev`, so the bug was never guest-only. See "Windows is NOT tested,
  and is currently broken".

  **Rule 20 (from vercel/eve's rule 29) closes a gate that reported success over
  a mistake**, in the release path. A changeset whose package key is a typo is
  IGNORED rather than rejected: `pnpm changeset status --since=origin/main` —
  what the pre-push hook already runs — prints an empty bump list and exits 0,
  verified by adding `"@alexkroman1/aai-typo": patch`. The release silently does
  not happen and it surfaces after merge, on a branch that is gone. The rest of
  the argument, including why it is its own module, is in
  `scripts/guard-invariants-changesets.mjs`.

  Rule 19 found a **sixth** hand-rolled `sleep` that no gate here could see:
  `host/workflow-notify.ts` held a raw NUL byte, which makes a file BINARY to
  `git grep` — so it was silently exempt from all nineteen rules and from
  `check:hatches`. Fixing the byte is what made the rule find the copy.

  **Rule 16 is scoped to an explicit FILE LIST** (role is not derivable from a
  path), so its gate spec asserts every path exists; it also found
  `SELF_REFERENTIAL` too blunt to be per-FILE, so exemptions are per rule now.

  Two things any new rule must respect. **A pattern that matches nothing prints
  the same checkmark as a rule being upheld**, so
  `packages/aai-templates/guard-invariants-gate.test.ts` feeds every rule a
  positive sample it must catch and a negative twin it must spare, importing the
  rules as real values rather than scraping them out of the source. Rule 4
  shipped its first draft with `[^)]*` between `new Promise(` and `setTimeout(`,
  which cannot cross the arrow's own parameter list — 0 reported against five
  real occurrences, the same silently-dead-pattern shape as the `\b` bug in
  `check-escape-hatches.mjs`. And **the rules module matches most of its own
  rules**, since every `label` and `re` describes what it bans; it, the gate,
  the baseline and the gate's spec are all in the script's `SELF_REFERENTIAL`
  set. That is the third and fourth time this trap has been paid for here.
- **`pnpm check:agent-guide`** (`scripts/sync-agent-guide.mjs`) — asserts
  `packages/aai/AGENT_GUIDE.md` is the current copy of
  `packages/aai-templates/scaffold/CLAUDE.md`. See "The authoring guide ships
  inside the SDK" below for why the copy exists. Same silent-staleness shape as
  `check:guest-toolchain`, hence the same treatment.
- **`pnpm check:scaffold`** (`scripts/sync-scaffold-versions.mjs --check`) —
  asserts `packages/aai-templates/scaffold/package.json` still matches the
  workspace. Third file in this committed-copy shape and the only one that
  SHIPS, so it is where a catalogued bump is applied twice.

  It was enforced by nothing until it broke, and `check:publish-protocols`
  structurally cannot cover it — see "`check:scaffold` exists because the sync
  ran only during a release" in `packages/aai-templates/CLAUDE.md`.

**Every gate whose success output is a COUNT now carries a floor**, set from
the measured actual and recorded beside it, because a scan that stops matching
prints the same checkmark as a healthy tree. Five were added at once:
`check-gateway-models` had none at all and its `[^}]*` entry parser could not
cross a nested `}`, so one reformatted entry dropped BOTH the committed and the
generated map to zero, made the diff empty, and printed `catalog current — 0
advertised, 0 usable ✓`; `artifact-size-report` did not floor
`publishablePackages()` though `_fs.mjs` documents that the caller must;
`check-doc-examples`'s `MIN_EXAMPLES` sat at 45 against a measured 98, so more
than half the corpus could vanish silently (its `extractFences` also dropped
every block after an unclosed fence, which now throws); and `guard-invariants`
rules 11, 12 and 13 had no corpus floor.

These are pure fs checks (no build needed), so they run up front and
fail fast. To tighten quality over time, lower the entries in the
file-length allowlist and in the two per-file baselines
(`escape-hatch-baseline.json`, `guard-invariants-baseline.json`) — all three
are designed to only move one direction, and `--update` on the latter two
enforces that rather than trusting it.

A sixth ratchet lives in the vitest configs: **coverage thresholds**.
Every package has floors — `aai-templates` was for a while the one that did
not, so CI measured its coverage and threw the number away. Each package's
`vitest.config.ts` declares per-package coverage floors
(lines/functions/branches/statements) that CI enforces via
`pnpm test:coverage` (the `test` job runs it per package). The root
`vitest.config.ts` holds NO thresholds — see below. Like the
other ratchets these only move up: when a coverage run shows actuals
comfortably above a floor, raise the floor to ~2-3 points below the
actual. Never lower a floor to make a PR pass — add tests instead.
Coverage measures production source only; test infrastructure
(`_test-utils.ts`, mocks, fixtures, setup files) is excluded via
`sharedCoverageExclude` in `vitest.shared.ts`.

**The per-package floors are the only ones, because they are the only ones
anything evaluates.** `pnpm test:coverage` is `turbo run test:coverage`, which
fans out to each package's own config, and CI runs `pnpm --filter
./packages/<pkg> test:coverage` per matrix entry — so nothing in the repo or in
CI ever read the root `vitest.config.ts` thresholds, and only a direct
`pnpm vitest run --coverage` at the root ever could. They were kept for a while
on the argument that they were "the only floor that sees the repo as one
program", which is a view nobody's pipeline takes; what they actually were was a
ratchet no process could move and no PR could trip, sitting ~4 points under an
actual nobody had measured. They are DELETED. The measured actuals stay in a
comment there, which was the informative half.

**And the floors are measured locally now, because for a long time they were
not.** `scripts/check.sh` ran `test`, CI's matrix runs `test:coverage`, so the
one gate a PR could not see coming was its own coverage: every suite green
locally, `test (<pkg>)` red in CI. It happened — a new 300-line module in
aai-ui landed at 1.44% line and 0% branch coverage, took the package under all
four of its floors, and cost a whole follow-up commit to fix. Floors do not
move to accommodate a PR, so the earlier that is known the cheaper it is. Both
`check.sh` modes and `check:affected` run `test:coverage` now.

## Architecture

Nine workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: agent config, types, protocol, S2S, session, Db |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (React 19): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, list, pull, push, publish, delete, login, secret, storage, templates (`deploy` is hidden/internal — the mechanism in-guest Publish runs) |
| `packages/aai-guest/` | `aai-guest` | Guest sandbox harness (private): the Node entrypoint that runs the complete agent inside each Modal Sandbox, built into one self-contained `dist/harness.mjs` |
| `packages/aai-server/` | `aai-server` | Agent service + shared platform core (private): sandbox, auth, SSRF, stores, locks |
| `packages/aai-studio-server/` | `aai-studio-server` | Studio service (private): browser coding agent, workspace builds. Also the composition root — its entry is the one every deployment runs |
| `packages/aai-studio-client/` | `aai-studio-client` | The studio's browser front-end (private): Vite React app served by aai-server |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |
| `packages/aai-evals/` | `aai-evals` | Behaviour eval tier (private): the runner, its assertion vocabulary over the session event stream, and its targets |

**Dependency flow:** `aai-cli`, `aai-ui`, `aai-guest`, and `aai-server` all
depend on `@alexkroman1/aai` (via `workspace:*`). `aai-server` depends on
`aai-guest` only to resolve its built artifact (`aai-guest/harness` →
`dist/harness.mjs`, baked into the guest snapshot image) — it never imports
guest source, and the guest never imports server code; that hard boundary is
the reason the guest is its own package. The one edge to the CLI is
`aai-guest` → `aai-cli`, and only for its four public subpaths: the three
build hooks (`/worker-bundler`, `/client-bundler`, `/typecheck`), because the
studio builds workspaces through the CLI's own Vite pipeline and typechecks
them with the CLI's own gate rather than carrying a second bundler, plus
`/project-config`, because Publish materializes a project the CLI then parses
and the writers for those two files belong to the CLI. Do not widen it —
nothing else may import from the CLI, and the CLI must never import from the
server or the guest.

**Publishable packages must use the `@alexkroman1/` scope.** The unscoped
names `aai`, `aai-ui`, `aai-cli` are taken on npm by other publishers —
publishing under those names returns 404. The `scripts/check-publish-names.mjs`
script enforces this at CI time.

### Package guides

**This file holds only what is repo-wide.** Everything package-specific lives
in that package's own `CLAUDE.md`, which Claude Code loads when you work in
that directory — go there first, and put new package-specific rules there
rather than here:

| Guide | Covers |
| --- | --- |
| `packages/aai/CLAUDE.md` | SDK layout (`sdk/` vs `host/`), subpath exports, session modes, STT/LLM/TTS/S2S providers, voices, `ctx.db`, `ctx.generate`, the concurrency primitives, session slots, the canonical agent-config schema, data flow, the defaults/magic-numbers table |
| `packages/aai-ui/CLAUDE.md` | Browser session, client audio path (capture/playback worklets, pacing, jitter buffer), components, fuzz harnesses, **workflow apps** (`page()`, `createWorkflowApi`, `useWorkflowRun`, and the workflow HTTP API the SDK serves) |
| `packages/aai-cli/CLAUDE.md` | Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`), bundling + Vite rules, credential destinations, `aai dev`'s server and host mode |
| `packages/aai-guest/CLAUDE.md` | The guest harness: one binary / three modes, user-shipped runtime, dev-prod parity, agent guests as servers, guest network access + SSRF, credential separation |
| `packages/aai-server/CLAUDE.md` | Platform: sandboxes + Modal backends, stateless server, security architecture, auth, telephony, durable-workflow routes, stores/locks |
| `packages/aai-studio-server/CLAUDE.md` | Browser studio: workspaces, coding agent, previews, Publish, LLM selection, studio evals, the two-package/one-deployment composition |
| `packages/aai-studio-client/CLAUDE.md` | Studio front-end: panes, composer queue, CSP, preview probing |
| `packages/aai-templates/CLAUDE.md` | Templates + scaffold packaging. Note `scaffold/CLAUDE.md` is a product artifact, not repo docs |
| `packages/aai-evals/CLAUDE.md` | Eval tier: recorded assertions, the spread report, why it does not gate, the two levels |

### A guide says what to do in code that EXISTS

There used to be a `research/` directory for issue-backed plans — a design doc
for a change that did not exist yet — kept out of the guides because a guide is
loaded into an agent's context on every task and everything in it competes for
that budget. It is gone, along with the rule 10 that checked its frontmatter,
and the half of the split worth keeping is the one that survives it: a guide
documents code that exists. A design for a change nobody has made yet belongs on
the issue that owns it, not in a file an agent reads while working on something
else — that habit is directly how the root guide reached 233,000 characters. When
a plan ships, the rule it establishes lands in the owning package's guide as a
few lines.

## Conventions

- **Runtime**: Node everywhere (host, platform server, and guest sandbox)
- **Frameworks**: React (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Linting**: Biome. Auto-runs on staged files via lefthook pre-commit hook.
  **Every package needs a `lint` script** (`biome check .`) or `turbo run
  lint` — and so `pnpm check` — silently skips it; `aai-templates` had none.
  Filename conventions are Biome's job too (`useFilenamingConvention`,
  kebab-case), which replaced a never-invoked `ls-lint` whose config existed
  but which no pipeline ran and which blocked for 30+ minutes at repo root.
  Template tool files are exempted by an override: their names mirror
  snake_case LLM tool names.
- **Exports**: In dev mode, package.json exports point to `.ts` source for
  seamless workspace resolution. Update to compiled `.js` dist paths before
  publishing.

### File naming conventions

| Pattern | Meaning | Example |
| --- | --- | --- |
| `_foo.ts` | **Internal module** — not part of the public API. Never import cross-package. Biome's `noPrivateImports` rule enforces this at lint time. | `_utils.ts`, `_bundler.ts`, `_internal-types.ts` |
| `foo-barrel.ts` | **Barrel re-export file** — aggregates exports from multiple modules into one subpath export. Has `biome-ignore` for `noReExportAll`. | `runtime-barrel.ts`, `manifest-barrel.ts` |
| `foo.test.ts` | **Unit test** — co-located with source. Runs via `pnpm test`. | `session.test.ts` |
| `foo.test-d.ts` | **Type-level test** — checked by tsc, never executed at runtime. Uses `expectTypeOf`. | `types.test-d.ts` |
| `_test-utils.ts` | **Test helpers** — each package has its own with different utilities (see below). | `host/_test-utils.ts` |

### `_test-utils.ts` per package (not interchangeable)

Each package has distinct test helpers tailored to its domain:

- **`aai/sdk/testing.ts`** and **`aai/sdk/testing-vitest.ts`** — the ones that
  are PUBLISHED (`@alexkroman1/aai/testing` and `/testing/vitest`, so a user's
  agent project can import them). `createToolContext(overrides?)` builds a
  `ToolContext` for testing a tool's `execute`; the collaborator fakes
  (`stubGenerate`, `stubGateway`/`stubUploads`, `toolOf`/`runTool`,
  `withDiscoveredTools`) drive what that tool calls. **The subpath table in
  `packages/aai/CLAUDE.md` carries the inventory and the argument** — why the
  defaults are inert, why each call is a distinct session, and why `/testing`
  stays framework-agnostic while importing `/testing/vitest` is what pulls the
  runner. The repo-wide half is only that they replaced the same eight-field
  stub in four template suites, two of which reached for
  `{ … } as unknown as ToolContext` — the cast that also stops reporting when a
  field is ADDED, which is the failure a shared builder exists to prevent.
  **Reach for that split** — a framework-agnostic fake beside a
  runner-installing wrapper — whenever a helper's only remaining content is the
  installation of the fake.
- **`aai/host/_test-utils.ts`** — `flush()` (microtask yield), `makeTool()`,
  `makeAgent()`, `makeConfig()`, fixture replay helpers for S2S mocking
- **`aai-cli/_test-utils.ts`** — `withTempDir()` (temp dir + cleanup),
  `silenceSteps()`, `silenced()`, `makeBundle()`. The dev-server specs share
  their mock scaffolding (fake chokidar, runtime/server mocks) via
  `_dev-server-test-utils.ts`. A `_test-setup.ts` setup file points
  `AAI_CONFIG_DIR` at a per-run temp dir so tests can never touch the
  developer's real `~/.config/aai/config.json` (API key + approved servers).
- **`aai-ui/_react-test-utils.ts`** — `createMockSessionCore()`,
  `MockAudioContext`, `installAudioMocks()`
- **`aai-studio-client/src/_test-utils.ts`** — typed `fetch` stubs plus their
  readers, `renderWithClient()`, the `button`/`input`/`textarea` element seams,
  and `installResizeObserver()`.
- **`aai-server/test-utils.ts`** — (no underscore) `createTestStore()`
  (in-memory BundleStore), `createTestOrchestrator()`, `authHeaders()` /
  `authFetch()` / `deploy()` / `deployAgent()` / `deployPayload()` /
  `deployBody()`, `makeSlot()`.
  (`createMockKv()` was listed here for a while and has never existed in this
  package — KV was removed.)

  **Build a request with `authFetch`/`deploy`, not a header literal**, and
  see `packages/aai-server/CLAUDE.md`, "Building a platform request in a test",
  for the ~47 converted sites and the three shapes that deliberately stay raw.

### `@dev/source` custom export condition

Package.json exports use a custom `@dev/source` condition so that
TypeScript source (`.ts`) is resolved during development, while compiled
`.js` dist paths are used in production:

```jsonc
// package.json
"exports": {
  ".": {
    "@dev/source": "./index.ts",     // ← resolved in dev (via tsconfig)
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"      // ← resolved in production
  }
}
```

This is enabled by `customConditions: ["@dev/source"]` in the root
`tsconfig.json`. During dev, imports like `import { X } from "@alexkroman1/aai"`
resolve directly to `.ts` source — no build step needed.

### Import rules

- **Cross-package imports** must use the npm package name (e.g.
  `import { X } from "@alexkroman1/aai/protocol"`), never relative paths between
  packages. Biome's `noRestrictedImports` enforces this.
- **Internal modules** (`_*.ts`) must not be imported from outside their
  own package. Biome's `noPrivateImports` enforces this.
- **Re-exports**: barrel files use `export * from "..."` with explicit
  `biome-ignore` comments. Follow re-export chains to find the original
  source of a type/function.

### Disambiguating "Session" types

Multiple types named `Session` or `Session*` exist across packages —
they are **not interchangeable**:

| Type | Package | File | Purpose |
| --- | --- | --- | --- |
| `SessionCore` | `aai` | `host/session-core.ts` | Server-side session — bridges a `Transport` (S2S, pipeline, or OpenAI Realtime) to the client protocol |
| `SessionCoreOptions` | `aai` | `host/session-core.ts` | Config for creating the server-side session core |
| `SttSession` / `TtsSession` | `aai` | `sdk/providers.ts` | Host-side handle to one open STT/TTS provider stream (pipeline mode) |
| `SessionCore` | `aai-ui` | `session-core.ts` | Framework-agnostic browser session (WebSocket + audio + state) |
| `SessionSnapshot` | `aai-ui` | `session-core.ts` | Immutable snapshot of browser session state (for `useSyncExternalStore`) |
| `SessionError` | `aai-ui` | `types.ts` | Client-side error type with error code |

When searching for "Session", narrow by package to find the right one.

### Concurrency primitives (use these, don't hand-roll)

The repo's recurring async-coordination patterns are reified as small
primitives. Almost all of them are `packages/aai` exports, so **the catalogue
and the argument behind each one live in `packages/aai/CLAUDE.md`,
"Concurrency primitives"** — go there before re-inventing one at a call site.
What is there, by name: `createEpoch()` (staleness guard for async
continuations), `createOwnedMap()` (a map whose entries are removed by
ownership token), `createCoalescingRunner()` (serialize + coalesce repeatable
async work), `createTurnMachine()` (the pipeline's turn lifecycle),
`createKeyedLock()`/`withLock()` (serialize async work per key — the one that
is PUBLIC, because the LLM loop runs a step's tool calls concurrently),
`sleep(ms, { signal?, unref? })` (the ONE wait; `guard-invariants` rule 19
keeps the seventh spelling out), `sessionSlot()` (a typed named slot that owns
a session's state, with a SYNCHRONOUS update window), `ToolFailure` /
`isToolFailure()` / `toolFailure()` (the failure a tool returns for the MODEL
to recover from), `pushCapped()`, `resolveOne()`, `omitUndefined()` and
`isRecord()`.

Two are repo-wide rather than this SDK's, and stay here:

- **Timeouts**: use `p-timeout` (a dependency of aai, aai-cli, aai-guest,
  and aai-server) — never a hand-rolled `Promise.race` with a timer; the
  losing branch's late rejection and timer cleanup are exactly what gets
  re-derived wrong. The guest harness is no exception: tsdown bundles its
  npm dependencies (p-timeout included) into `dist/harness.mjs` — only the
  vite/rolldown build toolchain stays external to the bundle.
- **Combining abort signals**: use native `AbortSignal.any([...])` (sources
  held weakly — no unlink bookkeeping); the pipeline transport combines the
  session signal with each turn's controller this way.

### Dependency versions live in the pnpm catalog

Shared dependency versions are declared once, in `pnpm-workspace.yaml`'s
`catalog:` block, and packages reference them as `"zod": "catalog:"`. Twenty-nine
dependencies are in it. Two things stay OUT, and both are load-bearing:

- **peerDependencies.** `react`, `react-dom`, `tailwindcss` and `vitest` are
  declared as peers with wider floors (`^19.0.0`, `^4.0.0`) than the
  devDependency the repo builds against. Those are statements about what a
  CONSUMER may bring, not versions we pick; `catalog:` would narrow them to our
  own pin and break installs for anyone a minor behind. `.syncpackrc.json`
  ignores peer ranges for the same reason.
- **`docs`'s TypeScript**, pinned to the 6.x line because TypeDoc needs the JS
  compiler API TS 7 does not ship. It uses the named `typedoc` catalog so the
  split is a declaration rather than a stray literal.

**syncpack still runs, and is what stops a package BYPASSING the catalog.**
syncpack 15 reads the catalog natively and reports a literal range on a
catalogued dependency as `DiffersToCatalog` — verified by A/B, setting
`aai-cli`'s zod to `^4.0.0` fails the lint. So the two hand-written `sameRange`
versionGroups that used to police zod and ws are gone: the catalog makes that
drift unrepresentable, and a rule comparing `catalog:` against the range it
resolves to reported a mismatch on every correct package.

`sync-scaffold-versions.mjs` carries a bump into the scaffold, which ships to
users and cannot use `catalog:` — still the one place a bump is applied twice.
It did NOT stay as it was, and the note that said so was the bug: reading a
range out of a package.json now yields `catalog:`, which it copied verbatim
into a manifest npm cannot resolve. See `check:scaffold` under "Quality
ratchets".

**`catalog:` must never reach npm, and `check:publish-protocols` proves it does
not.** It is a pnpm protocol — npm treats `"zod": "catalog:"` as an
unsatisfiable range — and pnpm rewrites it (and `workspace:`) when it packs.
That rewrite belongs to the packer, not to us: `changeset publish` picks its
publish command from the lockfile, so a future changesets release shelling out
to `npm publish` would ship `catalog:` verbatim. The gate packs each publishable
package and reads the manifest back out of the tarball, because this is
invisible to a diff (the manifests are correct — the protocol IS the intended
source form), invisible to a build, and invisible to `publint`, which reads the
SOURCE manifest. The symptom would be a 100% broken published version, found by
consumers, with unpublishing inside 72 hours the only remedy.

### A new version is quarantined for 48 hours

`pnpm-workspace.yaml` sets `minimumReleaseAge: 2880`. This is the half of
supply-chain defence that `onlyBuiltDependencies` cannot cover: a hijacked
release does not need an install script when the package is imported by our own
code at build or test time. Nearly every npm account compromise is caught and
yanked within hours, so the window is most of the exposure, and nothing here
needs a version the day it ships.

It applies to RESOLUTION, so it only bites when the lockfile is being changed —
`pnpm install --frozen-lockfile` (CI, every check job) is unaffected. A
deliberate same-day bump adds a `minimumReleaseAgeExclude` entry WITH a reason,
rather than lowering the number.

**There is deliberately no `minimumReleaseAgeExclude` at the root**, and the
absence is the interesting part: an exemption for our own packages is the first
thing you would reach for and it would be dead config, because this workspace
resolves `@alexkroman1/*` through `workspace:*` and never from the registry. The
place that DOES need it is `scaffold/pnpm-workspace.yaml` — see
`packages/aai-templates/CLAUDE.md` for the
`ERR_PNPM_NO_MATURE_MATCHING_VERSION` failure it prevents. The e2e suite is
likewise unaffected and not by luck: it already sets
`NPM_CONFIG_MINIMUM_RELEASE_AGE=0` because the tarballs it publishes to its mock
verdaccio are seconds old by construction.

### Every GitHub Action is pinned to a SHA

A tag is a mutable pointer, so `@v7` grants every future version of that code
the permissions of the job it runs in — including the release job's npm token.
Every `uses:` carries a 40-character commit SHA with the release in a trailing
comment; `guard-invariants.mjs` rule 7 fails a workflow that reuses a floating
tag, and dependabot bumps the SHA and the comment together so the pins do not
rot into a reason to stop pinning.

### Artifact sizes have a budget, with an escape valve

`.size-limit.json` used to sit at the repo root with two entries. It was
referenced by no script, no turbo task and no CI job, `size-limit` was not even
a devDependency, and both its limits were wrong by more than an order of
magnitude (`aai`'s `dist` is 1.7 MB against a declared 30 kB). Dead from the day
it was added — the same genre as the `ls-lint` config no pipeline ran and the
`.turbo` cache path that never matched `cacheDir`. It is deleted.

`scripts/artifact-size-report.mjs` measures what actually ships:

- **`aai-guest/dist/harness.mjs` — 17.6 MB, and nothing was watching it.** It is
  baked into the Modal guest snapshot image, so it is on the cold-start path of
  every sandbox the platform starts. Reported raw and gzip, because the image
  layer is compressed.
- **The three published tarballs**, PACKED rather than measured from `dist/`.
  `dist/` is not what ships: `files`, `.npmignore` and `prepack` all sit between
  the two, and every "we shipped the wrong thing" bug lives in that gap. File
  count is reported too, which is what catches a glob that started matching a
  directory it should not.
- **Each published package's runtime dependency list.** A new entry fails the
  budget on its own, regardless of bytes: it is transitive, it lands in every
  consumer's tree, and a byte threshold reads it as small — a 4 kB wrapper can
  pull 2 MB behind it.

`.github/workflows/artifact-size.yml` builds the PR base in a `git worktree`
(so the baseline is measured with the BASE's own lockfile), posts one sticky
comment, and enforces afterwards — a budget failure whose numbers you have to
dig out of a log is a worse version of the same information. A base that will
not build is reported and enforces nothing, out loud, rather than passing
silently.

**The `acknowledge-size-warning` label is the one place this repo lets a ratchet
move up**, and it is not an inconsistency. Every other baseline here guards
DEBT, where "only down" is right. Size is different: a feature that legitimately
adds 15% has no debt to remove, so the author's only options would be to abandon
the gate or weaken the threshold for everyone. The label demotes the failure to
a warning and **is removed on every push**, so an acknowledgement covers one
commit rather than licensing the rest of the branch.

The job is deliberately not required and not in `check.yml`: it builds the
workspace twice, so a `paths` filter keeps it off docs-only PRs — which it can
only do BECAUSE it is not required (a required check with a paths filter sits
permanently "expected" on the PRs it skips and blocks the merge).

**Create the `acknowledge-size-warning` label once** in repo settings; adding a
label that does not exist is an API error.

### Published type signatures are a committed report

`pnpm api-report` writes `packages/*/etc/<subpath>.api.md` — the rolled-up
public `.d.ts` for each of the 23 published entry points — plus **`API.md` at
the repo root, the same 23 reports concatenated**, and **`API-EXPORTS.json`, the
same 23 entry points' export NAMES**; `pnpm check:api-report` fails when any of
them is stale.

**`API-EXPORTS.json` is a second artifact over the same reports, and the split
between them is the point.** A report answers "what is the shape of this API"
and churns whenever a parameter widens, a doc comment moves or an overload is
added — which is what a reviewer wants, and which also means a name quietly
appearing or disappearing is one line inside a hundred-line diff. The export
list answers only "what is IN the surface", so adding an export is a one-line
addition against an otherwise stable file. `sdk/exports.test.ts` pins some of
the same names and stays: a test fails at the moment the surface moves and names
the symbol, which is a different job from being a reviewable fact in the diff —
and it covers the entries somebody remembered to add, where this covers all
twenty. Sorting is **code-unit, never `localeCompare`**: with no explicit locale
that answers to the runtime's, so the same tree would produce a different file
under a different ICU default and the gate would report a surface change that is
really a locale change.

**`includeForgottenExports` is ON**, so a type a public signature mentions but
does not export appears in the report as a bare `declare` with no `export`
keyword. Those are part of the surface a consumer has to satisfy — they just
have no name to import it by — and changing one can break a build while being
invisible in review. TypeDoc's `treatWarningsAsErrors` catches a subset and only
for `aai` and `aai-ui`, never the three aai-cli build-hook subpaths, and it
fails the run rather than showing what moved. Turning it on added ~1,300 lines
across the reports; `/testing`'s grew from 28 lines to 185, which is the finding
— that entry point exports four symbols and drags `Db`, `GenerateFn` and
`WorkflowClient` in behind them. The export lists deliberately do NOT include
them: they are collected from the `export` modifier, so a forgotten type is
reviewable in the report and absent from the list of what a consumer can import
by name.

The gap it closes: **nothing else looked at a type SIGNATURE.**
`sdk/exports.test.ts` pins runtime export NAMES and says nothing about shape;
`publint` and `attw` ask packaging questions; the `.test-d.ts` files cover
`aai`'s root entry and `aai-ui`'s four hooks, and "Known limitations" below
states outright that the subpath exports are not covered. So widening a
parameter, making a field optional, or changing a return type on any of the
nineteen other entry points was invisible in review — which matters most for the
decision it feeds, since the changeset bump type is currently a judgement made
from memory and a `patch` that was really a `major` is discovered by the
consumer whose build breaks.

**Entry points are DERIVED from `package.json#exports`, never listed.** API
Extractor's own convention is one config file per entry point, which here would
be twenty files whose only real content is a path — and a hand-kept list of the
public surface is precisely what goes stale in this repo (turbo `inputs` globs
that stopped matching, five vitest projects duplicated at the root and drifted,
a `typedoc.json` list a new subpath must remember to join). A new subpath export
therefore gets a report on its first run, and `--check` fails until it is
committed, which is correct: a new subpath IS a public API change.

**`API.md` is for READERS; the per-entry-point reports are for reviewers.** 23 files
is the right shape for a diff — a signature change lands in the one report that
owns it — and the wrong shape for answering "what does this SDK expose?", which
is twenty reads plus knowing which twenty. API Extractor cannot produce the
combined file itself: `mainEntryPointFilePath` is a single string and multi-entry
support is a long-standing unimplemented upstream request. Pointing it at a
synthetic barrel (`export * as stt from "./dist/…"`) does work and yields one
DEDUPLICATED rollup, but only per package — the repo would still have three — and
every symbol trades its `export` keyword for a `declare namespace` block.
Deduplication also buys almost nothing here: 573 top-level declarations across
the reports are 539 distinct names, so 34 lines, 6%. So `API.md` is a
plain concatenation, generated in the same pass and gated by the same `--check`,
which makes it derived rather than a second source of truth.

`packages/aai-templates/api-surface-file.test.ts` is the guard under that gate.
`--check` compares the committed file against a freshly assembled one, so it
catches staleness — and would print its checkmark for an empty file agreeing
with an empty file, which is what an assembly loop that stopped finding entry
points, or a fence parser that stopped matching, would produce. The test parses
the reports and `API.md` independently of the script and asserts the second
contains the first.

Two mechanical notes. API Extractor brings **its own TypeScript** (the JS
compiler API, which TS 7 does not expose) resolved from its own dependency tree,
so no second pin is needed the way `docs/` needs one for TypeDoc. And
`reportTempFolder` is not optional: left unset, `--check` wrote twenty
byte-identical `<slug>.api.md` files into the package roots, caught only because
markdownlint then failed on them.

`packages/aai/.npmignore` keeps `etc/` out of the tarball — the reports are for
reviewing signature changes, not for consumers. (`aai-ui` and `aai-cli` declare
`files`, so they need no equivalent line.) Both they and `API.md` are ignored by
markdownlint, on the standing rule for generated markdown: a prose finding in
one can only be fixed by editing a file the next run overwrites.

### The authoring surface is versioned in epochs

The reports turn a signature change into a diff, which is most of the battle —
but they answer "did anything move", and the question a reviewer has to answer is
**"is this breaking, and for whom"**. That decision is the changeset bump type,
and the section above admits how it gets made: a judgement from memory, where a
`patch` that was really a `major` is found by the consumer whose build breaks.

`pnpm check:api-contracts` (`scripts/api-contracts.mjs`, run straight after
`check:api-report` in `scripts/check.sh` and in the CI check job) closes that.
Twenty-five **capabilities** — named slices of the authoring API, each
declared by a file under `<package>/contracts/entrypoints/` that may contain
nothing but
`export { … } from "<a published subpath>"` — get a report of their own, and what
is committed is that report's hash plus its export list, at
`contracts/epochs/<capability>/v<N>.json`. When a capability's shape moves the
hash stops matching and the change cannot land without being CLASSIFIED:

```sh
node scripts/api-contracts.mjs --bump aai:tool --retain          # epoch N works
node scripts/api-contracts.mjs --bump aai:tool --drop "<reason>"  # and why not
```

**Two packages carry contracts, `aai` and `aai-ui`, and a capability is
therefore QUALIFIED.** `@alexkroman1/aai-ui` is authored code in exactly the same
sense as the SDK — a `client.tsx` names `client()`, `useAgentState`, `<Form>` and
`useWorkflowRun` the way an `agent.ts` names `agent()` and `tool()`, and a
signature change there breaks a user's page — so its nine capabilities are
versioned the same way (see "The authoring surface is versioned in epochs" in
`packages/aai-ui/CLAUDE.md`). Capability names are unique only WITHIN a package:
`workflow` is a capability of both and they are different contracts, so anything
a human types is `aai-ui:workflow` (a bare name still resolves when it is
unambiguous, and ambiguity is REFUSED rather than resolved by precedence — a
classification recorded against the wrong surface is the one failure this gate
exists to prevent). Epoch files stay unqualified; their path already names the
package. **Opting a third package in is creating `contracts/entrypoints/` inside
it** — the package set is discovered from the tree, for the reason the entry
points and the capabilities are, and its authoring subpaths are then everything
it publishes with types MINUS a deny-list of the non-authoring ones
(`NON_AUTHORING_SUBPATHS` in `scripts/_api-contracts.mjs`, which exempts `aai`'s
`/protocol`, `/runtime`, `/manifest`, `/slugify`, `/workspace-files` and
`/internal` with a reason each). Deny rather than allow for the reason the config
schema does it (see "One canonical config schema, deny-list boundaries"): a new
subpath then defaults INTO the contracted surface and fails until its exports
join a capability, where an allow-list would silently leave it uncovered.

Four properties are load-bearing:

- **A retained epoch obliges a frozen, compiling example.**
  `contracts/compatibility/<capability>/v<N>.ts` is an authoring example written
  the way that epoch was authored, and it sits under the package's own
  `tsconfig.json` — so **`pnpm typecheck` is the backward-compatibility gate**.
  That is a test of
  compatibility rather than a claim about it, which is what the `.test-d.ts`
  files cannot be: they pin the CURRENT shape and move with the API. All
  twenty-one exist from the first commit, so the value does not wait for a bump.
  The extension is `.tsx` wherever the owning package's tsconfig sets `jsx`
  (DERIVED, not declared) — a component library's authoring example is JSX, and
  one spelled in `createElement` calls would compile while demonstrating an API
  nobody writes. Editing one
  to make a compile error go away defeats the whole mechanism — the error IS the
  finding. A **dropped** epoch's example is DELETED by `--bump --drop`, because
  "dropped" means it no longer compiles and a leftover file would turn a recorded
  decision into a red typecheck.
- **The hash covers the rollup BODY, not the report file.** API Extractor's
  preamble is identical in every report and is the tool's, not ours; hashing it
  would make an api-extractor upgrade that reworded one line bump every epoch at
  once, each demanding a classification for a change to nothing.
- **Old epoch metadata is immutable and retained** (`v1..current`, enforced), so
  "when did this break and what did we say about it" is answerable from the tree.
- **The export-list delta suggests the bump.** A removed name prints `major`, an
  added one `minor`, and an unchanged list says so explicitly — this is a
  SIGNATURE change, read the report diff. That is the cheap 80% of the question,
  and it beats the status quo of nothing.

**Capabilities, not entry points, and the reason WAS the `@internal` problem.**
`@alexkroman1/aai` used to export 174 symbols from its root, **71 of them tagged
`@internal`** — `PLAYBACK_CONCEAL_FLOOR`, `MIC_SILENCE_PROBE_MS`, `WS_OPEN` — on
the same barrel as `agent()` and `tool()`, and therefore in an agent author's
autocomplete, which is the exact thing `packages/aai/CLAUDE.md` gives as the
reason `/internal` exists. Versioning the subpath as one unit would bump the
authoring contract every time a playback constant moved. So the capabilities name
the surface instead — `agent`, `tool`, `state`, `workflow`, `workflow-api`,
`defaults`, `utils`, `testing`, `builtins`, and one per provider stage — and the
gate asserts the naming is **exhaustive**: every `@public` export of the nine
authoring subpaths this leaves `aai` with (`.`, `/utils`, `/testing`,
`/workflow-api`, `/tools`, `/stt`, `/llm`, `/tts`, `/s2s`) belongs to exactly one
capability, so a new public export
fails until somebody decides which contract it joins — which is the same decision
as "who is promised this". Ownership is per PACKAGE, deliberately: three names
(`isTerminal`, `WorkflowSummary`, `WorkflowOutputOf`) are on both packages'
surfaces, the same concept from the two sides of the wire. A name published on
both `.` and a narrower subpath belongs to the narrower one.

**Counting them is what got them fixed, which is the argument for the whole
gate.** The internal-tagged names are the explicit exemption, committed to
`contracts/internal-surface.json` as a **ratchet that may shrink and may never
grow** (`--update-internal` lowers it, and unclaimed headroom WARNS). It opened
at 74 and stands at **3** — `capToolResult`, `isTextAssetPath` and `toArgsRecord`
on `/utils`. The 71 root ones went to `@alexkroman1/aai/internal` in the change
that cut the root barrel to the authoring API (see "The root barrel is CURATED"
in `packages/aai/CLAUDE.md`); the ratchet is what made a number out of a
long-standing complaint, and then what recorded paying it off. Note the gate
refuses a NEW `@internal` name on a public subpath outright, which is why
`serializeToolFailure` lives in an `_`-internal module rather than beside
`toolFailure` in `sdk/utils.ts` — `sdk/utils.ts` IS the `/utils` subpath, and a
tag documents a problem where a private module prevents it.

Two mechanical notes. The epoch directory is `epochs/`, not `reports/`, because
`.gitignore` carries a bare `reports/` rule that would have swallowed it whole.
And the authoring surface is read out of the **committed** `etc/*.api.md`
reports rather than re-derived, so this and the thing a reviewer looks at cannot
disagree — which is why the ordering in `check.sh` and CI is fixed and asserted:
a stale report would be believed.

`packages/aai-templates/api-contracts-gate.test.ts` is the guard under the gate,
and it has the same shape as `api-surface-file.test.ts` for the same reason: the
gate compares two things the script derives, so an extraction that stopped
finding anything would hash nothing, agree with a committed nothing, and print
"25 capability contract(s) up to date ✓". The suite reads the contract tree
independently — every package's, by the same discovery rule, so a second package
is not unguarded by the guard — and asserts every name a capability root selects
appears in that capability's current epoch, which an empty extraction cannot
satisfy. Its own parser reads the export CLAUSE rather than one name per line,
because Biome collapses a short clause onto a single line: per-line, it found
zero names in the two smallest `aai-ui` roots and would have reported the
healthiest possible contract as empty.

`contracts/` is kept out of the tarballs twice over, and the second one is not
optional: `.npmignore` excludes the source directory in `aai` (same reason as
`etc/`, plus the examples import by relative source path and would ship
unresolvable specifiers), **and each package's `tsconfig.build.json` excludes it
from the declaration emit** — `rootDir: "."` otherwise writes a `.d.ts` per
capability root and per frozen example into `dist/contracts/`, which
`aai-ui`'s `files: ["dist"]` would have shipped (18 files; `aai`'s bare
`contracts/` ignore rule matches at any depth, so there it was merely dead
output). `tsc --noEmit` still checks them, which is the gate that matters. They
are also out of coverage by
each package's `vitest.config.ts` (re-export lists and never-executed fixtures
otherwise count at 0% and drag the package under floors that have nothing to do
with what they measure), and its files are declared as knip `entry` points, since
nothing imports either directory and nothing is meant to. A new contract package
owes those three, plus `packages/*/contracts/**` staying in the `aai-templates`
turbo `inputs` — that is what stops the gate-under-the-gate being served from
cache exactly when a contract tree changes.

### The authoring guide ships inside the SDK

`scaffold/CLAUDE.md` is the one source of truth for how to write an aai agent,
and `scripts/sync-agent-guide.mjs` materializes it as
`packages/aai/AGENT_GUIDE.md` so it ships in the `aai` tarball and cannot
describe a different release than the SDK beside it. It is a REPO-LEVEL script
rather than a build step in `aai`, because `aai` may import no sibling package
and a build step reading from `aai-templates` would invert that;
`check:agent-guide` keeps the copy honest. See "The authoring guide ships inside
the SDK" in `packages/aai-templates/CLAUDE.md` for the drift it prevents and why
the shipped SKILL carries no API guidance of its own.

### Fixed release coupling

`aai`, `aai-ui`, and `aai-cli` are in a **fixed release group** (configured
in `.changeset/config.json`). A changeset for any one of them bumps all
three to the same version. Keep this in mind when creating changesets —
you only need to list one package.

### Testing

- **Vitest**. Test files co-located: `foo.ts` → `foo.test.ts`.
- **A harness a turbo task needs must be DECLARED, never built at test time**
  (`^build`, or `aai-guest#build`). `scripts/ensure-guest-harness.mjs` runs as
  the aai-server test project's vitest `globalSetup` and builds
  `aai-guest/dist/harness.mjs` when it is missing or stale — but inside a turbo
  task (`TURBO_HASH`) it VERIFIES instead, and a missing harness THROWS naming
  the `dependsOn` to add. **See "Building the harness for a test run" in
  `packages/aai-guest/CLAUDE.md`** for why the mtime heuristic guesses wrong
  under a turbo cache hit, and the cross-package flake that cost. It also runs
  as `predev` in aai-studio-server and as `predeploy:modal` in aai-server, and
  is runnable directly: `node scripts/ensure-guest-harness.mjs`.
- **`predev` also rebuilds the studio front-end**, unconditionally — see
  "Serving a current studio client in dev" in
  `packages/aai-studio-server/CLAUDE.md` for why staleness-gating it is the
  wrong trade and what a stale bundle looks like (nothing).
- **Each suite is defined once, in its own package's `vitest.config.ts`.**
  The root `vitest.config.ts` discovers them with `projects: ["packages/*"]`
  and adds only the typecheck-only `aai-types` project. Use
  `--project <name>` to run one; the name is declared in the package config
  (a bare glob would otherwise name the project after package.json, e.g.
  `@alexkroman1/aai`). Do NOT re-declare a suite at the root: it used to
  hold a second inline copy of all eight, and they silently drifted — the
  aai-cli copy lost `_test-setup.ts`, so `--project aai-cli` ran the CLI
  suite against the developer's real `~/.config/aai/config.json`; the server
  copies lost their 20s argon2 timeout; the aai-server excludes named two
  deleted files while missing a live integration test; and the templates
  copy skipped two of its four test files.
- **Shared test options live in `vitest.shared.ts` and must be SPREAD IN.**
  `sharedConfig.test` holds `restoreMocks`, `unstubEnvs`, and the CI
  `reporters`; a package config that writes `test: { … }` without
  `...sharedConfig.test` REPLACES that object rather than extending it, which
  is how every package silently lost `reporters` while each re-declared
  `restoreMocks` by hand.
- **Snapshots are pinned to CI semantics (`update: "none"`), so an obsolete
  one FAILS locally.** Vitest otherwise resolves this from `process.env.CI`:
  `new` locally (write what is missing, merely REPORT what is obsolete) and
  `none` in CI (write nothing, fail on obsolete). That split is a green
  `pnpm check` beside a red CI job, and it produced one — a stale `aai-ui`
  export snapshot, left by a test that stopped taking one mid-edit, printed
  "1 obsolete" locally and failed `test (aai-ui)` with all 340 tests passing.
  The cost is that adding or changing a snapshot needs an explicit
  `vitest -u`, which was already true of any change that has to survive CI;
  `--update` still wins, since a CLI flag overrides config.
- **Those two options mean tests must NOT hand-roll teardown for spies or env
  vars.** `restoreMocks` restores every `vi.spyOn` and `unstubEnvs` undoes
  every `vi.stubEnv`, both BEFORE EACH TEST — so a trailing
  `spy.mockRestore()` / `vi.unstubAllEnvs()`, or an `afterEach` that only
  calls one of them, is dead code, and a `try`/`finally` wrapped around a
  whole test body to run one is dead structure. There were ~85 of each. Reach
  for `vi.stubEnv(name, undefined)` to UNSET a var rather than
  `delete process.env.X`, and never save-and-restore by hand: the restore
  half is what rots (`deepgram.test.ts` wrote back a captured `undefined`,
  which env coercion turns into the string `"undefined"` for every later
  test, and three files stubbed env vars with no cleanup at all).
  The exception is a helper or fast-check harness invoked REPEATEDLY WITHIN
  one test — `fuzz-voiceio`'s per-run `restore()`, `dev.test.ts`'s
  `withCapturedHandlers` — which needs a sub-test boundary the config cannot
  give it.
- **Prefer the tool's own bookkeeping to a local variable.** `Promise.withResolvers()`
  instead of `let resolve!: …` + `new Promise` (and instead of a local
  `gate()`/`deferred()` helper — two files had written one); `vi.fn()` instead
  of a `let settled = false` flag flipped in a `.then()`, since a spy records
  its own calls and names itself in the failure; `test.each` instead of a
  `for (const … of […])` loop over cases, so the reporter names the case that
  failed. A loop is still right when the cases share expensive setup, or when
  it already labels them (`expect.soft(value, label)`) — several deliberately do.
- **The slow tiers use ONE root config, `vitest.slow.config.ts`**, selected by
  `VITEST_PROFILE` (`integration` 30s / `scenario` 120s / `e2e` 300s) with
  `VITEST_INCLUDE` choosing the files. There is no per-package slow config and no
  `vitest.integration.config.ts`. Note `integration` is the DEFAULT when
  `VITEST_PROFILE` is unset, so a scenario script must set it explicitly.
- **Integration- and scenario-tier membership is a NAMING CONVENTION:
  `*.integration.test.ts` and `*.scenario.test.ts`.**
  Unit configs exclude both globs and `test:integration` / `test:scenario`
  select one each, so a new slow test lands in the right tier with no config
  edit. It replaced a
  hand-kept filename list duplicated between each `exclude` array and the
  `VITEST_INCLUDE` env var, which had gone stale: `aai` and
  `aai-studio-server` between them excluded five files that no longer existed.
  **Only the INFIX decides the tier**, so several tests are
  deliberately UNIT tests despite "integration" in the name — `aai-cli`'s
  `integration.test.ts` / `integration-edge-cases.test.ts`, and
  `aai-server`'s `agent-server-integration.test.ts`. That last one really does
  boot a real harness subprocess (hence that package's 20s timeout) and is a
  standing judgement call: by the membership rule it is a SCENARIO test, but it
  is the only test covering
  `subprocess-sandbox.ts` / `warm-harness.ts` / `sandbox-vm.ts`, so promoting
  it drops aai-server's measured line coverage ~92% →
  88.74% and trips its 89% floor. Moving it means restoring that coverage
  first, not lowering the floor.

  `aai` owns files in both; `aai-server` and `aai-cli` own only SCENARIO ones and
  so declare no `check:integration` at all. A package with no files in a tier
  declares no script for it — vitest fails a run matching nothing, which beats a
  green no-op.
- In tests, use `flush()` from `_test-utils.ts` instead of
  `await new Promise(r => setTimeout(r, 0))` to yield to microtasks — and note
  `flush()` is MICROTASK-only. For a full macrotask yield use `tick()`, and for
  real elapsed time `sleep(ms)`, both from `aai/host/_test-utils.ts`; several
  specs used to define a *local* `flush` as `setTimeout(r, 0)`, shadowing the
  export so one name meant two different waits.
- Use `vi.waitFor()` instead of arbitrary delays when polling for async results.
- **A spec that observes a TIMER runs on virtual time, never the wall clock.**
  A spec that waits out real milliseconds to see whether a window elapsed is a
  race, and the flake then names a timing spec rather than a bug. **The worked
  case — the pipeline-transport specs, `useVirtualTime()`, the two things
  virtual time breaks, and the two specs deliberately NOT converted — is in
  `packages/aai/CLAUDE.md`, "Specs that observe a timer".**
- Type-level tests use `.test-d.ts` files with `typecheck: { only: true }`
  — they are checked by tsc but never executed at runtime. Use
  `expectTypeOf` from vitest to assert on type shapes. Projects:
  `aai-types`, `aai-ui-types` — one per package, because each has to run under
  its own package tsconfig (`aai-ui`'s type tests need `lib: DOM` and
  `jsx: react-jsx`, which the root config does not set).

  **What GATES a `.test-d.ts` is `turbo run typecheck`, not those projects.**
  They are declared only in the root `vitest.config.ts`, which nothing in the
  repo or in CI evaluates — the same cause as the root coverage thresholds
  above, and it means `pnpm vitest run --project aai-types` is a local
  iteration shortcut rather than the gate. The real enforcement is that every
  package tsconfig includes its test files and a mismatched `expectTypeOf` is a
  hard compile error: injecting
  `expectTypeOf<string>().toEqualTypeOf<number>()` fails `tsc -p packages/aai`
  with `TS2344`, naming the mismatch in the constraint. So a new `.test-d.ts`
  is covered on creation — but only in a package whose tsconfig includes it,
  which is worth checking when adding the first one to a package.

  **The first `.test-d.ts` in a package needs a `knip.json` entry too**
  (`"**/*.test-d.ts"`). A type test is imported by nothing, so without it knip
  reports the file itself as unused — which is what happened to
  `aai-ui/hooks.test-d.ts`, on a pattern `packages/aai` had carried all along.
- **Package validation**: `publint` runs post-build to verify package.json
  exports resolve to real files. `attw` validates export types. Both run in
  the check pipeline AND in CI, and **all three publishable packages
  (`aai`, `aai-ui`, `aai-cli`) must define both scripts** — for a long time
  only `aai-ui` did, leaving `aai`'s ten subpath exports ungated. That is
  the gap the deleted npm/yarn e2e legs were retired *in favour of* (see
  "The e2e suite is pnpm-only in CI"), so it has to actually hold.
- **Typechecking covers test files**, because every package's tsconfig
  includes them. Turbo's `typecheck` task must therefore keep `**/*.test.ts`
  in its `inputs`: excluding them (as it once did) meant a type error in a
  test could not invalidate the cache, and `turbo run typecheck` replayed a
  green FULL TURBO while `tsc --noEmit` failed.
- **`build` and `typecheck` are NOT checking the same thing twice, and
  `--noCheck` on the declaration emit is therefore wrong.** It looks like free
  speed — `build` is `tsdown && tsc -p tsconfig.build.json`, `typecheck` is a
  separate turbo task, and `--noCheck` emits BYTE-IDENTICAL declarations in
  roughly half the time (measured: aai 1.09s→0.58s, aai-ui 1.76s→0.40s, aai-cli
  2.25s→0.64s, all three diff-clean across 126/36/36 files). But the two
  configs check different programs: `tsconfig.build.json` excludes tests and
  turns on `rootDir` + `rewriteRelativeImportExtensions`, so it is the only
  thing that rejects a cross-package relative import (`TS6059`) — the
  compiler-level backstop under Biome's `noRestrictedImports`. Verified by
  injecting one: the build config reports it, `tsc --noEmit` on
  `tsconfig.json` does NOT, and `--noCheck` suppresses it. So the flag trades a
  real check class for build time, and restoring the check elsewhere costs the
  same time it saved. `isolatedDeclarations` — its usual companion — is
  separately unusable here: the Zod-heavy modules (`protocol.ts`,
  `type-schemas.ts`) would need hand-written types for inferred schema shapes.

- **Coverage**: `pnpm test:coverage` (root or per package) runs vitest with
  v8 coverage and enforces the per-package threshold ratchet (see
  "Quality ratchets" above). CI runs it for every package in the test
  matrix, so a PR that drops coverage below a package's floor fails.

#### Two manual diagnostics, and a knip glob that could not see a dead script

`knip.json`'s root `entry` names WHAT A PIPELINE INVOKES. It used to be
`scripts/**/*.{mjs,ts}` — every file in `scripts/` an entry point by
declaration, so the repo's one "what is unused" tool could never report a dead
script, because an entry point is reachable by definition. Three dead chains
were sitting in there (`starter-eval/builtins.mjs` and
`starter-eval/tsconfig-ab.mjs`, both reading a `run.json` from a producer that
was deleted, and `scripts/aai-dev.sh`, duplicating `pnpm aai`), all deleted.
A script that is a MODULE is deliberately absent from the list: knip reaches it
through the entry that imports it, and losing its last importer is precisely
the finding the glob was suppressing. Anything a root `package.json` script or
a vitest `globalSetup` names is discovered by knip itself and must not be
repeated — it reports a repeat as a redundant pattern.

`check:gateway-models` is the one script in `package.json` that no pipeline
runs, and it stays that way: it spends real tokens on the caller's own key and
depends on a third-party service being reachable, so a gateway blip would
redden unrelated pull requests. Same argument as the mutation score below, and
the same rule — a threshold or a gate that nothing enforces reads as a gate.
It shells out to `gen-gateway-models.mjs` by path, which is why that generator
is the single named `entry` in `knip.json`.

#### Mutation score is a manual DIAGNOSTIC, not a tier and not a gate

`pnpm test:mutate:sdk` mutates the schema core (689 lines) and you read the score
off `reports/mutation/sdk/index.html`. It is named here **because it is wired
nowhere** — no gate, no CI job, no turbo task — which is exactly how it reached
eight config files and seven npm scripts that no guide mentioned. Six broader
scopes are deleted (the host scope alone is 29,376 lines, i.e. hours) along with
a `break: 40` threshold nothing enforced; the survivor declares none, since a
threshold nothing enforces reads as a gate. It CANNOT become one: `inPlace: true`
is forced by TS 7 removing the API Stryker's sandbox preprocessor calls, so the
run mutates the real tree — read `stryker.base.config.mjs`, which carries that
argument plus the `bin.mjs` mode hazard to check before committing after a run.
Note `check:test-assertions` is the affordable half and not redundant with it: it
catches a test with NO assertion, where mutation catches an assertion that does
not DISCRIMINATE.

#### Package-specific suites

The harnesses that only make sense next to the code they exercise are
documented in that package's guide, not here:

| Suite | Guide |
| --- | --- |
| Pipeline-transport interleaving fuzz, fixture replay (`host/fixtures/`) | `packages/aai/CLAUDE.md` |
| Template mount correlation (`template-page-mount.test.ts`) | `packages/aai-templates/CLAUDE.md` |
| Browser session / audio fuzz harnesses (`fuzz-*.test.ts`, worklet stress) | `packages/aai-ui/CLAUDE.md` |
| Studio starter evals (what they measure), studio concurrency fuzz | `packages/aai-studio-server/CLAUDE.md` |
| The eval runner, its assertion vocabulary, and both eval targets | `packages/aai-evals/CLAUDE.md` |
| Sandbox/SSRF boundary tests, and why there is no load or chaos tier | `packages/aai-server/CLAUDE.md` |

#### Vitest config differences per package

| Package | Pool | Environment | Special setup | Notes |
| --- | --- | --- | --- | --- |
| aai | threads (default) | node | — | Excludes pentest, sandbox, integration tests; `restoreMocks: true` |
| aai-ui | threads | **node**, jsdom per file | `_jsdom-setup.ts` (stubs `scrollIntoView`) | `globals: true` so `describe`/`test`/`expect` don't need imports. 22 of 42 files opt into jsdom with a `// @vitest-environment jsdom` pragma; the config declares NO `environment`, so the other 20 run in node |
| aai-cli | threads | node | — | `restoreMocks: true` |
| aai-server | **forks** | node | — | Forks for process isolation; excludes integration tests |
| aai-studio-client | threads | **node**, jsdom per file | — | 18 of 26 files carry `// @vitest-environment jsdom` on line 1 — effects, clicks, timers, `beforeunload`, clipboard and fake-timer poll loops are all genuinely exercised. `testTimeout: 20_000`, because the 5s default made a 10s async ceiling in the source unreachable by any test |
| aai-templates | threads | node | — | Also matches `templates.test.ts` + `template-api-coverage.test.ts` |

#### Test environment variables

Tests can behave differently based on environment variables set in
package.json scripts (not always obvious from test code alone):

- `VITEST_PROFILE` — switches the timeout profile in
  `vitest.slow.config.ts`: `integration` (30s), `scenario` (120s), `e2e` (300s).
  No profile sets a `retry`
- `VITEST_INCLUDE` — filters which test files to include
- `VITEST_POOL` — can override pool strategy at runtime
- `AAI_TEST_PM` — package manager the e2e suite installs the scaffolded
  project with (`pnpm` | `npm` | `yarn`; default `pnpm`). **CI only runs
  `pnpm`** — see below.

#### Windows is NOT tested, and is currently broken

There is no Windows leg in CI. One was added, run once, and removed — and what
it found is the reason this section exists rather than a TODO.

**No package declares an `os` field, so all three published packages claim
Windows support by omission**, and `aai-cli` is the one a Windows user actually
runs: `login.ts` branches on `win32` and four modules split on `path.sep`, so
the support was considered and then never exercised. One `windows-latest` run
over `aai`, `aai-ui` and `aai-cli` unit tests failed two of three legs, on two
unrelated causes:

- **Hardcoded `/tmp` string literals.** On Windows `/tmp/x` is DRIVE-RELATIVE —
  it resolves to `D:\tmp\x`, which does not exist — so every write failed with
  ENOENT. Two shipped modules had it (`host/workflow-serve.ts`,
  `aai-guest/harness-bundle.ts`), and both run on the DEVELOPER's machine under
  `aai dev`, not only in the Linux guest. **Fixed**, and
  `guard-invariants.mjs` rule 11 keeps them out; the only baselined occurrences
  are `modal-agent-sandbox.ts`'s remote paths, which name a location inside the
  Linux sandbox where `/tmp` is correct and `tmpdir()` would describe the wrong
  machine.
- **The `aai` build emits differently on Windows.** `aai-cli`'s dev-server specs
  died in rolldown with `UNRESOLVED_IMPORT` on `./_internal-types.ts` inside
  `../aai/dist/sdk/manifest-barrel.js` — i.e. that emitted file carried `.ts`
  specifiers. On Linux the same file is a normal tsdown bundle importing a
  hashed chunk (`../_internal-types-DiEjant0.js`), so the Windows build produced
  unbundled output where Linux produces a bundle. **UNRESOLVED**, and left that
  way deliberately: it is a toolchain-level difference (tsdown/rolldown, or the
  DevKit's builder plugin) that cannot be diagnosed without a Windows machine to
  iterate on, and blind pushes at ~4 minutes per CI round trip are not
  debugging.

So the state is: Windows is plausibly close to working, two real bugs are fixed,
and one build-level unknown stands between here and a green leg. **Do not
re-add the matrix without a Windows machine to reproduce on**, and do not add it
as `continue-on-error` — a leg that is green while broken is worse than no leg,
which is the rule the rest of this file's gates are built on.

Note the middle tiers were never the right thing to duplicate onto Windows
anyway, which is where this diverged from vercel/eve (they run their integration
tier on a Windows matrix leg). Ten of this repo's fourteen
`*.scenario.test.ts` files are aai-server's Postgres, WebSocket and bundler
tests — Linux by design, not by accident. Running them on Windows would test the
runner rather than the code. The three remaining `*.integration.test.ts` files
are pure in-memory property tests, so they would tell you about fast-check, not
about Windows.

#### The e2e suite is pnpm-only in CI

Why the npm and yarn legs were retired, and how to reproduce a user report under
one anyway (`AAI_TEST_PM=npm pnpm test:e2e`), is in
`packages/aai-cli/CLAUDE.md` — the package owning `e2e.test.ts` and
`_e2e-test-utils.ts`. The repo-wide half is why that command works at all:
`AAI_TEST_PM` sits in the `check:e2e` task's **`env`**, because strict env mode
strips an undeclared variable silently (see "strict env mode" above).

#### Property tests run on fast-check

Every randomized suite in the repo — the four `aai-ui/fuzz-*.test.ts`
harnesses, `worklets/audio-stress.test.ts`,
`aai-studio-server/studio-concurrency-fuzz.test.ts`,
`aai/host/integration/pipeline-fuzz.integration.test.ts`, and the value-level
properties in `sdk/protocol.test.ts` / `host/ssrf.test.ts` — is driven by
**fast-check**. Six hand-rolled mulberry32/xorshift copies and their
`for (seed = 1; seed <= N)` loops are gone; do not add a seventh.

What that buys, and the rules that come with it:

- **Failures SHRINK.** A hit reports the smallest input that still breaks the
  invariant, so a counterexample reads as a scenario rather than a transcript:
  reverting the drain-stop turn-id guard in `audio.ts` shrinks to
  `enqueue, done, drainStop(lag=2), done`, and dropping the turn-epoch bump in
  `cleanupAudio` shrinks to `start, open, config`. The `fc.scheduler` harnesses
  additionally print the interleaving as a `schedulerFor()` template that
  pastes straight into a deterministic regression test.
- **Generate the whole world, not a seed.** Anything a PRNG used to decide
  becomes part of the generated value. Where a run consumes an unbounded number
  of decisions (chunk sizes across a second of audio, LLM script steps, deploy
  outcomes), generate a SHORT list and consume it CYCLICALLY — one entry per
  decision prints a wall of a counterexample and shrinks to nothing readable.
- **State-dependent choices stay dynamic.** A step that needs live state (which
  pending tool call to settle, whether a socket can open) generates an INTENT
  and no-ops when its precondition fails. Forcing it would drive the system
  through a transition it cannot really make.
- **Every run must be independently replayable.** Shrinking re-runs the property
  dozens of times, so per-run state has to be torn down in a `finally` (fake
  timers, audio mocks) and process-global state cleared per run (unhandled
  rejections). A leak here does not merely flake — it converges the shrinker on
  the wrong counterexample.
- **Coverage floors stay hand-rolled.** fast-check has no equivalent
  (`fc.statistics` only prints), and an all-green property proves nothing about
  a state the generator never entered. They are also LOOSER than the fixed-seed
  versions they replaced, by design: a fixed seed list produced near-constant
  counts, while fast-check draws a fresh seed per run.

  **Set the floor under the OBSERVED MINIMUM across many runs, and record the
  RANGE plus the run count in the comment — not one actual, never a fraction of
  the mean.** This guide said "~3x below measured actuals" and that is wrong,
  measured: three drafts calibrated that way tripped on real runs while flooring
  `aai-ui`'s five property suites (22-27 runs each). What a walk reaches is
  correlated WITHIN a run rather than independent per step, so these
  distributions have long left tails — one counter averaging **38** came out at
  **3** on a single run, an order of magnitude under any multiple of its mean.
  Only the observed minimum is evidence about the unluckiest run, and one run is
  not a range.

  The five `aai-ui` suites are the worked example — `fuzz-voiceio`'s
  `judgedDones` at `> 45` against a measured 158-203, `fuzz-hooks`'s
  `lateSettles` at `4` against 24-51 — each with its range in a trailing comment.
  Two corollaries: a state whose whole range is small gets `> 0`, the floor being
  there to catch a state NEVER reached rather than to pin how often; and a state
  measured but deliberately left UNFLOORED says so in place —
  `studio-concurrency-fuzz`'s unreachable archive path,
  `fuzz-session-core`'s settled tool call (0-5 of 200 runs, owned by
  `fuzz-hooks`), and `audio-stress`'s `concealments` (1-5 of 25 runs; longer
  sources, `jitterMs`/`refillMs` tuning and stall bursts were each measured and
  each left it unchanged — `playback-processor.test.ts` covers concealment
  deterministically).
- **A generator must not break its own contract.** The failure looks like a
  finding and is not. An all-false pacing script in `audio-stress` never
  delivered a chunk, so the delivery loop rendered forever and died on
  `RangeError: Invalid array length` a minute later; the fix forces one delivery
  by APPENDING rather than filtering, so every generated value maps to a legal
  one and shrinking stays well behaved.

### Changesets

This repo uses [@changesets/cli](https://github.com/changesets/changesets)
to track version bumps. Every PR that changes code in `packages/` **must**
include a changeset file (enforced by the pre-push hook).

**Creating a changeset (interactive — preferred for humans):**

```sh
pnpm changeset          # Prompts for packages + bump type + summary
```

**Creating a changeset (non-interactive — for agents/CI):**

```sh
pnpm changeset:create --pkg @alexkroman1/aai --bump patch --summary "Fix typo in error message"
```

Multiple packages:

```sh
pnpm changeset:create --pkg @alexkroman1/aai --pkg @alexkroman1/aai-ui --bump minor --summary "Add new session API"
```

If the change doesn't need a release (docs-only, config, tests):

```sh
pnpm changeset add --empty
```

**Changeset file format** (`.changeset/<random-name>.md`):

```yaml
---
"@alexkroman1/aai": patch
---

Short summary of the change for the changelog.
```

Valid bump types: `patch` (bug fixes), `minor` (new features), `major`
(breaking changes).

**Fixed packages:** `@alexkroman1/aai`, `@alexkroman1/aai-ui`, and
`@alexkroman1/aai-cli` release together (configured in
`.changeset/config.json`). You only need to list one; the others are
bumped automatically.

**Checking status:** `pnpm changeset status --since=origin/main`

### API reference docs (TypeDoc)

`pnpm docs:api` generates the SDK API reference into `docs/dist` with
[TypeDoc](https://typedoc.org), covering the published surface of `aai`
and `aai-ui` (built `dist/*.d.ts`; the aai-cli subpaths are internal
build hooks and deliberately not documented). Entry points live in each
package's `typedoc.json`; a new subpath export needs an entry there too.
`docs/typedoc.json` sets `excludeInternal` — tag a symbol `@internal` to
keep it exported but out of the docs — and `treatWarningsAsErrors`, so a
broken `{@link}` or a type referenced by a public signature but not
exported **fails the build**. The generation runs as the turbo `docs`
task, wired into `pnpm check` and the CI check job as a merge gate; keep
it at zero warnings rather than downgrading the option.
**Code examples in docs compile**: `pnpm check:doc-examples`
(`scripts/check-doc-examples.mjs`, in `pnpm check` and the CI check job)
extracts every ```` ```ts ````/```` ```tsx ```` fence from published-package
doc comments, the scaffold CLAUDE.md, READMEs, and the studio prompt
modules, and compiles each as a self-contained module under the scaffold
tsconfig. A deliberate fragment opts out with `no-check` in the fence info
string (```` ```ts no-check ````). The
`.github/workflows/docs.yml` workflow publishes the site to GitHub Pages
(`https://alexkroman.github.io/agent/`) on every push to `main`. The
docs tooling lives in its own `docs/` workspace package
because TypeDoc needs the JS TypeScript compiler API — the one TS 5/6
shipped, which the TS 7 native compiler does not — so `docs/` pins
its own `typescript@6`, and `check:sherif` ignores the `aai-docs` package
to allow that one deliberate version split.

Precisely: TS 7.0 is not API-less, it is DIFFERENTLY-API'd. It ships
`typescript/unstable/{sync,async,fs,proto}` and `typescript/unstable/ast`
(scanner, parser, factory, visitor) — enough that the old "TS 7 exposes no
`createSourceFile`" line, which `aai-guest/studio-syntax.ts` also carried,
was wrong. The pin stays until TypeDoc itself migrates; nothing here can be
fixed by reaching for those subpaths.

### Git hooks (lefthook)

- **pre-commit**: runs `biome check --write` on staged files (via
  `scripts/pre-commit-format.mjs`) and `syncpack lint` when package.json
  changes.

  **A PARTIALLY-staged file is skipped, and that is the whole reason the script
  exists** (from vercel/eve's `pre-commit-fmt.mjs`). The hook was
  `biome check --write {staged_files} && git add {staged_files}`. Biome rewrites
  the WORKING TREE file, so on a file with some hunks staged and the rest not,
  that `git add` staged the whole thing and the author's unstaged work went into
  a commit they never chose — reproduced on a scratch repo, one staged and one
  unstaged line, and the unstaged line was in the index afterwards. It is
  silent, and `git add -p` / `git commit -p` are exactly the workflows that
  produce it. Skipping is the conservative half: an unformatted file fails CI
  loudly, where the alternative rewrites a commit nobody can see. The skip is
  ANNOUNCED — a silent one reads as "biome found nothing".
- **pre-push**: blocks pushes to main/master, **blocks pushes when branch
  is behind origin/main** (must rebase first), checks for merge conflicts
  with main, **verifies changeset exists for changed packages**, and runs
  `pnpm check`.

### Worktree gotchas

- Run `unset GIT_DIR` before `pnpm changeset status` in worktrees
  (lefthook sets GIT_DIR which confuses changeset's repo detection).
- Always use `pnpm install --frozen-lockfile` in worktrees to avoid
  modifying the lockfile. Fall back to `pnpm install` only if frozen
  fails (new deps added on the branch).
- Never edit `pnpm-lock.yaml` directly — always use `pnpm install`.

### Updating AGENTS.md

When you make changes that affect architecture, security model, conventions,
or gotchas, update the guide that OWNS the surface — the package's own
`CLAUDE.md` (see "Package guides" above) for anything package-specific, this
file only for repo-wide rules. Adding to the root instead of the package guide
is how this file grew to 233k characters and had to be split.

**The root guide is `AGENTS.md`, and `CLAUDE.md` is one line: `@AGENTS.md`.**
`AGENTS.md` is the filename every other agent tool looks for, so one canonical
file beats a per-tool set that drifts; Claude Code follows the `@` import, so
nothing is lost. Package guides keep the `CLAUDE.md` name because Claude Code
auto-loads a package's guide when you work in that directory — that behaviour
is the entire point of those files — and `konsistent.json` requires one per
package. Never paste content into the root `CLAUDE.md`; `check:claude-md` and
`claude-md-limit.test.ts` both fail if you do.

**Every guide must stay under 120,000 characters** (20% under the 150k
limit). `pnpm check:claude-md` enforces it and runs in `scripts/check.sh` and
the CI check job. `packages/aai-templates/scaffold/CLAUDE.md` is exempt from
the "repo docs" rule — it is a product artifact shipped to users — but not from
the size cap.

**And a rule that belongs in a GUARD does not belong here.** Most of what
follows in this file is a rule with a story attached, and a story is only
enforcement when a reviewer remembers it. `scripts/guard-invariants.mjs` is
where the mechanically-checkable half lives — see "Quality ratchets". Before
adding a paragraph that says "always X" or "never Y", check whether it can be
a numbered rule there instead; prose is the fallback, not the default.

## PR workflow

**Default:** When finishing a development branch, always push and create a
Pull Request (don't ask — just do it).

**Before pushing**, rebase on the latest `main` to avoid merge conflicts:

```sh
git fetch origin main
git rebase origin/main
```

The pre-push hook will automatically check for conflicts with `main` and
block the push if any are found. This prevents PRs from being opened with
merge conflicts.

Run `pnpm check:local` **before your first commit** on a PR branch. This
catches the most common issues that historically required follow-up commits:

1. **Syncpack version drift**: When bumping a dependency, also update
   `packages/aai-templates/scaffold/package.json` if it has the same dep.
   Note syncpack does NOT check the scaffold (it is excluded in
   `.syncpackrc.json`) — run `pnpm sync:scaffold` to sync it. `check:scaffold`
   now fails when it is stale, so this is a fix rather than something to
   remember; the same bump usually also owes `pnpm sync:guest-toolchain`, which
   `check:guest-toolchain` holds the same way.
2. **Test assertion mismatches**: After changing output formats or error
   messages, run `pnpm test` and update affected assertions.
3. **Lint in related files**: Pre-commit only lints staged files. Run
   `pnpm lint` to catch lint issues in files affected by your change.
4. **Type-level tests**: After changing public API types (`toAgentConfig`,
   `AgentConfig`, etc.), run `pnpm vitest run --project aai-types`
   to verify type contracts haven't regressed. Update `.test-d.ts` files
   if the change is intentional.
5. **Dependencies orphaned by a deletion**: removing the last consumer of a
   package leaves the `devDependencies` entry and its lockfile tree behind.
   `pnpm check:knip` catches this and is in the local subset for that
   reason — it's the one failure you won't notice while working, because
   deleting code puts your attention on what goes away, not on what the
   removal strands. When a PR deletes a directory, expect a dependency to
   come out with it.

   **It also reports unused EXPORTS, and the setting that makes that useful
   is `includeEntryExports` — set on the private packages only.** With it on,
   knip reports a file's exports even when the file is an entry point; that is
   right where every importer lives in this repo, and wrong for `aai`,
   `aai-ui`, and `aai-cli`, whose entry exports are the published API and
   whose consumers (templates, user projects) knip cannot see. Reporting those
   is what produced the 174-finding run that kept the whole check switched off
   for so long. The published packages still get the check for everything
   *not* reachable from a subpath export — an internal helper whose last
   caller went away, which is the case worth catching. `types` stays excluded
   pending an `@internal` tagging pass.

## A new guest route must declare how the PLATFORM exposes it

`aai dev` serves the guest's own routes directly, so a feature is developed
against a server where the guest's dispatch table is the whole API. Deployed,
almost nothing works that way, and the gap is invisible in a diff and to the
feature's own tests — it has landed twice. `GUEST_ROUTE_EXPOSURE` and
`GUEST_ROUTES` (`packages/aai-server/guest-routes.ts`) are what close it.
**See "A new guest route must declare how the PLATFORM exposes it" in
`packages/aai-server/CLAUDE.md`** for the four exposure kinds, which half is a
test and which is `guard-invariants` rule 12, and why exposure is decided by
who CALLS a route.

## Security architecture

The security model is documented where the boundaries live:

- **Sandbox isolation, credential separation, auth, `run_code`, the platform's
  own threat model** — `packages/aai-server/CLAUDE.md`.
- **What a guest may do, what the harness contract exposes, guest network
  access + SSRF (`aai/host/ssrf.ts` is the implementation), and credential
  separation** — `packages/aai-guest/CLAUDE.md`.
- **The `sdk/` vs `host/` dependency boundary** — `packages/aai/CLAUDE.md`.
- **Where the CLI is allowed to send a user's API key** —
  `packages/aai-cli/CLAUDE.md`.

Two rules general enough to state here: **the Modal container is the security
boundary** (no in-process capability stripping is relied on anywhere), and
**every AssemblyAI key on the platform is user-provided** — there is no
platform-owned provider credential, and no credential resolution path may fall
back to the host's `process.env`.

### Known limitations

- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`,
  plus the provider descriptors) and `aai-ui` (`.` — the four generic hooks a
  custom client is written against). Subpath exports (e.g. `./protocol`) are
  not covered by type tests. (Their RUNTIME export lists are pinned — see
  `sdk/exports.test.ts` — which is a different guarantee.)

  This entry claimed the `aai-ui` half for a long time before it was true:
  every `.test-d.ts` in the repo lived in `packages/aai`, and the
  `aai-types` project is rooted there, so it could not have run an `aai-ui`
  type test if one had been written. What was unpinned is exactly what a type
  test is for — `useToolResult<R>`'s two overloads, `useAgentState<S>`'s
  nullable return, and the deliberate `any` on both (`DefaultToolResult`, and
  `ToolCallInfo.args`), which are documented decisions with a rationale and no
  check. `hooks.test-d.ts` pins them now, including the `any`s, because
  tightening one to `unknown` is a breaking change for every untyped client
  and should fail here rather than in a user's build.

### Open testability work

One known gap: **`aai-server` writes to `console.*` directly**, with no logger
seam, so most of the repo's `spyOn(console, …)` calls exist purely to keep test
output quiet. Sized, not stuck — the count and the plan are in "The missing
logger seam" in `packages/aai-server/CLAUDE.md`, which is where they stay: the
copy that used to be here had drifted to a different pair of numbers.
