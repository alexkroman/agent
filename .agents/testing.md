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
- **Shared options live in `vitest.shared.ts` and must be SPREAD IN**
  (`...sharedConfig.test`): writing `test: { … }` without it replaces
  `restoreMocks`, `unstubEnvs` and the CI `reporters` rather than extending
  them.
- **A listener LEAK fails the run** via `scripts/fail-on-process-warning.mjs`,
  loaded by every project through `sharedSetupFiles`.
- **Snapshots are pinned to CI semantics (`update: "none"`)**, so an obsolete
  snapshot fails locally as it does in CI. Adding or changing one needs
  `vitest -u`.
- **Do not hand-roll teardown for spies or env vars.** `restoreMocks` and
  `unstubEnvs` undo every `vi.spyOn` and `vi.stubEnv` before each test, so a
  trailing `mockRestore()` / `vi.unstubAllEnvs()` or a wrapping `try`/`finally`
  is dead code. Unset a var with `vi.stubEnv(name, undefined)`, never
  `delete process.env.X` or a manual save-and-restore (a restored `undefined`
  becomes the string `"undefined"`). Exception: a helper or fast-check run
  invoked repeatedly within ONE test needs its own restore.
- **A `vi.fn()` from a `vi.mock` factory or `vi.hoisted` is not a spy** —
  `restoreMocks` never resets it, so its call history accumulates across the
  file and "was not called" assertions depend on test order. Such a file needs
  `beforeEach(() => vi.clearAllMocks())`, with a comment saying why.
- **Prefer the tool's bookkeeping to a local variable**: `Promise.withResolvers()`
  over `let resolve!` or a local `deferred()`; `vi.fn()` over a `settled` flag;
  `test.each` over a `for` loop of cases (a loop is fine when cases share
  expensive setup or label themselves via `expect.soft(value, label)`).
- **The slow tiers share ONE config, `vitest.slow.config.ts`**, selected by
  `VITEST_PROFILE` (`integration` 30s / `scenario` 120s / `e2e` 300s) with
  `VITEST_INCLUDE` choosing files. `integration` is the default when unset, so a
  scenario script must set the profile explicitly.
- **Integration- and scenario-tier membership is a NAMING CONVENTION:
  `*.integration.test.ts` and `*.scenario.test.ts`.** Unit configs exclude both;
  `test:integration` / `test:scenario` select one each. Only the INFIX decides,
  so these are deliberately unit tests despite the name: `aai-cli`'s
  `integration.test.ts` / `integration-edge-cases.test.ts`, and `aai-server`'s
  `agent-server-integration.test.ts` — which boots a real harness and is the
  only coverage of `subprocess-sandbox.ts` / `warm-harness.ts` /
  `sandbox/vm.ts`; promote it only after restoring that coverage elsewhere, never
  by lowering aai-server's floor. A package with no files in a tier declares no
  script for it (vitest fails a run matching nothing).
- **Yielding**: `flush()` from `_test-utils.ts` for microtasks, `tick()` for a
  macrotask, never `await new Promise(r => setTimeout(r, 0))` or a local
  `flush`. `sleep(ms)` is a published SDK export, not a test helper. Poll with
  `vi.waitFor()`, never a fixed delay.
- **A spec that observes a TIMER runs on virtual time**, never the wall clock —
  see "Specs that observe a timer" in `packages/aai/CLAUDE.md`.
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
  `.agents/ratchets.md`); CI runs it for every package in the test matrix.

## Two manual diagnostics, and a knip glob that could not see a dead script

- **`knip.json`'s root `entry` names only what a pipeline invokes**, never a
  `scripts/**` glob — an entry point is reachable by definition, so a glob hides
  dead scripts. A script that is a module is reached through its importer; one
  a `package.json` script or vitest `globalSetup` names is discovered by knip
  and must not be repeated.
- **`check:gateway-models` is wired into no pipeline, deliberately**: it spends
  real tokens and depends on a third-party service. It shells out to
  `gen-gateway-models.mjs` by path, which is why that is `knip.json`'s one named
  `entry`.

## Mutation score is a manual DIAGNOSTIC, not a tier and not a gate

`pnpm test:mutate:sdk` mutates the schema core; read the score from
`reports/mutation/sdk/index.html`. It carries no threshold, because one nothing
enforces reads as a gate. It cannot become a gate: `inPlace: true` (forced by TS
7) mutates the real tree — read `stryker.base.config.mjs` for the `bin.mjs` mode
hazard before committing after a run. `check:test-assertions` is complementary:
it catches a test with NO assertion; mutation catches one that does not
discriminate.

## Package-specific suites

| Suite | Guide |
| --- | --- |
| Pipeline-transport interleaving fuzz, fixture replay (`host/fixtures/`) | `packages/aai/CLAUDE.md` |
| Template mount correlation (`template-page-mount.test.ts`) | `packages/aai-templates/STEP-IO-CLAUDE.md` |
| Browser session / audio fuzz harnesses (`fuzz-*.test.ts`, worklet stress) | `packages/aai-ui/src/CLAUDE.md` |
| Studio starter evals (what they measure), studio concurrency fuzz | `packages/aai-studio-server/CLAUDE.md` |
| The eval runner, its assertion vocabulary, and both eval targets | `packages/aai-evals/CLAUDE.md` |
| Sandbox/SSRF boundary tests, and why there is no load or chaos tier | `packages/aai-server/CLAUDE.md` |
| Workflow durability harnesses (`workflow/journal/_log.ts`, `_invariants.ts`, `workflow/_engine-harness.ts`, `workflow-interleavings/`, `testing/run-workflow.ts`) | each module's doc comment in `packages/aai-runtime/src/` |

## A provider's HTTP path is tested against `@copilotkit/aimock`

The keyless LLM fakes (`_fake-llm.ts`, `AAI_EVAL_STUB`, `scriptedTextModel`)
replace the `LanguageModel`, so the `@ai-sdk/*` client, serialization, SSE
parsing and `repairOpenAiStream` never run under them.
`aai-runtime/src/llm-provider-http.scenario.test.ts` points a real text agent at
an aimock server via `llm({ baseUrl })` and asserts what went over the wire.

- Use it when a change touches a provider factory, a fetch wrapper or stream
  parsing; keep scripted models for everything above the `LanguageModel` seam.
- Its journal REDACTS credentials — assert a header is present, not its value.
- Fixtures match in REGISTRATION order: register a tool-result fixture before
  the tool-call one, or the follow-up request loops.

## Vitest config differences per package

| Package | Pool | Environment | Special setup | Notes |
| --- | --- | --- | --- | --- |
| aai | threads (default) | node | — | Excludes pentest, sandbox, integration tests |
| aai-ui | threads | **node**, jsdom per file | `_jsdom-setup.ts` (stubs `scrollIntoView`) | `globals: true`. No config `environment`; a file opts into jsdom with `// @vitest-environment jsdom` |
| aai-cli | threads | node | — | — |
| aai-server | **forks** | node | — | Forks for process isolation; excludes integration tests |
| aai-studio-client | threads | **node**, jsdom per file | — | jsdom by per-file pragma on line 1. `testTimeout: 20_000` so the source's 10s async ceiling is reachable |
| aai-templates | threads | node | — | Also matches `templates.test.ts` + `template-api-coverage.test.ts` |

## Test environment variables

Set in package.json scripts, so not always visible from test code:

- `VITEST_PROFILE` — timeout profile in `vitest.slow.config.ts`: `integration`
  (30s), `scenario` (120s), `e2e` (300s). No profile sets a `retry`.
- `VITEST_INCLUDE` — filters which test files to include.
- `VITEST_POOL` — overrides the pool strategy at runtime.
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
  (`fc.statistics` only prints).
  **Set each floor under the OBSERVED MINIMUM across many runs, and record the
  range and run count in a comment** — never a fraction of the mean, since these
  distributions have long left tails. A state whose whole range is small gets
  `> 0`; a state deliberately left unfloored says so in place, with the reason.
  `scripts/check-property-floors.mjs` requires each floor and its recorded
  actual.
- **A generator must not break its own contract** — a failure caused by an
  illegal generated value looks like a finding and is not. Map every generated
  value to a legal one (append rather than filter) so shrinking stays well
  behaved.
