---
summary: >-
  Vitest conventions, harness declaration, snapshots, teardown, virtual time,
  coverage, the per-package configs, test env vars, and the property-test
  rules. The TIER table stays in AGENTS.md — it is needed on every task; this
  is the detail behind it.
read_when: >-
  writing or moving a test, or a test times out, leaks, or skips
---

# Testing

- **Vitest**. Test files co-located: `foo.ts` → `foo.test.ts`.
- **A harness a turbo task needs must be DECLARED (`^build`, or
  `aai-guest#build`), never built at test time.**
  `scripts/ensure-guest-harness.mjs` (aai-server's vitest `globalSetup`,
  aai-studio-server's `predev`, aai-server's `predeploy:modal`) builds
  `aai-guest/dist/harness.mjs` when missing or stale, but inside a turbo task
  (`TURBO_HASH`) it only verifies and throws naming the `dependsOn` to add. See
  "Building the harness for a test run" in `packages/aai-guest/CLAUDE.md`.
- **`predev` also rebuilds the studio front-end, unconditionally** — see
  "Serving a current studio client in dev" in
  `packages/aai-studio-server/CLAUDE.md`.
- **Each suite is defined once, in its package's `vitest.config.ts`.** The root
  `vitest.config.ts` discovers them (`projects: ["packages/*"]`) and adds only
  the typecheck-only projects. Run one with `--project <name>` (the name is set
  in the package config). Never re-declare a suite at the root — copies drift.
- **Every package config is `export default defineUnitProject({ … })`**
  (`vitest.shared.ts`). The factory owns the shared options (`restoreMocks`,
  `clearMocks`, `unstubEnvs`, `unstubGlobals`, `TZ=UTC`, the CI `reporters`, the
  worker budget), the unit-tier excludes, and the MERGES a hand-written
  `test: { … }` gets wrong: `setupFiles` is appended to `sharedSetupFiles`,
  `env` merged over the shared one, `coverageExclude` appended to
  `sharedCoverageExclude`. Anything else (`pool`, `testTimeout`, `globalSetup`)
  goes in its `test` option. konsistent `package-vitest-config` and
  `aai-gates/src/vitest-setup-wiring.test.ts` enforce it.
- **A listener LEAK fails the run** via `scripts/fail-on-process-warning.mjs`,
  loaded by every project through `sharedSetupFiles`.
- **Snapshots are pinned to CI semantics (`update: "none"`)**, so an obsolete
  snapshot fails locally as it does in CI. Adding or changing one needs
  `vitest -u`.
- **Do not hand-roll teardown for spies, mocks, env vars or globals.**
  `restoreMocks`, `clearMocks`, `unstubEnvs` and `unstubGlobals` restore every
  `vi.spyOn`, clear every `vi.fn()`'s calls, and undo every `vi.stubEnv` and
  `vi.stubGlobal` before each test, so a trailing `mockRestore()` /
  `vi.unstubAllEnvs()` / `vi.unstubAllGlobals()`, a
  `beforeEach(vi.clearAllMocks)` or a wrapping `try`/`finally` is dead code.
  Stub a global with `vi.stubGlobal`, never a hand-rolled save-and-assign; and
  stub per test (`beforeEach` or the body), because one made in `beforeAll` or
  at module scope is undone before the first test. Unset a var with
  `vi.stubEnv(name, undefined)`, never `delete process.env.X` or a manual
  save-and-restore (a restored `undefined` becomes the string `"undefined"`).
  Exception: a helper or fast-check run invoked repeatedly within ONE test needs
  its own restore.
- **A `vi.fn()` from a `vi.mock` factory or `vi.hoisted` is not a spy** —
  `restoreMocks` never resets it; `clearMocks` clears its call history, but an
  implementation set with `mockImplementation`/`mockReturnValue` survives into
  the next test. A file that sets one per test needs
  `beforeEach(() => fn.mockReset())`, with a comment saying why.
- **Prefer the tool's bookkeeping to a local variable**:
  `Promise.withResolvers()` over `let resolve!` or a local `deferred()`;
  `vi.fn()` over a `settled` flag; `test.each` over a `for` loop of cases (a
  loop is fine when cases share expensive setup or label themselves via
  `expect.soft(value, label)`).
- **The slow tiers share ONE config, `vitest.slow.config.ts`**, with one vitest
  PROJECT per tier (`integration` 30s / `scenario` 120s / `e2e` 300s / `eval`
  1800s). Every package script selects its tier with `--project <tier>`
  (`vitest run -c ../../vitest.slow.config.ts --project scenario`); the
  project's `include` is the naming convention, `src/**/*.<tier>.test.ts`
  (templates: `templates/*/*.eval.test.ts`; aai-cli's e2e: `src/e2e*.test.ts`).
  A run with no `--project` runs every tier, each under its own timeout; a
  positional filter narrows one (`--project integration src/foo`). `e2e` and
  `eval` run one file at a time (a shared build and registry; one gateway key).
  `vitest-setup-wiring.test.ts` fails a slow-tier script with no `--project`.
- **Tier membership is a NAMING CONVENTION: `*.integration.test.ts`,
  `*.scenario.test.ts`, `*.eval.test.ts`, and aai-cli's `e2e*.test.ts`.**
  `defineUnitProject` excludes all four from every unit config;
  `test:integration` / `test:scenario` / `test:eval` / `test:e2e` select one
  each. Only the INFIX decides, so these are deliberately unit tests despite the
  name: `aai-cli`'s `integration.test.ts` / `integration-edge-cases.test.ts`,
  and `aai-server`'s `agent-server-integration.test.ts` — which boots a real
  harness and is the only coverage of `subprocess-sandbox.ts` /
  `warm-harness.ts` / `sandbox/vm.ts`; promote it only after restoring that
  coverage elsewhere, never by lowering aai-server's floor. A package with no
  files in a tier declares no script for it (vitest fails a run matching
  nothing).
- **Yielding**: `flush()` for microtasks, `tick()` for a macrotask (from
  `aai-runtime/src/_timing-test-utils.ts`, or `aai/src/host/_test-utils.ts` in
  the SDK), never `await new Promise(r => setTimeout(r, 0))` or a local `flush`.
  `sleep(ms)` is a published SDK export, not a test helper. Poll with
  `vi.waitFor()`, never a fixed delay.
- **Helpers are split BY DOMAIN** into `_<domain>-test-utils.ts` modules
  (aai-runtime: timing, agent, session, s2s-fixture, logger, fetch, db;
  aai-server: orchestrator, request, sandbox, sql, logger, modal; aai-cli:
  mock-api, vitest-runner, dev-server). Import the one whose name says what it
  fakes; the rosters are konsistent's `test-helper-modules`.
- **Per-test resources are `test.extend` fixtures**, cleaned up after `use` (or
  by `onCleanup`), not `withX(fn)` callbacks or `beforeEach`/`afterEach` pairs
  over module-level `let`s. aai-cli's `test` (`_test-utils.ts`) carries
  `tmpDir`; a fixture's first parameter must be a destructuring pattern, and
  Biome rejects `{}`, so one that needs no other fixture takes
  `{ task: _task }`.
- **A spec that observes a TIMER runs on virtual time**, never the wall clock:
  `useVirtualTime()`
  (`aai-runtime/src/transports/_pipeline-transport-harness.ts`) installs fake
  timers per file; drive with `vi.advanceTimersByTimeAsync(ms)`. Under virtual
  time `tick()` hangs (advance by 0 instead) and `vi.waitFor` still polls in
  real time.
- **Type-level tests** are `.test-d.ts` files using `expectTypeOf`, never
  executed. The `aai-types` / `aai-ui-types` / `aai-runtime-types` projects run
  each under its package tsconfig (aai-ui needs `lib: DOM`, `jsx`).
  - **What GATES them is `turbo run typecheck`**, since every package tsconfig
    includes test files; the vitest projects are a local shortcut. Check the
    tsconfig include when adding a package's first one.
  - The first `.test-d.ts` in a package needs `"**/*.test-d.ts"` in that
    package's `knip.json` entries, or knip reports it unused.
  - **`toMatchObjectType` silently degrades on a type with an optional
    OBJECT-typed property or an intersection** (vitest's deep brand becomes
    `never`, so it blames an unrelated field or pins nothing). Use `toExtend`
    plus a narrow companion assertion for the part that could regress, and
    declare a matched type FLAT rather than `Base & { … }` (see
    `sdk/tool-messages.ts`).
- **Package validation**: `publint` and `attw` run post-build in `pnpm check`
  and CI, and every publishable package (`aai`, `aai-ui`, `aai-cli`,
  `aai-runtime`) must define both scripts.
- **Do not add `--noCheck` to the declaration emit.** `tsconfig.build.json`
  (tests excluded, `rootDir`, `rewriteRelativeImportExtensions`) is the only
  check that rejects a cross-package relative import (`TS6059`), and `--noCheck`
  suppresses it. `isolatedDeclarations` is unusable here (inferred Zod schema
  types).
- **Coverage**: `pnpm test:coverage` enforces each package's floor (see
  `.agents/ratchets.md`); CI runs it for every package in the test matrix. The
  per-file floor (`pnpm check:coverage-per-file`) reads that output; after ONE
  package's coverage run, `pnpm coverage-per-file:update --package <name>`
  merges that package's gains into the baseline and leaves the rest untouched.

## Two manual diagnostics, and a knip glob that could not see a dead script

- **`knip.json`'s root `entry` names only what a pipeline invokes**, never a
  `scripts/**` glob — an entry point is reachable by definition, so a glob hides
  dead scripts. A script that is a module is reached through its importer; one a
  `package.json` script or vitest `globalSetup` names is discovered by knip and
  must not be repeated.
- **`audit:gateway-models` is wired into no pipeline, deliberately**: it spends
  real tokens and depends on a third-party service. `pnpm gen:gateway-models`
  regenerates the catalog it compares against.

## Test order is SHUFFLED, every run

`vitest.shared.ts` sets `sequence: { shuffle: true }`, so every tier runs files
and the tests within them in a fresh random order: a test that passes only after
a sibling left a key, a connection or a stale session behind fails instead.

- **Reproduce with the printed seed**: the run logs
  `Running tests with seed "N"`;
  `pnpm --filter <pkg> exec vitest run <file> --sequence.seed=N` replays that
  order.
- **A suite whose order IS the contract opts out in writing**:
  `describe(name, { shuffle: false }, …)` with a comment naming why — the
  coverage-floor test that reads what the properties above it recorded is the
  case (`typed-json-property.test.ts`). Never opt out to quiet a failure.
- **Concurrency is NOT on** (`sequence.concurrent`): the shared
  `restoreMocks`/`clearMocks`/`unstubEnvs`/`unstubGlobals` run before EVERY
  test, so a sibling starting mid-`await` clears a running test's mocks, and
  fake timers and the jsdom document are per worker. A probe run failed ~1,900
  tests in 460 files, most of them correct.

## Async-leak detection is an opt-in DIAGNOSTIC

`pnpm test:leaks` runs every package's unit tier with vitest's
`--detect-async-leaks` (the `detectAsyncLeaks` option): a timer, socket or
handle a test file starts and never closes is reported against that file. It is
OFF by default and wired into no pipeline: it slows a run substantially (async
hooks on every resource), so its timeouts are not the tier's. A finding fails
that package's run (`PROMISE leaking in <file>`), and it is a lead to read
rather than a verdict — the first run reported 28 in `aai` alone, nearly all
from `keyed-lock-property.test.ts`. For one package,
`pnpm --filter <pkg> exec vitest run --detect-async-leaks` — a `--filter` given
to `pnpm test:leaks` lands after its `--` and reaches vitest, not turbo. The
listener-leak gate (`fail-on-process-warning.mjs`) stays the always-on check.
`expect.requireAssertions` is deliberately NOT set: the `fc.assert` property
suites assert inside the property, which it cannot see.

## Mutation score is a manual DIAGNOSTIC, not a tier and not a gate

`pnpm test:mutate:sdk` mutates the schema core; read the score from
`reports/mutation/sdk/index.html`. It carries no threshold, because one nothing
enforces reads as a gate. It cannot become a gate: `inPlace: true` (forced by
TS 7) mutates the real tree — read `stryker.base.config.mjs` for the `bin.mjs`
mode hazard before committing after a run. `check:test-assertions` is
complementary: it catches a test with NO assertion; mutation catches one that
does not discriminate.

## Package-specific suites

| Suite                                                                                                                                                             | Guide                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Pipeline-transport interleaving fuzz, fixture replay (`aai-runtime/src/fixtures/`)                                                                                | `packages/aai/CLAUDE.md`                                 |
| Template mount correlation (`template-page-mount.test.ts`)                                                                                                        | `packages/aai-templates/STEP-IO-CLAUDE.md`               |
| Browser session / audio fuzz harnesses (`fuzz-*.test.ts`, worklet stress)                                                                                         | `packages/aai-ui/src/CLAUDE.md`                          |
| Studio starter evals (what they measure), studio concurrency fuzz                                                                                                 | `packages/aai-studio-server/CLAUDE.md`                   |
| The eval runner, its assertion vocabulary, and both eval targets                                                                                                  | `packages/aai-evals/CLAUDE.md`                           |
| Sandbox/SSRF boundary tests, and why there is no load or chaos tier                                                                                               | `packages/aai-server/CLAUDE.md`                          |
| Workflow durability harnesses (`workflow/journal/_log.ts`, `_invariants.ts`, `workflow/_engine-harness.ts`, `workflow/interleavings/`, `testing/run-workflow.ts`) | each module's doc comment in `packages/aai-runtime/src/` |

## A provider's HTTP path is tested against `@copilotkit/aimock`

The keyless LLM fakes (`_fake-llm.ts`, `AAI_EVAL_STUB`, `scriptedTextModel`)
replace the `LanguageModel`, so the `@ai-sdk/*` client, serialization, SSE
parsing and `repairOpenAiStream` never run under them.
`aai-runtime/src/text-agent/llm-provider-http.scenario.test.ts` points a real
text agent at an aimock server via `llm({ baseUrl })` and asserts what went over
the wire.

- Use it when a change touches a provider factory, a fetch wrapper or stream
  parsing; keep scripted models for everything above the `LanguageModel` seam.
- Its journal REDACTS credentials — assert a header is present, not its value.
- Fixtures match in REGISTRATION order: register a tool-result fixture before
  the tool-call one, or the follow-up request loops.

## Vitest config differences per package

Every row is a `defineUnitProject` call; anything not listed is the shared
default (threads, node, vitest's 5s `testTimeout`, the four tier excludes).

| Package           | Pool      | Timeout | Setup / plugins                                             | Notes                                                                                        |
| ----------------- | --------- | ------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| aai               | threads   | 5s      | —                                                           | `contracts/` out of coverage                                                                 |
| aai-ui            | threads   | 5s      | `_jsdom-setup.ts` (stubs `scrollIntoView`)                  | `globals: true`; node by default, a file opts into jsdom with `// @vitest-environment jsdom` |
| aai-runtime       | **forks** | 5s      | —                                                           | sockets, the workflow world and process-wide dispatchers                                     |
| aai-cli           | threads   | 5s      | `_test-setup.ts` (temp `AAI_CONFIG_DIR`, scrubs `*API_KEY`) | also loaded by its scenario/e2e runs (`PACKAGE_SETUP_FILES`)                                 |
| aai-evals         | threads   | 5s      | —                                                           | `gate.ts` is never loaded by the unit tier                                                   |
| aai-gates         | threads   | 5s      | —                                                           | `include: ["src/*.test.ts"]`                                                                 |
| aai-guest-core    | threads   | 5s      | —                                                           | `src/test-utils.ts` (a subpath export) out of coverage                                       |
| aai-guest-studio  | threads   | 5s      | —                                                           | needs `^build` (reads the SDK, aai-ui and aai-cli `dist`)                                    |
| aai-guest         | threads   | 5s      | —                                                           | needs its own `build` (`dist/harness.mjs`)                                                   |
| aai-server        | **forks** | **20s** | `globalSetup`: `scripts/ensure-guest-harness.mjs`           | process isolation; `agent-server-integration.test.ts` stays unit (sole subprocess coverage)  |
| aai-studio-client | threads   | **20s** | `_test-setup.ts` (10s Testing Library ceiling, unmounts)    | node by default, jsdom by per-file pragma                                                    |
| aai-studio-server | **forks** | **20s** | —                                                           | headroom under a contended `pnpm check`                                                      |
| aai-templates     | threads   | 5s      | `aaiAgentPlugin()` (`virtual:aai/agent`)                    | `include`: `src/*.test.ts` + `templates/*/*.test.ts`; its config loads the SDK's `dist`      |

## Test environment variables

Read by the test configs and helpers, so not always visible from test code:

- `VITEST_POOL` — `forks` forces the forks pool in a slow-tier run. Without it a
  slow tier runs in the package's own unit pool: `forks` for the packages in
  `vitest.slow.config.ts`'s `FORKS_PACKAGES` (the ones whose unit config pins
  it), `threads` otherwise. The unit configs ignore it.
- `AAI_FLOOR_SAMPLES` — set by `pnpm floors:sample` only; records every floor
  assertion (see the property-test rules below).
- `AAI_TEST_PM` — package manager the e2e suite installs the scaffolded project
  with (`pnpm` | `npm` | `yarn`; default `pnpm`). CI runs only `pnpm`.

## Windows is NOT tested, and is currently broken

There is no Windows leg in CI; do not re-add one without a Windows machine to
reproduce on. See "Windows is NOT tested, and is currently broken" in
`packages/aai-cli/CLAUDE.md`.

## The e2e suite is pnpm-only in CI

Reproduce a user report under another manager with
`AAI_TEST_PM=npm pnpm test:e2e`; it works because `AAI_TEST_PM` is in the
`check:e2e` task's `env` (strict env mode, `.agents/ci.md`). See "The e2e suite
is pnpm-only in CI" in `packages/aai-cli/CLAUDE.md`.

## Property tests run on fast-check

Every randomized suite (the `aai-ui/fuzz-*.test.ts` harnesses,
`worklets/audio-stress.test.ts`, `studio-concurrency-fuzz.test.ts`,
`pipeline-fuzz.integration.test.ts`, the properties in `sdk/protocol.test.ts` /
`host/ssrf.test.ts`) uses **fast-check**. Never add a hand-rolled PRNG and seed
loop. Failures shrink to a minimal counterexample, and the `fc.scheduler`
harnesses print a `schedulerFor()` template to paste into a regression test.

- **Generate the whole world, not a seed.** For an unbounded number of decisions
  generate a SHORT list and consume it cyclically, so counterexamples stay
  readable.
- **State-dependent choices stay dynamic**: generate an INTENT and no-op when
  its precondition fails, rather than forcing an impossible transition.
- **Every run must be independently replayable**: tear down per-run state (fake
  timers, audio mocks) in a `finally` and clear process-global state per run, or
  the shrinker converges on the wrong counterexample.
- **Every property suite needs hand-rolled coverage floors**, because an
  all-green property proves nothing about a state the generator never entered
  (`fc.statistics` only prints). **Set each floor under the OBSERVED MINIMUM
  across many runs, and record the range and run count in a comment** — never a
  fraction of the mean, since these distributions have long left tails. A state
  whose whole range is small gets `> 0`; a state deliberately left unfloored
  says so in place, with the reason. `scripts/check-property-floors.mjs`
  requires each floor and its recorded actual. **Measure, don't guess**:
  `pnpm floors:sample --runs 20 <file>...` runs the suite N times (a fresh
  fast-check seed each, unless the property pins one), records every
  `toBeGreaterThan(OrEqual)` on a number, and prints each counter's min–max as a
  ready comment, flagging a floor that is not under the observed minimum.
- **A generator must not break its own contract** — a failure caused by an
  illegal generated value looks like a finding and is not. Map every generated
  value to a legal one (append rather than filter) so shrinking stays well
  behaved.
