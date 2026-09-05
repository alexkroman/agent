<!-- Moved out of AGENTS.md so it is read ON DEMAND rather than loaded into
every task's context. AGENTS.md's "Detailed references" table points here. -->

# Testing

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
  `flush()` is MICROTASK-only. For a full macrotask yield use `tick()`, from
  the same module; for real elapsed time `sleep(ms)` is a published SDK export
  (see the `concurrency-primitives` convention), not a test helper. Several
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
  `.agents/ratchets.md`). CI runs it for every package in the test
  matrix, so a PR that drops coverage below a package's floor fails.

## Two manual diagnostics, and a knip glob that could not see a dead script

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

## Mutation score is a manual DIAGNOSTIC, not a tier and not a gate

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

## Package-specific suites

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

## Vitest config differences per package

| Package | Pool | Environment | Special setup | Notes |
| --- | --- | --- | --- | --- |
| aai | threads (default) | node | — | Excludes pentest, sandbox, integration tests; `restoreMocks: true` |
| aai-ui | threads | **node**, jsdom per file | `_jsdom-setup.ts` (stubs `scrollIntoView`) | `globals: true` so `describe`/`test`/`expect` don't need imports. 22 of 42 files opt into jsdom with a `// @vitest-environment jsdom` pragma; the config declares NO `environment`, so the other 20 run in node |
| aai-cli | threads | node | — | `restoreMocks: true` |
| aai-server | **forks** | node | — | Forks for process isolation; excludes integration tests |
| aai-studio-client | threads | **node**, jsdom per file | — | 18 of 26 files carry `// @vitest-environment jsdom` on line 1 — effects, clicks, timers, `beforeunload`, clipboard and fake-timer poll loops are all genuinely exercised. `testTimeout: 20_000`, because the 5s default made a 10s async ceiling in the source unreachable by any test |
| aai-templates | threads | node | — | Also matches `templates.test.ts` + `template-api-coverage.test.ts` |

## Test environment variables

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

## Windows is NOT tested, and is currently broken

There is no Windows leg in CI; one was added, run once, and removed. The whole
account — the two failure causes, one still open, and why not to re-add the
matrix without a Windows machine to reproduce on — is in
`packages/aai-cli/CLAUDE.md`, the package a Windows user actually runs.

## The e2e suite is pnpm-only in CI

Why the npm and yarn legs were retired, and how to reproduce a user report under
one anyway (`AAI_TEST_PM=npm pnpm test:e2e`), is in
`packages/aai-cli/CLAUDE.md`. The repo-wide half is why that command works:
`AAI_TEST_PM` sits in the `check:e2e` task's **`env`**, because strict env mode
strips an undeclared variable silently (see "strict env mode" in `.agents/ci.md`).

## Property tests run on fast-check

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
