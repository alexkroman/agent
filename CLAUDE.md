# CLAUDE.md

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
pnpm check:local         # Fast pre-commit gate (single turbo invocation, max parallelism)
pnpm check:affected      # Only check packages affected by changes since main
```

### Test tiers

| Tier | Command | Scope | Timeout |
| --- | --- | --- | --- |
| Unit | `pnpm test` | Fast, mocked, co-located | 5s |
| Integration | `pnpm test:integration` | Real subsystems (HTTP servers, WebSockets) | 30s |
| E2E | `pnpm test:e2e` | Full process spawn + Playwright browser | 300s |
| Templates | `pnpm test:templates` | Template agent example tests | 5s |

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

`pnpm check:local` uses the same script with `--local` flag, running a
subset: build, typecheck, lint, publint, syncpack, sherif, knip, test —
all in one turbo call with `--continue` (shows all failures at once).

`pnpm check:affected` uses turbo's `--affected` flag to only run tasks
for packages changed since the default branch.

### Quality ratchets

Beyond lint/typecheck/test, `scripts/check.sh` **and the CI check job** run
three **gates** (all also runnable standalone) that hold the line on technical
debt; the first two work by comparing the branch against its merge-base with
`origin/main`. They must stay wired into BOTH: for a long time they lived
only in `check.sh`, which CI never invokes, so the only thing enforcing them
was the pre-push hook — and `git push --no-verify` skipped them entirely.

- **`pnpm check:hatches`** (`scripts/check-escape-hatches.mjs`) — counts
  static-analysis escape hatches (`@ts-expect-error`, `@ts-ignore`,
  `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `as any`) across
  `packages/` and fails on any **net-new** total versus the merge base.
  The baseline only ratchets down — removing a hatch lowers the bar for the
  next branch, and you can't silently add one. Fix the underlying
  type/lint error instead of suppressing it.
- **`pnpm check:file-length`** (`scripts/check-file-length.mjs`) — caps
  source files at 500 lines and test files at 700. Files that already
  exceed the cap are grandfathered in `scripts/file-length-allowlist.json`,
  which records each file's current ceiling; a grandfathered file may not
  grow past its ceiling, and ceilings should only ever be lowered as files
  are split up. New files must come in under the cap. Templates under
  `packages/aai-templates/templates/` are exempt.
- **`pnpm check:claude-md`** (`scripts/check-claude-md.mjs`) — caps every
  `CLAUDE.md` (the scaffold's included) at **120,000 characters**, 20% under
  the ~150k ceiling past which an agent's context silently drops the rest of
  the file. Silently is the problem: nothing warns, the guide is just
  half-absent, which is how the root file reached 233k one well-justified
  paragraph at a time. The fix when it fails is to MOVE a section into the
  owning package's guide and leave a pointer (see "Package guides" and
  "Updating CLAUDE.md"), not to delete rationale — except in the scaffold
  guide, which ships to users and has no packages to push sections into.
  **The same cap is also a TEST**
  (`packages/aai-templates/claude-md-limit.test.ts`), so it fails in the
  ordinary test run and not only in `pnpm check` — an agent editing a guide
  sees it without knowing this gate exists. It asserts both lines separately
  (over budget = refactor before adding more; over 150k = a guide is being
  truncated right now), that the root still links every package guide, and
  that the script and CI wiring still agree with it.

These are pure git/fs checks (no build needed), so they run up front and
fail fast. To tighten quality over time, lower the entries in the
file-length allowlist and delete escape hatches — both baselines are
designed to only move one direction.

A fourth ratchet lives in the vitest configs: **coverage thresholds**.
Every package has floors — `aai-templates` was for a while the one that did
not, so CI measured its coverage and threw the number away. Each package's
`vitest.config.ts` declares per-package coverage floors
(lines/functions/branches/statements) that CI enforces via
`pnpm test:coverage` (the `test` job runs it per package), and the root
`vitest.config.ts` holds combined floors for whole-repo runs. Like the
other ratchets these only move up: when a coverage run shows actuals
comfortably above a floor, raise the floor to ~2-3 points below the
actual. Never lower a floor to make a PR pass — add tests instead.
Coverage measures production source only; test infrastructure
(`_test-utils.ts`, mocks, fixtures, setup files) is excluded via
`sharedCoverageExclude` in `vitest.shared.ts`.

## Architecture

Eight workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: agent config, types, protocol, S2S, session, Db |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (React 19): session, audio, UI components |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, build, list, pull, push, publish, delete, login, secret, storage, templates (`deploy` is hidden/internal — the mechanism in-guest Publish runs) |
| `packages/aai-guest/` | `aai-guest` | Guest sandbox harness (private): the Node entrypoint that runs the complete agent inside each Modal Sandbox, built into one self-contained `dist/harness.mjs` |
| `packages/aai-server/` | `aai-server` | Agent service + shared platform core (private): sandbox, auth, SSRF, stores, locks |
| `packages/aai-studio-server/` | `aai-studio-server` | Studio service (private): browser coding agent, workspace builds, combined entry |
| `packages/aai-studio-client/` | `aai-studio-client` | The studio's browser front-end (private): Vite React app served by aai-server |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |

**Dependency flow:** `aai-cli`, `aai-ui`, `aai-guest`, and `aai-server` all
depend on `@alexkroman1/aai` (via `workspace:*`). `aai-server` depends on
`aai-guest` only to resolve its built artifact (`aai-guest/harness` →
`dist/harness.mjs`, baked into the guest snapshot image) — it never imports
guest source, and the guest never imports server code; that hard boundary is
the reason the guest is its own package. The one edge to the CLI is
`aai-server` → `aai-cli`, and only for its three public build-hook subpaths
(`/worker-bundler`, `/client-bundler`, `/typecheck`): the studio builds
workspaces through the CLI's own Vite pipeline (and typechecks them with the
CLI's own gate) rather than carrying a second bundler. Do not widen it —
nothing else in the server may import from the CLI, and the CLI must never
import from the server.

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
| `packages/aai/CLAUDE.md` | SDK layout (`sdk/` vs `host/`), subpath exports, session modes, STT/LLM/TTS/S2S providers, voices, `ctx.db`, `ctx.generate`, guest network access + SSRF, the canonical agent-config schema, data flow, the defaults/magic-numbers table, self-hosted `createServer` defaults |
| `packages/aai-ui/CLAUDE.md` | Browser session, client audio path (capture/playback worklets, pacing, jitter buffer), components, fuzz harnesses |
| `packages/aai-cli/CLAUDE.md` | Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`), bundling + Vite rules, credential destinations |
| `packages/aai-guest/CLAUDE.md` | The guest harness: one binary / three modes, user-shipped runtime, dev-prod parity, agent guests as servers |
| `packages/aai-server/CLAUDE.md` | Platform: sandboxes + Modal backends, stateless server, split services, security architecture, auth, stores/locks |
| `packages/aai-studio-server/CLAUDE.md` | Browser studio: workspaces, coding agent, previews, Publish, LLM selection, studio evals |
| `packages/aai-studio-client/CLAUDE.md` | Studio front-end: panes, composer queue, CSP, preview probing |
| `packages/aai-templates/CLAUDE.md` | Templates + scaffold packaging. Note `scaffold/CLAUDE.md` is a product artifact, not repo docs |

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
- **`aai-server/test-utils.ts`** — (no underscore) `createMockKv()`,
  `createTestStore()` (in-memory BundleStore)

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

The codebase's recurring async-coordination patterns are reified as small
primitives — reach for them before re-inventing the pattern at a call site:

- **`createEpoch()`** (`aai/sdk/epoch.ts`, exported from
  `@alexkroman1/aai/internal`) —
  staleness guard for async continuations: capture `current()` when deferring
  work, check `isCurrent(gen)` when it settles, `bump()` to invalidate.
  Adopted by the aai-ui connection/turn generations and the pipeline turn
  gate. Don't hand-roll `let generation = 0; generation++` counters.
- **`createOwnedMap()`** (`aai/sdk/owned-map.ts`, exported from
  `@alexkroman1/aai/internal`) — a map whose entries are removed by ownership token:
  `claim(key, value)` returns the only release for that claim, so an async
  teardown settling after the key was re-claimed (reconnect resume, redeploy)
  can't evict the successor's entry. `owns()` guards non-delete mutations.
  Adopted by the runtime's `sessions`/`sinkMap`, the WS handler, and the
  platform `SlotCache`. Don't write `if (map.get(k) === mine) map.delete(k)`
  by hand.
- **`createCoalescingRunner()`** (`aai/sdk/coalescing-runner.ts`, exported
  from `@alexkroman1/aai/internal`) — serialize + coalesce repeatable async
  work: at most one run in flight, triggers during a run share ONE trailing
  re-run started after the current settles, rejections never wedge the
  runner. For work that reads latest state when it runs (workspace sync,
  post-write typechecks). Don't hand-roll `inFlight`/`trailing` flag pumps.
- **`createTurnMachine()`** (`aai/host/transports/pipeline-turn-state.ts`) —
  the pipeline transport's turn lifecycle (in-flight reply, spoke flag, TTS
  audio gate) as a discriminated-union machine whose named transitions are
  the only mutation path. New turn-state reads/writes go through it, not new
  closure flags.
- **Timeouts**: use `p-timeout` (a dependency of aai, aai-cli, aai-guest,
  and aai-server) — never a hand-rolled `Promise.race` with a timer; the
  losing branch's late rejection and timer cleanup are exactly what gets
  re-derived wrong. The guest harness is no exception: tsdown bundles its
  npm dependencies (p-timeout included) into `dist/harness.mjs` — only the
  vite/rolldown build toolchain stays external to the bundle.
- **Combining abort signals**: use native `AbortSignal.any([...])` (sources
  held weakly — no unlink bookkeeping); the pipeline transport combines the
  session signal with each turn's controller this way.

### Fixed release coupling

`aai`, `aai-ui`, and `aai-cli` are in a **fixed release group** (configured
in `.changeset/config.json`). A changeset for any one of them bumps all
three to the same version. Keep this in mind when creating changesets —
you only need to list one package.

### Testing

- **Vitest**. Test files co-located: `foo.ts` → `foo.test.ts`.
- **The aai-server test project auto-builds the guest harness**:
  `scripts/ensure-guest-harness.mjs` runs as vitest `globalSetup` (root and
  per-package configs) and builds `aai-guest` when `dist/harness.mjs` is
  missing or older than the guest package's sources — `createSandbox`
  resolves it eagerly, so an unbuilt harness otherwise fails every sandbox
  test. Staleness tracks aai-guest sources only (not the bundled SDK);
  `GUEST_HARNESS_PATH` skips the check. The same script also runs as
  `predev` in aai-server and aai-studio-server (so `pnpm dev:aai-server`
  always boots with a fresh harness for local-dev sandboxes) and
  as `predeploy:modal` in both server packages (a fail-fast before the
  remote Modal image build, which rebuilds the harness itself). Also
  runnable directly: `node scripts/ensure-guest-harness.mjs`.
- **`predev` also rebuilds the studio front-end**: aai-studio-server's
  `predev` ends with `pnpm --filter aai-studio-client build`, so
  `pnpm dev:aai-server` always serves a current client. `studio-static.ts`
  serves whatever is in that package's `dist/` — nothing checks its age —
  so without this a stale (or absent) bundle is served silently and the
  studio looks unchanged no matter what you edit. Unconditional rather than
  staleness-gated like the harness above: the build is sub-second, which is
  cheaper than the check would be worth.
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
- Slow/integration tests have separate per-package configs
  (`vitest.slow.config.ts`, `vitest.integration.config.ts`) to avoid running
  during `vitest run`.
- In tests, use `flush()` from `_test-utils.ts` instead of
  `await new Promise(r => setTimeout(r, 0))` to yield to microtasks.
- Use `vi.waitFor()` instead of arbitrary delays when polling for async results.
- Type-level tests use `.test-d.ts` files with `typecheck: { only: true }`
  — they are checked by tsc but never executed at runtime. Use
  `expectTypeOf` from vitest to assert on type shapes. Projects:
  `aai-types`.
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

#### Package-specific suites

The harnesses that only make sense next to the code they exercise are
documented in that package's guide, not here:

| Suite | Guide |
| --- | --- |
| Pipeline-transport interleaving fuzz, fixture replay (`host/fixtures/`) | `packages/aai/CLAUDE.md` |
| Browser session / audio fuzz harnesses (`fuzz-*.test.ts`, worklet stress) | `packages/aai-ui/CLAUDE.md` |
| Studio starter evals (`scripts/starter-eval.mjs`), studio concurrency fuzz | `packages/aai-studio-server/CLAUDE.md` |
| Sandbox/SSRF boundary tests, and why there is no load or chaos tier | `packages/aai-server/CLAUDE.md` |

#### Vitest config differences per package

| Package | Pool | Environment | Special setup | Notes |
| --- | --- | --- | --- | --- |
| aai | threads (default) | node | — | Excludes pentest, sandbox, integration tests; `restoreMocks: true` |
| aai-ui | threads | **jsdom** | `_jsdom-setup.ts` (stubs `scrollIntoView`) | `globals: true` so `describe`/`test`/`expect` don't need imports |
| aai-cli | threads | node | — | `restoreMocks: true` |
| aai-server | **forks** | node | — | Forks for process isolation; excludes integration tests |
| aai-studio-client | threads | node | — | `.tsx` tests via `react-dom/server` (no jsdom) |
| aai-templates | threads | node | — | Also matches `templates.test.ts` + `template-api-coverage.test.ts` |

#### Test environment variables

Tests can behave differently based on environment variables set in
package.json scripts (not always obvious from test code alone):

- `VITEST_PROFILE` — switches timeout/retry profiles in
  `vitest.slow.config.ts`: `integration` (30s), `e2e` (300s)
- `VITEST_INCLUDE` — filters which test files to include
- `VITEST_POOL` — can override pool strategy at runtime
- `AAI_TEST_PM` — package manager the e2e suite installs the scaffolded
  project with (`pnpm` | `npm` | `yarn`; default `pnpm`). **CI only runs
  `pnpm`** — see below.

#### The e2e suite is pnpm-only in CI

`aai init` scaffolds a project that the e2e suite then installs from a mock
registry, so the install step can in principle run under any package
manager. CI used to fan that out (`pm: [pnpm, npm, yarn]` × 2 OSes = 6
jobs); it now runs pnpm alone.

The npm/yarn legs were paying for themselves in flakes rather than bugs:
each one is a full cold install of the published tarballs on a shared
runner, they tripped over resolver-specific quirks unrelated to our code
(hence `--no-lockfile`, `--no-strict-peer-dependencies`,
`NPM_CONFIG_MINIMUM_RELEASE_AGE=0`), and the repo itself is pnpm-only, so
the thing they guarded — "our published `exports` maps resolve under a
non-pnpm resolver" — is better served by `publint` + `attw`, which run on
every build and check the package metadata directly.

The `AAI_TEST_PM` switch in `_e2e-test-utils.ts` stays, so an npm or yarn
install is one env var away when reproducing a user report:

```sh
AAI_TEST_PM=npm pnpm test:e2e
```

Treat those two branches as a debugging tool, not covered ground.

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
  counts, while fast-check draws a fresh seed per run. Set them ~3x below
  measured actuals and record the actuals in a comment.
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

- **pre-commit**: runs `biome check --write` on staged files and
  `syncpack lint` when package.json changes.
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

### Updating CLAUDE.md

When you make changes that affect architecture, security model, conventions,
or gotchas, update the guide that OWNS the surface — the package's own
`CLAUDE.md` (see "Package guides" above) for anything package-specific, this
file only for repo-wide rules. Adding to the root instead of the package guide
is how this file grew to 233k characters and had to be split.

**Every `CLAUDE.md` must stay under 120,000 characters** (20% under the 150k
limit). `pnpm check:claude-md` enforces it and runs in `scripts/check.sh` and
the CI check job. `packages/aai-templates/scaffold/CLAUDE.md` is exempt from
the "repo docs" rule — it is a product artifact shipped to users — but not from
the size cap.

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
   `.syncpackrc.json`) — run `node scripts/sync-scaffold-versions.mjs`
   to sync it (or `--check` to verify).
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

## Security architecture

The security model is documented where the boundaries live:

- **Sandbox isolation, credential separation, auth, `run_code`, the platform's
  own threat model** — `packages/aai-server/CLAUDE.md`.
- **What a guest may do, and what the harness contract exposes** —
  `packages/aai-guest/CLAUDE.md`.
- **SSRF (`aai/host/ssrf.ts`), the `sdk/` vs `host/` dependency boundary,
  provider credential resolution** — `packages/aai/CLAUDE.md`.
- **Where the CLI is allowed to send a user's API key** —
  `packages/aai-cli/CLAUDE.md`.

Two rules general enough to state here: **the Modal container is the security
boundary** (no in-process capability stripping is relied on anywhere), and
**every AssemblyAI key on the platform is user-provided** — there is no
platform-owned provider credential, and no credential resolution path may fall
back to the host's `process.env`.

### Known limitations

- **Type-level tests**: Cover public entry points of `aai` (`.`, `./types`)
  and `aai-ui` (`.`). Subpath exports (e.g. `./protocol`) are not covered
  by type tests.
