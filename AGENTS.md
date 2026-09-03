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

**Never type `turbo run <task>` across the workspace directly** — the six
fan-out scripts go through `node scripts/with-worker-budget.mjs turbo run …`,
because turbo's concurrency and each task's vitest pool are ONE mechanism and
only bound the machine when `TURBO_CONCURRENCY` is set. Unset, `pnpm test` ran
~40 processes on 4 cores and timed out `aai-cli`'s bundler specs on contention
alone. That script, `_turbo-concurrency.mjs` and `vitest.shared.ts` carry the rest;
a longer timeout is never the fix.

### Test tiers

**Tiers are cut by what a test may TOUCH: pick the tightest one that can express
the assertion.**

| Tier | Command | Membership rule | Timeout |
| --- | --- | --- | --- |
| Unit | `pnpm test` | no filesystem writes, subprocess, or real network | 5s |
| Integration | `pnpm test:integration` | multiple modules **in memory** | 30s |
| Scenario | `pnpm test:scenario` | a real subprocess, port, bundler, Postgres, or NETWORK | 120s |
| Scenario + real Postgres | `pnpm test:pg` | the above, `AAI_TEST_PG_URL` resolved | 120s |
| E2E | `pnpm test:e2e` | full process spawn + Playwright browser | 300s |
| Eval | `pnpm test:eval` | a live model on a real key, `*.eval.test.ts` | 1800s |
| Templates | `pnpm test:templates` | template agent example tests | 5s |

**A LIVE eval REPORTS and does not gate** — a measurably noisy instrument must
not block a merge. Runs repeat and the report carries a spread. What `pnpm check`
and CI do run is the same files with `AAI_EVAL_STUB=1`: a SCRIPTED model, so the
run is deterministic and free and what it gates is wiring, not behaviour (see
"A keyless run gets a SCRIPTED model" in `packages/aai-runtime/CLAUDE.md`).
`packages/aai-evals/CLAUDE.md` owns the live half.

They used to be separated by TIMEOUT, a proxy for the rule above that stops being
one as soon as two tests are slow for unrelated reasons. `pipeline-fuzz` (pure
memory) and `platform-schema` (needs a database) shared one tier, timeout, retry
policy and serial block, so neither was configured for its own failure mode — and
`pnpm test:integration` took **721 seconds to evaluate twelve tests**, 50 of 63
skipping for want of a database. It is 10 seconds now.

**Real NETWORK is the unit tier's boundary and lands a test in SCENARIO**, which
the table left implicit: the unit row forbade it and no other row claimed it.
`aai-runtime/agent-server.scenario.test.ts` is the worked case — two specs that
open a live voice session, so the runtime really dials the STT provider and is
really refused, and they had sat in the unit tier failing on any machine with
egress while passing wherever that connect fails fast. Note what the fix was NOT:
their assertions resolve promptly, and what overran the 5s budget was TEARDOWN
draining three provider connect attempts, so the tier is the answer and a longer
deadline is not. A test in that tier for network reasons alone needs no gate —
there is nothing to resolve and nothing to skip.

**Membership is a NAMING CONVENTION** — `*.integration.test.ts`,
`*.scenario.test.ts` and `*.eval.test.ts`, excluded by every unit config and
selected one each by the scripts, so a new test needs no config edit (see
"Integration- and scenario-tier membership" below for the deliberate exceptions).

**No tier carries a `retry`** — a tier that retries has classified its own
failures as noise; `vitest.slow.config.ts` carries the argument.

**Fifteen scenario suites need a real Postgres, and without one they SKIP** — a
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
pnpm vitest run packages/aai/sdk/types.test.ts  # Single file
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

### Full CI check (`pnpm check`)

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

### Quality ratchets

Beyond lint/typecheck/test, `scripts/check.mjs` **and the CI check job** run
eleven **gates** (all also runnable standalone) that hold the line on technical
debt. Two compare against a COMMITTED PER-FILE BASELINE
(`check:hatches`, `check:invariants`); the rest are absolute. They must stay
wired into BOTH: for a long time they lived only in `check.mjs`, which CI never
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

**`check:deploy-changeset` is the ONE exception, and it does not weaken the
rule.** What it checks is a property of a BRANCH rather than of the tree — did
this change to platform source bring a changeset that ships it — so there is no
tree-scoped spelling of it available. What generalizes from the paragraph above
is not "never resolve a ref", it is **never report success over a comparison you
could not make**: an unresolvable base FAILS there, naming `--base` and
`git fetch`, where the escape-hatch gate printed a checkmark. Read that as the
bar any future diff-scoped gate has to clear, not as a precedent for skipping.

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
  ratchet: the old total-based version passed a branch that traded one hatch for
  another elsewhere — verified by A/B, the total stayed at 122 and only the
  per-file gate caught it.
  **The engine counts OCCURRENCES, not matching lines** — `git grep -o`. Both
  baselines describe themselves as recording occurrences and for a long time
  recorded lines: three casts on one line reported `found 1`, the same three on
  three lines reported `found 3`. Honest when it was measured (94 lines against
  94 occurrences) and structurally wrong, because a file at its budget could
  absorb more by appending them to the line that bought the budget. The scan is
  two passes: `-n` for the source line the report prints and the comment filter
  decides on, `-o` for the count.

  **And `assertScanCorpus` diffs `git ls-files` against `git grep -lI`, because
  ONE control character makes a whole file invisible.** A single raw NUL makes a
  file BINARY to `git grep`, silently exempting it from every line rule and
  every hatch pattern — and the corpus floor cannot catch it BY DESIGN, the file
  still being in `git ls-files`. It has cost this repo three times
  (`host/workflow-notify.ts`, `host/workflow-keys.ts`, `konsistent-config.test.ts`,
  which used raw NULs as regex placeholder sentinels), the first two fixed one
  byte at a time with no detector added — which is the argument for the
  detector. Spell the character as an escape: byte-identical, and the file is
  text again. A genuinely binary extension goes in `KNOWN_BINARY`
  (`scripts/_ratchet.mjs`), a DENY-list so a new source extension defaults into
  being checked.

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

  `node scripts/check-escape-hatches.mjs --update` lowers the baseline to the
  tree and **refuses to raise anything**, so recording a removal is one command
  and blessing an addition needs a hand edit in a reviewable diff. A run under
  budget WARNS, naming the entries to give back — unclaimed headroom is a hatch
  the next branch gets for free.

  **Both baseline ratchets now share one engine (`scripts/_ratchet.mjs`), and
  both take a CORPUS FLOOR: the pathspecs must resolve to at least 800 files or
  the run fails.** `git grep` exits 1 both for "no matches" and for "pathspec
  matched nothing", and the two are indistinguishable from the exit code — so a
  package rename or a typo'd `:!` exclusion made every pattern report `now=0`,
  which then degraded to the stale-warning path and printed a checkmark. The
  floor is on the CORPUS rather than on the match count deliberately: these are
  DEBT ratchets whose goal is zero, so a minimum match count would eventually
  block the very campaign the gate exists to encourage.

  **Markdown is not scanned**: the patterns are plain substrings with no notion
  of code versus prose, so any doc that *discusses* a hatch scores as one — and
  `CHANGELOG.md` is generated from changeset summaries, so one naming a pattern
  failed the Version Packages PR on a file no human wrote. A changeset summary
  may name a pattern freely. `escape-hatch-scope.test.ts` guards the
  exclusion, and asserts the patterns really do match prose so it cannot pass by
  them quietly becoming narrower.

  **`as unknown as` is the one to watch**: it launders a value past the checker
  without tripping `as any`, and went 210 → 105 once counted. Copy the removals
  — a concentration of identical casts is a missing **typed seam**, one
  narrowing in one helper every call site goes through (`fakeOf(session)`,
  `asSessionWs(ws)`), not a cast per assertion. Some need no cast once the
  tool's own affordance is used: `vi.mocked(fn)`, or typing a recorder with
  `Parameters<T>` instead of widening and re-narrowing.

  The baseline is itself a list of the pattern names, so it needs the same
  pathspec exclusion the script does — its first per-file run scored its own
  keys as four fresh hatches. Same trap as markdown, by a new route.
- **`pnpm check:file-length`** (`scripts/check-file-length.mjs`) — caps
  source files at 500 lines and test files at 700. Files that already
  exceed the cap are grandfathered in `scripts/file-length-allowlist.json`,
  which records each file's current ceiling; a grandfathered file may not
  grow past its ceiling, and ceilings should only ever be lowered as files
  are split up. New files must come in under the cap. Templates under
  `packages/aai-templates/templates/` are exempt.

  **Its `scripts/` pathspec measured nothing at the top level for as long as it
  existed**, and the trap generalizes to every git pathspec in the repo. A
  pathspec is fnmatch WITHOUT `FNM_PATHNAME`, so `*` already crosses `/` and
  `scripts/**/*.mjs` parses as "scripts/" + anything + "/" + anything + ".mjs" —
  the literal slash makes a subdirectory MANDATORY. It therefore matched
  `scripts/starter-eval/` and not one of the ~29 files at the top level —
  exactly where an unreviewed harness hides — while printing "all files within
  caps ✓"; adding `scripts/*.mjs`/`scripts/*.ts` took the measured set from 6
  files to 35. **Both ratchets' `:!scripts/**/*.md` exclusions had it too**, and
  `:!scripts/*.md` now sits beside each. `packages/**/*.ts` is unaffected only
  because every source file there is at least one directory deep, which is why
  the miss survived review. Verify any pathspec with `git ls-files "<glob>"`
  rather than reading it; `file-length-gate.test.ts` pins both shapes.
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
  rightly checks nothing, which is never true. It carries FLOORS (200 files,
  2,000 tests), and its parser is specced in
  `packages/aai-templates/test-assertion-gate.test.ts` — both for the same
  reason the corpus floor above exists: its whole success output is a count, so
  a glob or a parser that stopped recognising `test(` would print "all 0 test(s)
  assert something ✓" and pass, the same shape as the bug it exists to catch.
  **It runs on a real parse** — `oxc-parser`, via
  `scripts/_test-assertions-parse.mjs`, whose module doc carries the argument
  and the ~140 lines of hand-written lexer it replaced. Masking comments and
  strings (a JSDoc paragraph *about* `test()` is not a test) and excluding
  `RegExp.prototype.test` (five of the first run's eight offenders) are
  properties of an AST rather than patterns to keep correct — and the parse sees
  a family the regex could not: the old opener admitted one `.word(…)` before
  the call, so `test.concurrent(…)` was invisible, hiding eleven bodies whose
  claim was a bare `await` that HANGS rather than fails. A file that will not
  PARSE fails the run; skipping it would understate every count the gate prints.

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
  It also PINS the root `CLAUDE.md` to the single line `@AGENTS.md`: a shim
  that grew back into a second copy of the guide is the failure this two-name
  pattern invites — Claude Code would read it and every other agent tool would
  read `AGENTS.md`, with no symptom until the two halves disagreed.
  **The same cap is also a TEST**
  (`packages/aai-templates/claude-md-limit.test.ts`), so it fails in the
  ordinary test run and not only in `pnpm check` — an agent editing a guide
  sees it without knowing this gate exists. It asserts both lines separately
  (over budget = refactor before adding more; over 150k = a guide is being
  truncated right now), that the root still links every package guide, and
  that the script and CI wiring still agree with it.
- **`pnpm check:coverage-per-file`** (`scripts/check-coverage-per-file.mjs`) — a
  50% per-file statement floor over what `test:coverage` wrote, because the
  `vitest.config.ts` thresholds are PACKAGE-wide and cannot see one new module
  landing untested. **Its ratchet runs the other way** — coverage may only go up,
  so `--update` refuses to lower an entry and never creates one; `--seed` is the
  bootstrap, opened at 15 files. Runs per package in CI's coverage matrix
  (`--package`). The script's own doc carries the rest.

- **`pnpm check:konsistent`** ([konsistent], config in root `konsistent.json`)
  — enforces **structural** conventions: the shapes that are wrong only in
  relation to their siblings, which is why no per-file tool can see them.
  Biome lints statements and tsc type-checks a program; neither can say "every
  module in this directory must look like the others." The seventeen
  conventions cover the four things this repo restates by hand — the
  per-package file set (`package.json`, `tsconfig.json`, `vitest.config.ts`,
  `CLAUDE.md`, plus README/`tsconfig.build.json`/`tsdown.config.ts` on the
  four published ones) and each `vitest.config.ts` importing `sharedConfig`;
  `*-barrel.ts` files being pure re-export surfaces; the **dependency-graph
  boundaries** under "Dependency flow" (aai imports no sibling, aai-runtime
  imports only aai, the CLI imports neither server nor guest, the guest imports
  no server code, the SERVER imports no guest source, and neither browser bundle
  — aai-ui, the studio client — imports platform or runtime code); and the
  repeated-by-construction shapes — every
  STT/TTS/LLM/S2S provider module's `*_KIND` / `*_API_KEY_ENV` / `*Options` /
  `*Provider` / factory / `resolve*Settings` set, every CHANNEL module's
  `*_CHANNEL_KIND` / `*ChannelOptions` / factory set (no `*_API_KEY_ENV`: a
  channel's credential is its destination and is passed in, never read from the
  agent env), and every template's `agent.ts` + `client.tsx`.
  `pnpm check:konsistent-config` (`konsistent validate`) checks the config
  against its schema without touching the tree.

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
  (`openai: openai`, `openrouterLlm`, `elevenlabs`) look redundant and are what
  keep `openai()` right.

  The version is pinned **exactly** (`1.0.0-beta.4`, the registry's `latest`)
  rather than caret-ranged: a `^` range over a prerelease drifts onto
  `1.0.0-beta.6`, which renames the predicates (`export` → `exportValues`,
  `import` → `importValues`, `importFrom` → `importValuesFrom`). Read the
  predicate catalog from `node_modules/konsistent/docs/`, not the GitHub README,
  until that pin moves; the two disagree.

  [konsistent]: https://github.com/vercel-labs/konsistent

- **`pnpm check:invariants`** (`scripts/guard-invariants.mjs`, rules in
  `scripts/guard-invariants-rules.mjs`) — **the mechanical half of this file.**
  Numbered rules, each printing WHY the invariant exists and what to use
  instead, so a violation is self-correcting and a reviewer never re-explains
  it.

  | # | Rule | Instead |
  | --- | --- | --- |
  | 1 | no symlinks anywhere | a real file, or a module that re-exports |
  | 2 | no conditional spread on a `!== undefined` presence test — all three spellings | `omitUndefined()` |
  | 3 | no `Promise.race` against a `setTimeout`, WRAPPED FORM INCLUDED | `p-timeout` |
  | 4 | no inline `new Promise(r => setTimeout(r, 0))`, `setImmediate` and `<T>` included | `flush()` / `tick()` |
  | 5 | no `delete process.env.X` | `vi.stubEnv(name, undefined)` |
  | 7 | no floating-tag GitHub Action | a 40-char commit SHA |
  | 8 | no `if (m.get(k) === mine) m.delete(k)` | `createOwnedMap()` |
  | 9 | no `tails.get(k) ?? Promise.resolve()` | `createKeyedLock()` / `slot.update` |
  | 11 | no hardcoded `/tmp` in shipped source | `join(tmpdir(), …)` |
  | 12 | every guest route literal is in `GUEST_ROUTES` — `aai-guest` AND the `aai/host` modules it bundles | declare it + its exposure |
  | 13 | no template import escaping its template dir | move it in, or publish it |
  | 14 | no fixture directory nothing reads | delete it, or add the reader |
  | 16 | no new `on*` on a SESSION callback surface | an event + `report(event)` |
  | 17 | no open-coded record guard, in either polarity | `isRecord()` |
  | 18 | no `req.url.split("?")` | `requestPath()` / `requestQuery()` |
  | 19 | no hand-rolled sleep (or `node:timers/promises`), `<T>` included | `sleep()` |
  | 20 | no changeset that cannot bump, or that ships nowhere | a real name, plus a package that carries it |
  | 21 | no `expect.poll` — a `test.concurrent` sibling clears the pointer it reads | `vi.waitFor()` |
  | 22 | no truthiness-guarded conditional spread — `...(x && { x })` | a judgement: see the rule's remedy |
  | 23 | no `async` function handed straight to `.on`/`addEventListener` | a sync listener + `void p.catch(report)` |
  | 24 | no new field on `ToolContext` | that value's own module + capability root |
  | 25 | no new field on the shared channel message shape | that kind's own options type |
  | 26 | no raw step call in a shipped `workflows/` body | the `*Classified` sibling |
  | 27 | no explicit `[Symbol.dispose]()` call in shipped source | `using` / `await using` |
  | 28 | no hand-rolled `process.argv` scan in `scripts/` | `parseScriptArgs()` |
  | 29 | no `globalThis.fetch` as a runtime egress default | `egressFetch()` |
  | 30 | no non-deterministic read in a shipped `workflows/` body | move it inside `ctx.step` |
  | 31 | no hand-rolled jittered backoff | `jitteredBackoff()` |
  | 32 | no computed journal identity (a template-literal step/wait name) | a plain string literal |

  Hand-kept, and it keeps going stale — it stopped at 23, then at 28, and
  `--rules` is the derived source to read instead. The recurrence IS the
  argument: this table is a convenience copy, so when it disagrees with
  `--rules`, `--rules` is right.
  Rule IDs are **stable** — they appear in commit messages and in the baseline,
  so a deleted rule leaves its number retired rather than letting a later rule
  inherit it (6, retired with `ctx.state`; 10, with the `research/` directory it
  checked; 15, reserved). Several are at zero and enforced
  absolutely; the rest carry per-file baselines. **Rule 3 left that list when it
  was widened**: a wrapped `Promise.race([` is matched by its opening line,
  which cannot see whether a timer is among the elements, so a timer-free
  wrapped race is a legitimate entry. Over-reporting is the cheap error here —
  see `RACE_CONTINUES` in `guard-invariants-ere.mjs`.

  **Rule 2's `undefined` scope is a BOUNDARY, and rule 22 is why.** Rule 2 tests
  presence, which `omitUndefined` *is*, so its matches rewrite without changing
  behaviour; `...(x && { x })` also drops `""`, `0` and `false`, so widening rule
  2 to reach it would have the gate recommend a behaviour change on 145 lines.
  Rule 22 counts that family instead, the first rule here **seeded as debt** (145
  across 75 files, goal zero) — its entries are lines nobody has read yet.

  **Seven scopes, seven corpus FLOORS**, and three were missing — the
  shipped-source corpus rules 11 and 27 share (1,224 files, and 11 is the
  Windows-portability rule whose regressions are invisible on every machine
  that runs CI), rule 12's guest HTTP surface, and rule 13's 175 template
  files. The last two derive their corpus from `git ls-files`, which
  exits **0** on a pathspec matching nothing where `git grep` exits 1 — that
  asymmetry is exactly why the grep-based rules announced their own blindness
  and these two could not.

  **The rule definitions are six modules behind one barrel.**
  `guard-invariants-rules.mjs` re-exports `LINE_RULES` (sorted by id) and the
  scope constants; under it sit `-ere.mjs` (the regex vocabulary),
  `-scopes.mjs` (the corpora), and four rule groups — `-rules-timing.mjs` /
  `-rules-shape.mjs` / `-rules-state.mjs` / `-rules-workflow.mjs`, the last
  holding the two rules over a shipped `workflows/` body, which left the timing
  module when rule 31 took it past the source cap.
  **Every one is in the gate's `SELF_REFERENTIAL` set**,
  because each `label` and `re` describes the thing it bans — a split that
  forgot one file would be the fifth time this repo pays for that trap. A rule
  may also carry `samples: { matches, ignores }`, where a widened pattern's
  proof belongs: rule 3 shipped for months with a single-line positive sample
  while the rule was blind to the multi-line form.
  `node scripts/guard-invariants.mjs --rules` prints the catalogue DERIVED from
  the definitions — the prose copy that used to live in the script's header went
  three rules stale (17, 18, 19) while the one computed line, the printed count,
  stayed right. The per-file baselines carry the same `--update`-only-lowers
  contract as `check:hatches`.

  **A baselined occurrence needs a reason, and the JSON is NOT where it goes** —
  that file is a bare `{path: count}` map written by `--update`, with
  `_description` its only prose, so a reason recorded there would be erased by
  the next regeneration. It lives at the OCCURRENCE, in a comment beside the
  line. A roster used to be duplicated here and is not, for the reason the
  script's own prose copy of the rule catalogue was deleted: a hand-kept list of
  baseline entries goes stale while the generated one stays right. Read the
  entries out of the baseline and the reasons off the lines they sit on. The one
  rule whose entries are NOT yet defended decisions is 22 — see above.

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

  **Four of these rules found real bugs on the day they were written**, which is
  the argument for the whole gate. Rule 2 caught two `omitUndefined` conversions
  the documented 44-site sweep had missed. Rule 11 came out of a Windows CI leg
  failing on two shipped modules writing to a literal `/tmp` — drive-relative on
  Windows — both of which also run under `aai dev`, so the bug was never
  guest-only. Rule 23 found the fourth, in the SHIPPED `scaffold/server.mjs`,
  which `biome.json` excluded from linting until then.

  **Rule 20 (from vercel/eve's rule 29) closes a gate that reported success over
  a mistake**, in the release path. A changeset whose package key is a typo is
  IGNORED rather than rejected: `pnpm changeset status --since=origin/main` —
  what the pre-push hook already runs — prints an empty bump list and exits 0,
  verified by adding `"@alexkroman1/aai-typo": patch`. The release silently does
  not happen and it surfaces after merge, on a branch that is gone. The rest of
  the argument, including why it is its own module, is in
  `scripts/guard-invariants-changesets.mjs`.

  Rule 19 found a **sixth** hand-rolled `sleep` no gate could see:
  `host/workflow-notify.ts` held a raw NUL byte, making the file BINARY to
  `git grep` — silently exempt from every rule and from `check:hatches`.
  Fixing the byte is what let the rule find the copy.

  **Rule 16 is scoped to an explicit FILE LIST** (role is not derivable from a
  path), so its gate spec asserts every path exists; it also made
  `SELF_REFERENTIAL` per-rule rather than per-file.

  Two things any new rule must respect — a dead pattern prints the same
  checkmark as a rule upheld, and the rules module matches its own rules.
  `guard-invariants-gate.test.ts` specs both; aai-templates' guide argues it.

- **`pnpm check:deploy-changeset`** (`scripts/check-deploy-changeset.mjs`) — a
  branch that changes code the PLATFORM DEPLOY carries must add a changeset that
  ships it. `ship.yml` arms its deploy on a version bump to `aai-server` or
  `aai-studio-server` and NOT on a source change (see "Fixed release coupling"),
  while `changeset status` is satisfied by an EMPTY changeset — so a branch could
  rewrite the platform, pass every other gate in this list, merge, and ship
  nothing. **That is #1341**, the failure the version gate is accused of causing
  and a changeset is the answer to; this is what says so at push time instead of
  leaving it to whoever notices production is a release behind.

  Four packages are in scope, because four reach production only through a
  deploy: the two server packages, plus `aai-studio-client` (its `dist/` is baked
  into the Modal image) and `aai-guest` (its harness is baked into the guest
  image, whose tag the server PINS at deploy time). Two of them are CARRIERS —
  the ones whose version bump actually arms the deploy — and a satisfying
  changeset has to name one. `guard-invariants` rule 20's `SHIPS_VIA` is the same
  model from the other side and the two COMPOSE: that rule catches a changeset
  naming `aai-studio-client` without a carrier, this one catches a branch that
  named neither, which is the case a rule reading changeset CONTENT cannot see.

  **It is deliberately stricter than the mechanism.** An SDK changeset bumps both
  carriers as dependents (`updateInternalDependencies: "patch"`), so it would
  ship the platform anyway — and accepting that would have passed #1341, which
  shipped precisely because something else was being released. Naming a carrier
  means the platform ships because the author said so. For the same reason only
  the changesets the BRANCH adds or edits count; a pending one on `main` bumps a
  carrier for any branch cut while it sat there, which is the accident.

  Two mechanical notes. The diff is **merge-base to WORKING TREE**, untracked
  files included — `base...HEAD` compares two commits, so `pnpm check` would
  print a checkmark over uncommitted work, and a brand-new module and a
  brand-new changeset are both invisible to `git diff`. And a **carrier version
  bump satisfies it directly**, using `ship.yml`'s own `bumped()` predicate:
  that is what keeps the Version Packages PR green, since that branch deletes
  the changesets and writes the version lines, and reading the mechanism beats
  exempting a branch NAME. There is no opt-out and no allowlist — a path that
  does not ship is a fact about the PATH, so it belongs in `isShippedSource`.
  `aai-templates` has the same shape by the npm route and is deliberately out of
  scope.

- **`pnpm check:agent-guide`** (`scripts/sync-agent-guide.mjs`) — asserts
  `packages/aai/AGENT_GUIDE.md` is the current copy of
  `packages/aai-templates/scaffold/CLAUDE.md`; see "The authoring guide ships
  inside the SDK" below. Same silent-staleness shape as `check:guest-toolchain`.
- **`pnpm check:authoring-guide`** (`scripts/check-authoring-guide.mjs`) —
  `check:agent-guide` says the shipped guide is CURRENT; this says it is
  COMPLETE. Every contracted authoring capability must be named in the guide's
  CODE, never prose. Thirteen were absent; its own doc has the rest.
- **`pnpm check:scaffold`** (`scripts/sync-scaffold-versions.mjs --check`) —
  asserts `packages/aai-templates/scaffold/package.json` still matches the
  workspace. Third file in this committed-copy shape and the only one that
  SHIPS, so it is where a catalogued bump is applied twice. It was enforced by
  nothing until it broke, and `check:publish-protocols` structurally cannot
  cover it — see "`check:scaffold` exists because the sync ran only during a
  release" in `packages/aai-templates/CLAUDE.md`.

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

These are pure fs checks (no build needed), so they run up front and fail fast.
To tighten quality over time, lower the entries in the file-length allowlist and
in the two per-file baselines (`escape-hatch-baseline.json`,
`guard-invariants-baseline.json`) — all three only move one direction, and
`--update` on the latter two enforces that rather than trusting it.

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
not.** `scripts/check.mjs` ran `test`, CI's matrix runs `test:coverage`, so the
one gate a PR could not see coming was its own coverage: every suite green
locally, `test (<pkg>)` red in CI. It happened — a new 300-line module in
aai-ui landed at 1.44% line and 0% branch coverage, took the package under all
four of its floors, and cost a whole follow-up commit to fix. Floors do not
move to accommodate a PR, so the earlier that is known the cheaper it is. Both
`check.mjs` modes and `check:affected` run `test:coverage` now.

## Architecture

Ten workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: agent config, types, protocol, S2S, session, Db |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (React 19): session, audio, UI components |
| `packages/aai-runtime/` | `@alexkroman1/aai-runtime` | The HOST runtime: `createRuntime`/`createAgentServer`, the session core, transports, provider openers, the workflow API. What runs an `agent.ts`; an `agent.ts` imports none of it |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, eval, build, list, pull, push, publish, delete, login, secret, logs, workflow, templates (`deploy` is hidden/internal — the mechanism in-guest Publish runs). The list is PINNED to the registry in `cli.test.ts` — it named a removed `storage` for several releases |
| `packages/aai-guest/` | `aai-guest` | Guest sandbox harness (private): the Node entrypoint that runs the complete agent inside each Modal Sandbox, built into one self-contained `dist/harness.mjs` |
| `packages/aai-server/` | `aai-server` | Agent service + shared platform core (private): sandbox, auth, SSRF, stores, locks |
| `packages/aai-studio-server/` | `aai-studio-server` | Studio service (private): browser coding agent, workspace builds. Also the composition root — its entry is the one every deployment runs |
| `packages/aai-studio-client/` | `aai-studio-client` | The studio's browser front-end (private): Vite React app served by aai-server |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |
| `packages/aai-evals/` | `aai-evals` | Behaviour eval tier (private): the runner, its assertion vocabulary over the session event stream, and its targets |

**Dependency flow:** every other package depends on `@alexkroman1/aai` (via
`workspace:*`), and `aai-runtime` sits one layer above it — the CLI, the guest,
the server and the evals all take the host runtime from there, while
`aai-runtime` imports only `aai`. `aai-server` depends on
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

Two edges sit outside that spine. `aai-studio-server` → `aai-server` is the
repo's LARGEST: 158 import sites across all 36 of that package's subpath
exports, and not one bare `aai-server` specifier — which is why a boundary rule
naming the bare name matched nothing for as long as it existed (konsistent's
matcher is exact unless the pattern ends `/*`). And `aai-evals` →
`aai-studio-client/starters`, its only workspace edge beyond the SDK.

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
| `packages/aai/CLAUDE.md` | SDK layout (`sdk/` vs `host/`), subpath exports, session modes, STT/LLM/TTS/S2S providers, voices, `ctx.generate`, what persistence a tool gets, the concurrency primitives, session slots, the canonical agent-config schema, data flow, the defaults/magic-numbers table |
| `packages/aai-ui/CLAUDE.md` | Browser session, client audio path (capture/playback worklets, pacing, jitter buffer), components, fuzz harnesses, **workflow apps** (`page()`, `createWorkflowApi`, `useWorkflowRun`, and the workflow HTTP API the SDK serves) |
| `packages/aai-cli/CLAUDE.md` | Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`), bundling + Vite rules, credential destinations, `aai dev`'s server and host mode, self-hosting (`npm start`) |
| `packages/aai-runtime/CLAUDE.md` | The host runtime: why it is its own package, the one-way dependency on the SDK, the fifteen `host/` modules that stayed, and the `host-internal` seam |
| `packages/aai-guest/CLAUDE.md` | The guest harness: one binary / three modes, user-shipped runtime, dev-prod parity, agent guests as servers, guest network access + SSRF, credential separation |
| `packages/aai-server/CLAUDE.md` | Platform: sandboxes + Modal backends, stateless server, security architecture, auth, telephony, durable-workflow routes, stores/locks |
| `packages/aai-studio-server/CLAUDE.md` | Browser studio: workspaces, coding agent, previews, Publish, LLM selection, studio evals, the two-package/one-deployment composition |
| `packages/aai-studio-client/CLAUDE.md` | Studio front-end: panes, composer queue, CSP, preview probing |
| `packages/aai-templates/CLAUDE.md` | Templates + scaffold packaging. Note `scaffold/CLAUDE.md` is a product artifact, not repo docs |
| `packages/aai-evals/CLAUDE.md` | Eval tier: recorded assertions, the spread report, why it does not gate, the two levels |

One guide sits outside `packages/`: [`docs/CLAUDE.md`](docs/CLAUDE.md), for the
`aai-docs` workspace — both TypeDoc renderings, the committed markdown
reference, and the `typescript@6` pin — **and, because they answer three
versions of one question, the API REPORTS and the capability EPOCHS as well.**
See "The published surface is described by three committed artifacts".

Two files sit outside the table for a different reason:
`packages/aai-server/MODAL-CLAUDE.md` and
`packages/aai-runtime/JOURNAL-CLAUDE.md`, SIBLINGS of their package's guide
rather than second package guides. `check:claude-md` measures it (its pathspec is
`*CLAUDE.md`) and konsistent permits it (`workspace-package-layout` requires a
`CLAUDE.md` and forbids nothing else), but Claude Code auto-loads only
`CLAUDE.md`, so a sibling is read on demand and is only the right shape for
REFERENCE — a build recipe — never for a rule someone needs resident. Prefer
moving a section to the package that owns the surface; reach for a sibling when
no other package owns it and the guide is at the cap.

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
  A `tools/` file is exempted by an override: its name mirrors the
  snake_case LLM tool name.

  **`^2.5.12` is a FLOOR, and biome is the one dependency exempt from the
  release-age quarantine** — argued at `minimumReleaseAgeExclude` in
  `pnpm-workspace.yaml`. 2.5.9-2.5.11 report an already-awaited
  `await pTimeout(…)` as floating, costing nine suppressions; 2.5.12 also
  retires the one this cost at 2.5.8. Do not lower the floor.

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
  **The split has a RULE now rather than a precedent: anything that INSTALLS,
  and anything that RESTORES, is `/testing/vitest`.** Every fake filling a
  published slot hands back a `restore` the caller owns, and owning it means a
  `const restores: (() => void)[]` plus an `afterEach` that splices it — written
  out template after template, three times in one file. `install*` is that fake
  plus `onTestFinished(restore)`. A fake with no lifetime (`stubGenerate`,
  `createToolContext`) gets no wrapper.
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

### Disambiguating cross-package names

**Eight names are published by two packages at once.** Settle any claim here
against `API-EXPORTS.json` — it records the SUBPATH each name comes from, which
is the whole question. Seven are on `aai` and `aai-ui`, each a re-export of the
single `aai` declaration — one concept with two reference pages, not a
collision: `ClientConfigResponse` and `SessionErrorCode` (`/protocol`; the
latter's union is eight wire codes), plus `WorkflowApi`, `WorkflowSummary`,
`WorkflowOutputOf`, `WorkflowRunStatus` and `isTerminal` (`/workflow-api`).

**Exactly one real COLLISION is left** — one word for the two sides of one
wire, neither reference page naming the other:

| Name | `aai-runtime` (root) | `aai-ui` (root) |
| --- | --- | --- |
| `SessionCore` | `session-core-types.ts` — the SERVER session, bridging a `Transport` to the client protocol | `session-core-types.ts` — the BROWSER session (socket + audio + state) |

It carried four rows; what the `/internal` split resolved, and why renaming the
runtime halves is now recommended, is in `packages/aai-runtime/CLAUDE.md`.

The near-miss an AUTHOR meets is three workflow-client factories, none of them a
collision; `packages/aai-ui/CLAUDE.md` tells them apart.

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
keeps the seventh spelling out),
`jitteredBackoff(attempt, { baseMs, maxMs? })` (how long before the next
retry — rule 31 keeps the fourth copy out; the JITTER is the half a copy gets
wrong), `sessionSlot()` (a typed named slot that owns
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
`catalog:` block, and packages reference them as `"zod": "catalog:"`. Thirty-two
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

### A manifest has a SHAPE, and two more checks read it

Two tools that read `package.json` were installed and invoked by nothing. Both
are turbo tasks beside `check:syncpack` now, and both were RED on first run —
which is the argument for the pair.

- **`pnpm check:format`** (`syncpack format --check`) — key order, and the
  order of the conditions inside `exports`. All eleven manifests failed.

  **`sortExports` in `.syncpackrc.json` is load-bearing.** Under syncpack's
  default list `@dev/source` is unknown, so it sorts LAST and `import` lands
  ahead of it — and condition resolution takes the FIRST match, so every
  dev-source path would quietly resolve to `dist/` and the condition this
  workspace is built on would stop working, with a green formatter. The config
  names it first. Verified before adopting: every manifest is DEEP-EQUAL across
  the reformat, so it reorders and changes no value.
- **`pnpm check:dedupe`** (`pnpm dedupe --check`) — duplicate versions resolved
  side by side. Found rolldown 1.2.0 beside 1.2.4, two `@types/node`, two
  `@oxc-project/types` and sixteen duplicate `@rolldown/binding-*`; deduping
  cut 195 lockfile lines. Those are bytes in the harness bundle
  `artifact-size-report.mjs` budgets. **Full mode only** — it RESOLVES, so it
  wants a registry, and a pre-commit gate that fails on a flaky network is one
  developers learn to skip. Named in `NOT_RUN_BY_LOCAL`.

`check:sherif` passes `--fail-on-warnings` now: clean when added, which is when
a ratchet is cheapest to set.

### What a PUBLISHED manifest owes, beyond packaging

`publint` and `attw` ask whether a package RESOLVES;
`publishable-package-layout` asks which FILES it has, and konsistent's
predicates cannot read a JSON field at all. `check-publish-names.mjs` holds
what falls between — it already walks these manifests and already argues this
failure class (its header, on `repository` and the E422 only a push to main
could see).

- **`license`, plus a `LICENSE` in the package's own directory.** All four
  published packages had neither. The repo is MIT at the root, but **npm packs
  only the LICENSE in the package dir**, never an ancestor's — so four tarballs
  declared no terms, which registries and license scanners read as
  all-rights-reserved, and `npm publish` only WARNS. The field is checked by
  consensus among the four; the file, by existence.
- **`sideEffects` is a CLAIM** — the only field here whose wrong value breaks a
  consumer rather than our publish. `aai-ui` exports `./styles.css` and all
  fifteen templates `import "@alexkroman1/aai-ui/styles.css"`, an import for
  effect that `sideEffects: false` licenses a bundler to drop, unstyling every
  scaffolded app silently. So a package exporting CSS may not claim `false`; it
  names the css. `aai` and `aai-runtime` are `false` on evidence (no
  `registerProcessor`, no `customElements.define`, no top-level global
  mutation, no side-effect-only import of either anywhere); `aai-cli` is
  absent, being an executable rather than a library a consumer shakes.

All four assertions were A/B'd against a broken manifest before landing — a
check that has never failed is indistinguishable from one that cannot.

### A new version is quarantined for 24 hours

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`. This is the half of
supply-chain defence that `onlyBuiltDependencies` cannot cover: a hijacked
release does not need an install script when the package is imported by our own
code at build or test time. Nearly every npm account compromise is caught and
yanked within hours, so the window is most of the exposure, and nothing here
needs a version the day it ships.

It applies to RESOLUTION, so it only bites when the lockfile is being changed —
`pnpm install --frozen-lockfile` (CI, every check job) is unaffected. A
deliberate same-day bump adds a `minimumReleaseAgeExclude` entry WITH a reason,
rather than lowering the number.

**The root `minimumReleaseAgeExclude` holds exactly one entry, `@biomejs/*`**,
argued at the setting; an exemption for our own packages would be dead config,
since this workspace resolves `@alexkroman1/*` through `workspace:*`. Two
mechanics generalize: the pattern must be the SCOPE, because a CLI's platform
binary is an optionalDependency published in the same batch and exempting only
the wrapper fails resolution on a package nothing here declares; and an entry is
meant to be DELETED once its version clears the window.

The place that also needs one is `scaffold/pnpm-workspace.yaml` — see
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
tag. Pins are refreshed BY HAND now: Dependabot did that, and never opened a
mergeable PR here, so it was removed.

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

### The published surface is described by three committed artifacts

Three generated, committed descriptions of what the four publishable packages
expose, each with its own gate, and **all three are documented together in
[`docs/CLAUDE.md`](docs/CLAUDE.md)** — they answer three different questions
about one surface and used to be argued in three places:

| Artifact | Gate | Question it answers |
| --- | --- | --- |
| `packages/*/etc/*.api.md`, `API.md`, `API-EXPORTS.json` | `pnpm check:api-report` | did a SIGNATURE move, and is a name in or out |
| `contracts/epochs/<capability>/v<N>.json` + `contracts/compatibility/**` | `pnpm check:api-contracts` | is that move BREAKING, and for whom |
| `docs/api/**`, `docs/dist/**` | `pnpm check:docs-md`, the turbo `docs` task | what does it MEAN (the doc comments) |

Four things a change to a published package owes, without reading further:

- **Regenerate rather than hand-edit** — `pnpm api-report`, `pnpm docs:md`. All
  three trees are derived, and all three gates fail on a stale one.
- **A capability whose shape moved has to be CLASSIFIED before it can land**:
  `node scripts/api-contracts.mjs --bump <pkg>:<capability> --retain` (epoch N
  still compiles) or `--drop "<reason>"`. Run `pnpm typecheck` FIRST — the
  frozen examples it reddens are the older epochs to drop. Names are qualified
  per package (`aai-ui:workflow`), and ambiguity is REFUSED, never resolved by
  precedence.
- **A new subpath export defaults INTO all three** — each is a deny-list, so it
  fails until somebody writes down why it should be out.
- **A `--bump` is the moment to ask what should come OUT.** Read
  `template-api-allowlist.json` at one: it records the exports no shipped
  example exercises, and a bump only ever asks about the names that MOVED.

A new CONTRACT package (a package that grows a `contracts/` directory) owes
three more: the `tsconfig.build.json` exclusion, the `vitest.config.ts`
coverage exclusion, and knip `entry` points — plus `packages/*/contracts/**`
staying in the `aai-templates` turbo `inputs`, which is what stops the
gate-under-the-gate being served from cache exactly when a contract tree
changes.

**This section used to be two, "Published type signatures are a committed
report" and "The authoring surface is versioned in epochs"** — the titles three
package guides still cite as living in the root. Both are now in
[`docs/CLAUDE.md`](docs/CLAUDE.md) under those same headings, with the
`@internal`-surface ratchet, the six load-bearing properties of an epoch, why
capabilities rather than entry points, and the two mechanical notes.

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

The four publishable packages — `aai`, `aai-ui`, `aai-cli` and `aai-runtime` —
are one **fixed release group** (configured in `.changeset/config.json`). A
changeset for any one of them bumps all four to the same version. Keep this in
mind when creating changesets — you only need to list one package.

**The PRIVATE packages are versioned too, and a changeset may name them.**
`.changeset/config.json` sets `privatePackages: { version: true, tag: false }`,
and `guard-invariants` rule 20 only rejects naming a private package when that
flag is OFF. So "it is private, therefore it owes an empty changeset" is wrong
— and it was believed for a whole session's worth of `aai-server` work, which
matters because of what that version gates.

**Nothing in `ship.yml` ships on a merge to `main` — only on a RELEASE**, i.e.
the merged Version Packages PR, detected as a commit that moved a version line
in a workspace `package.json`. Job 1 (`changed`) is that gate and every other
job sits behind it, so an ordinary merge updates the PR that will ship it and
stops. Half of it was true by accident already — `changeset pack` packs nothing
when every version is on the registry — but the guest image ran on every push
and pushed a tag to a PUBLIC registry no deploy would ever pin. A release also
arms `migrate` on its own, since `supabase db push` applies what is PENDING and
a schema change merged earlier sits in an earlier commit. `workflow_dispatch`
(with `ref`) ships or rolls back a commit that is not a release; that file's
job-1 comment carries the rest.

**Within a release, the deploy fires on a server VERSION bump, and NOT on a
server source change.** A source-diff arm over `packages/aai-server/**` /
`packages/aai-studio-server/**` was added (#1343) and is reverted: it made a
production rollout the consequence of a MERGE rather than of a RELEASE, so
every server PR deployed on its own, several times a day — a rolling Modal
rollout plus a migration job each, with no release to name in an incident.
The symptom it was written for is real (#1341 rewrote most of the platform,
moved no version line, and reached production only because a Version Packages
commit happened to land behind it) and the remedy is a CHANGESET: both server
packages are `private`, `privatePackages: { version: true }` means a changeset
may name them and the version really moves, so a server-only change ships the
way everything else does. That is the same model `guard-invariants` rule 20's
`SHIPS_VIA` table is built on, which is why an `aai-studio-client` or
`aai-guest` change must already name a carrier — a server-source diff would
not have covered either. To ship a merged server change without waiting for a
release, dispatch `ship.yml` with `deploy: true`.

Any branch arming `deploy` must arm `migrate` with it, since the deploy job
waits on migrate with a plain condition; `ship-workflow-gate.test.ts` pins that,
that the reverted arm stays reverted, and that the release gate above is a
version line rather than a branch name or a commit subject.

**The half a version gate needs is `check:deploy-changeset`** (see "Quality
ratchets"), because `changeset status` accepts an EMPTY changeset: without it a
branch can change platform source, satisfy every gate, merge, and ship nothing
— which is #1341 reachable again by the front door.

**And every `ship.yml` checkout resolves `github.sha`, never `github.ref`** —
that gate pins this too. A ~20-minute release workflow whose jobs each fetch the
BRANCH TIP ships whatever landed while it ran, and one run published a guest
image from one commit while deploying a server built from another. That file's
header carries the account; the rule is the gate's.

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
- **A listener LEAK fails the run**, via `scripts/fail-on-process-warning.mjs`,
  a `setupFiles` entry every project loads through `sharedSetupFiles`
  (`vitest.shared.ts`). Its doc and `packages/aai-templates/CLAUDE.md` say why.
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

  **And `restoreMocks` covers SPIES, not a `vi.fn()` born in a `vi.mock`
  factory or `vi.hoisted` — those need an explicit
  `beforeEach(() => vi.clearAllMocks())`.** `restoreAllMocks` restores what
  `vi.spyOn` replaced; a bare `vi.fn()` was never a spy, so nothing resets it
  and its call history is CUMULATIVE for the whole file. That turns every
  "was not called" assertion into an assertion about test ORDER, which passes
  in isolation and passes in the suite until somebody reorders it. Measured on
  `service-boot.test.ts`, whose mocks are all factory `vi.fn()`s: without the
  `clearAllMocks`, **7 of its 14 tests fail**. So the no-hand-rolled-teardown
  rule above is specifically about `vi.spyOn` and `vi.stubEnv`; a module-mock
  file still owns its own reset, and should say why in a comment, because it
  looks exactly like the dead structure the rule bans.
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
  the check pipeline AND in CI, and **every publishable package — the four
  without a `private` key: `aai`, `aai-ui`, `aai-cli`, `aai-runtime` — must
  define both scripts** — for a long time
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

Five in `aai-runtime` are the exception that proves the rule, and they are
listed here because that package's guide is AT the 120,000-char cap and cannot
take a pointer: `_workflow-journal-log.ts` (every durable write as a log, and a
world rebuilt from a PREFIX of one — never the log with a hole in it),
`_workflow-journal-invariants.ts` (what a log must satisfy, re-derived rather
than re-asked of the store that wrote it), `_workflow-engine-harness.ts` (both
of those as an `onTestFinished` post-condition, so every engine spec is also a
durability spec), `workflow-interleavings/` (shrunk counterexamples frozen as
`fc.schedulerFor` orderings, each naming the guard whose removal it catches) and
`testing/run-workflow.ts` (the author-facing half, published as
`@alexkroman1/aai-runtime/testing`). Each module doc carries its own argument;
the next change to `packages/aai-runtime/CLAUDE.md` has to split it first.

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

There is no Windows leg in CI; one was added, run once, and removed. The whole
account — the two failure causes, one still open, and why not to re-add the
matrix without a Windows machine to reproduce on — is in
`packages/aai-cli/CLAUDE.md`, the package a Windows user actually runs.

#### The e2e suite is pnpm-only in CI

Why the npm and yarn legs were retired, and how to reproduce a user report under
one anyway (`AAI_TEST_PM=npm pnpm test:e2e`), is in
`packages/aai-cli/CLAUDE.md`. The repo-wide half is why that command works:
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
  `judgedDones` at `> 45` against a measured 158-203 — each with its range in a
  trailing comment. Two corollaries: a state whose whole range is small gets
  `> 0`, the floor being there to catch a state NEVER reached rather than to
  pin how often; and a state measured but deliberately left UNFLOORED says so
  in place, with the reason (`studio-concurrency-fuzz`'s unreachable archive
  path, `fuzz-session-core`'s settled tool call, `audio-stress`'s
  `concealments`, which `playback-processor.test.ts` covers deterministically).
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

**Fixed packages:** `@alexkroman1/aai`, `@alexkroman1/aai-ui`,
`@alexkroman1/aai-runtime`, and
`@alexkroman1/aai-cli` release together (configured in
`.changeset/config.json`). You only need to list one; the others are
bumped automatically.

**Checking status:** `pnpm changeset status --since=origin/main`

### API reference docs

The third artifact of the three above: two renderings of the published type
surface, both from TypeDoc over the built `dist/*.d.ts` of `aai` and `aai-ui`
(only those two, deliberately).

- **`pnpm docs:api`** → `docs/dist/**`, HTML, published to GitHub Pages by
  `.github/workflows/docs.yml`. Runs as the turbo `docs` task, a merge gate in
  `pnpm check` and CI, with `treatWarningsAsErrors` — a broken `{@link}` fails
  the build.
- **`pnpm docs:md`** → `docs/api/**`, markdown, **committed**, one file per
  documented entry point, so an agent can `cat` the API reference instead of a
  rendered site. `pnpm check:docs-md` fails when it is stale.

Entry points live in each package's `typedoc.json`; a new subpath export needs
an entry there, and an `@module` tag naming it, or it renders under its
emitted-file path. Unlike the API reports these carry the doc COMMENTS, which
is the whole reason a third artifact exists.

**The rest is in [`docs/CLAUDE.md`](docs/CLAUDE.md)**: the five load-bearing
options in `typedoc.markdown.json`, why the markdown rendering is committed and
floored, the `@module` rule and the latent broken link it surfaced, why
`aai-cli` and `aai-runtime` are deliberately absent, the three sets and where
they disagree, why `docs/` pins its own `typescript@6`, and why knip has to be
told about the second config. `pnpm check:doc-examples` — every ```` ```ts ````
fence in published-package doc comments, READMEs, the scaffold guide and the
studio prompts compiles under the scaffold tsconfig — is documented there too.

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

**The root guide is `AGENTS.md`, and `CLAUDE.md` is one line: `@AGENTS.md`** —
the two-name split and why it exists are in this file's opening paragraph.
Every guide must stay under 120,000 characters (`check:claude-md`, and
`claude-md-limit.test.ts`; see "Quality ratchets"), the scaffold's included —
that one is exempt from the "repo docs" rule, being a product artifact shipped
to users, but not from the cap.

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

- **Biome's promise rules cannot see a `node:` builtin**, and typescript-eslint
  cannot close it — `typescript@7` ships no compiler API. `guard-invariants`
  rule 23 covers the listener half; the measurements are in
  `packages/aai-templates/CLAUDE.md`.
- **Type-level tests**: six `.test-d.ts` files — four in `aai`
  (`sdk/define.test-d.ts`, `sdk/env-types.test-d.ts`, `sdk/dialog.test-d.ts`,
  `sdk/workflow-types.test-d.ts`), one in `aai-ui` (`hooks.test-d.ts` — the four
  generic hooks a custom client is written against) and one in `aai-runtime`
  (`providers/providers.test-d.ts`). Most subpath exports are still uncovered,
  and **the two newest files each have a blind spot a template hit on day 1**:
  each pins only the shape its own fixtures use — see "A `sendFrom` goes BELOW
  `execute`" and "A body that names `WorkflowInputOf` obliges the DEF to carry a
  type" in `packages/aai-templates/CLAUDE.md`. (Their RUNTIME export
  lists are pinned — see `sdk/exports.test.ts` — which is a different
  guarantee.) `hooks.test-d.ts` pins the deliberate
  `any`s (`DefaultToolResult`, `ToolCallInfo.args`) as well as the shapes,
  because tightening one to `unknown` is a breaking change for every untyped
  client and should fail here rather than in a user's build.

### Open testability work

The `aai-server` logger seam once named here is DONE — every line in that
package goes through `logger.ts`, silenced in specs by `captureLogs()` rather
than `spyOn(console, …)` (see "Every line goes through `logger.ts`" in
`packages/aai-server/CLAUDE.md`). What remains is the same job elsewhere:
`aai-studio-server` and `aai-cli` still write to `console.*` in places, and the
SDK publishes a `Logger` either could take.
