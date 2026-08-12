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
four **gates** (all also runnable standalone) that hold the line on technical
debt; the first works by comparing the branch against its merge-base with
`origin/main`, while the rest are absolute. They must stay wired into BOTH:
for a long time they lived only in `check.sh`, which CI never invokes, so the
only thing enforcing them was the pre-push hook — and `git push --no-verify`
skipped them entirely.

- **`pnpm check:hatches`** (`scripts/check-escape-hatches.mjs`) — counts
  static-analysis escape hatches (`@ts-expect-error`, `@ts-ignore`,
  `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `as any`,
  `as unknown as`) across `packages/` and fails on any **net-new** total
  versus the merge base. The baseline only ratchets down — removing a hatch
  lowers the bar for the next branch, and you can't silently add one. Fix the
  underlying type/lint error instead of suppressing it. On failure it **names
  the new occurrences** (`file:line` plus the source line) under each pattern
  that grew, so you don't have to re-diff against the merge base by hand to
  find the line you just added. They are paired against the base by file +
  line CONTENT, never by line number — inserting an import above an existing
  hatch shifts every hatch below it, and reporting those as new would bury the
  one line that is.

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

  Two properties of the gate worth knowing before relying on it. It compares
  **grand totals, not per-pattern counts**, so a branch that removes hatches
  buys headroom to add others — deliberate (it lets a refactor swap one for
  another) but it means a large-reduction branch does not police itself; the
  reduction only becomes the floor once it lands and is the next branch's
  merge base. And because the diff is against the merge base, **enabling a new
  pattern on a branch that is many commits ahead charges that branch for every
  occurrence those commits added** (+47 when `as unknown as` was first tried).
  Land a new pattern directly on top of `origin/main`.
- **`pnpm check:file-length`** (`scripts/check-file-length.mjs`) — caps
  source files at 500 lines and test files at 700. Files that already
  exceed the cap are grandfathered in `scripts/file-length-allowlist.json`,
  which records each file's current ceiling; a grandfathered file may not
  grow past its ceiling, and ceilings should only ever be lowered as files
  are split up. New files must come in under the cap. Templates under
  `packages/aai-templates/templates/` are exempt.
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
  rightly checks nothing, which is never true. Two things the gate needs to
  stay trustworthy, both learned by getting them wrong: it masks comments and
  string literals before scanning (a JSDoc paragraph *about* `test()` is not a
  test, and three files here have one), and it excludes
  `RegExp.prototype.test` via a lookbehind — `/re/.test(x)` produced five of
  the first run's eight reported offenders. Its own parser is specced in
  `packages/aai-templates/test-assertion-gate.test.ts`, because a gate whose
  entire success output is a count fails SILENTLY: a parser that stopped
  recognising `test(` would print "all 0 test(s) assert something ✓", which is
  the same shape as the bug it exists to catch.
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

A fifth ratchet lives in the vitest configs: **coverage thresholds**.
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

**The per-package floors are what gates a PR; the root ones are not.**
`pnpm test:coverage` is `turbo run test:coverage`, which fans out to each
package's own config, and CI runs `pnpm --filter ./packages/<pkg>
test:coverage` per matrix entry — so nothing in the repo or in CI ever
evaluates the root `vitest.config.ts` thresholds. The only thing that does is
a direct `pnpm vitest run --coverage` at the root. Keep them anyway: it is the
only floor that sees the repo as one program. Just don't read them as the
gate — they had drifted ~4 points under an actual nobody had measured.

**And the floors are measured locally now, because for a long time they were
not.** `scripts/check.sh` ran `test`, CI's matrix runs `test:coverage`, so the
one gate a PR could not see coming was its own coverage: every suite green
locally, `test (<pkg>)` red in CI. It happened — a new 300-line module in
aai-ui landed at 1.44% line and 0% branch coverage, took the package under all
four of its floors, and cost a whole follow-up commit to fix. Floors do not
move to accommodate a PR, so the earlier that is known the cheaper it is. Both
`check.sh` modes and `check:affected` run `test:coverage` now.

## Architecture

Eight workspace packages under `packages/`:

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
| `packages/aai/CLAUDE.md` | SDK layout (`sdk/` vs `host/`), subpath exports, session modes, STT/LLM/TTS/S2S providers, voices, `ctx.db`, `ctx.generate`, guest network access + SSRF, the canonical agent-config schema, data flow, the defaults/magic-numbers table, self-hosted `createServer` defaults |
| `packages/aai-ui/CLAUDE.md` | Browser session, client audio path (capture/playback worklets, pacing, jitter buffer), components, fuzz harnesses |
| `packages/aai-cli/CLAUDE.md` | Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`), bundling + Vite rules, credential destinations |
| `packages/aai-guest/CLAUDE.md` | The guest harness: one binary / three modes, user-shipped runtime, dev-prod parity, agent guests as servers |
| `packages/aai-server/CLAUDE.md` | Platform: sandboxes + Modal backends, stateless server, the two-package/one-deployment composition, security architecture, auth, stores/locks |
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

- **`aai/sdk/testing.ts`** — the one that is PUBLISHED
  (`@alexkroman1/aai/testing`, so a user's agent project can import it, which is
  why it carries no test-runner dependency): `createToolContext(overrides?)`
  builds a `ToolContext` for testing a tool's `execute`, and `createUnusedDb()`
  is the `db` it defaults to. Defaults are inert — empty `env`/`state`, a `db`
  and `generate` that reject naming themselves, a `signal` that never aborts, a
  `send` that records into `ctx.sent` — and **each call is a distinct session**,
  which is what the two-context isolation tests rest on; pass `sessionId` when
  two contexts must be the SAME session. Pass `send: vi.fn()` when a spec asserts
  call counts (`solo-rpg` does) and the recorder steps aside.

  It replaced the same eight-field stub in four template suites, two of which
  reached for `{ … } as unknown as ToolContext` — the cast that also stops
  reporting when a field is ADDED, which is the failure a shared builder exists
  to prevent. Its own spec asserts the field LIST, since that is the contract.
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
- **`aai-server/test-utils.ts`** — (no underscore) `createTestStore()`
  (in-memory BundleStore), `createTestOrchestrator()`, `authHeaders()` /
  `authFetch()` / `deploy()` / `deployAgent()` / `deployPayload()` /
  `deployBody()`, `makeSlot()`.
  (`createMockKv()` was listed here for a while and has never existed in this
  package — KV was removed.)

  **Build a request with `authFetch`/`deploy`, not a header literal.** The
  `Bearer`+`Content-Type` pair was spelled out at ~47 sites across 8 files;
  they are converted, and the 28 remaining `Bearer` strings in the package are
  all ones where the literal IS the subject — the bearer parser's own spec
  (`_bearer.test.ts`), the `resolveBearer` cases in `middleware.test.ts`, and
  header ASSERTIONS in the blob-storage / supabase-auth / warm-harness suites.
  `deploy(fetch, { key, body })` is the same idea one level up, for the
  `POST /deploy` shape ~40 specs restate; `deployPayload()` is `deployBody()`
  as an object, for callers that re-encode it (the gzip specs). Drop to a bare
  `fetch` only when the REQUEST is what a spec exercises — a missing header, a
  gzipped body, a raw string — and those cases are why `deployBody` stays.

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
- **`createKeyedLock()`** (`aai/sdk/keyed-lock.ts`, exported from
  `@alexkroman1/aai/utils` and the root — the one primitive here that is
  PUBLIC) — serialize async work per key: `lock(key)` resolves with a release
  once every earlier holder of that key has released, and `withLock(lock, key,
  fn)` releases in every outcome. An optional `timeoutMs` bounds the ACQUIRE,
  which is what makes a contended mutation answerable instead of queued
  (`KeyedLockTimeoutError` → the platform's 409). It is public because the
  hazard is an agent author's as much as the platform's: **the LLM loop runs a
  step's tool calls CONCURRENTLY**, so two async mutators of one `ctx.state`
  interleave at every await and each reads what the other half-applied. Two
  templates had hand-rolled the same per-session promise chain before it was
  published. Don't write `tails.get(k) ?? Promise.resolve()` by hand — the two
  parts that get missed are dropping the drained entry BY OWNERSHIP, and
  resolving your own place in the chain when you abandon a timed-out acquire
  (otherwise everyone behind you blocks forever).

  **For the `ctx.state` case specifically, reach for `sessionSlot`'s `update`
  instead** (below). Those same two templates then hand-rolled the LOCK+SLOT
  pair — `createKeyedLock()` beside `withLock(lock, ctx.sessionId, () =>
  mutator(slot.get(ctx)))` — which is now one method. This entry stays because
  the primitive is still the right answer for serialized work that is not a slot
  mutation, and because `timeoutMs` has no `update` equivalent; no template
  demonstrates it any more, which is recorded in `template-api-allowlist.json`
  rather than being an oversight.
- **Timeouts**: use `p-timeout` (a dependency of aai, aai-cli, aai-guest,
  and aai-server) — never a hand-rolled `Promise.race` with a timer; the
  losing branch's late rejection and timer cleanup are exactly what gets
  re-derived wrong. The guest harness is no exception: tsdown bundles its
  npm dependencies (p-timeout included) into `dist/harness.mjs` — only the
  vite/rolldown build toolchain stays external to the bundle.
- **Combining abort signals**: use native `AbortSignal.any([...])` (sources
  held weakly — no unlink bookkeeping); the pipeline transport combines the
  session signal with each turn's controller this way.
- **`sessionSlot()`** (`aai/sdk/session-slot.ts`, exported from the ROOT — it is
  authoring API, not infrastructure) — a typed named slot inside `ctx.state`:
  `get(ctx)` installs the default on first access and returns the live object,
  `set`/`reset` replace it, and `read`/`projection` are the `syncState` side.
  Reach for it whenever an agent's tools live in more than one file, which is
  the case `ctx.state` cannot type on its own: `tool()` learns the state shape
  only from an annotated context (`ctx: ToolContext<S>`), so every module either
  restates that annotation or casts. All five stateful templates had taken the
  cast — `ctx.state as StateSlot` beside a hand-rolled `slot.x ??=
  createDefault()`, five times, comment included — and `retail` took it even
  though its `agent()` declares a `state` factory, because the factory's type
  cannot reach `tools/*.ts`. Note the factory is still worth declaring (it makes
  the session's state exist before the first tool call, which is what
  `pushStateSnapshot` needs on resume) and composes:
  `state: () => ({ [slot.key]: slot.create() })`.

  **`slot.update(ctx, mutate)` is the serialized half, and it is what an ASYNC
  mutator must use.** It holds a per-slot, per-session key for the mutation and
  then runs the slot's optional `after` hook. Both stateful templates with async
  tool bodies had hand-rolled exactly this — `createKeyedLock()` at module scope
  plus `withLock(lock, ctx.sessionId, () => mutator(slot.get(ctx)))`, twice,
  rationale paragraph included — and `after` is what dispatch-center's copy did
  on top (prune resolved incidents, recalculate the alert level), which is
  bookkeeping every mutating tool needs and any new one would forget. `get` is
  still right for a synchronous read-modify-write, which cannot interleave.

  Three properties to know before relying on it. It is **not re-entrant** — a
  `mutate` body calling `update` on the same slot waits on a key only its caller
  can release, which is a deadlock rather than an error (retail keeps that
  unreachable by construction: `retailTool` is the only caller, and tool bodies
  run inside it). `after` **does not run when the mutator throws**, so a
  half-applied value is left as the mutator left it rather than normalized by a
  hook that never saw a complete mutation, and the mutator's error is the one
  that propagates. And the lock is per SLOT as well as per session, so two
  different slots' updates nest safely and one caller never queues behind
  another's.

  **`createKeyedLock`/`withLock` stay public and are now unexercised by any
  template** (allowlisted, deliberately). They remain the right tool for
  serialized work that is not a slot mutation — an external resource, a key
  that is not the session id, or `{ timeoutMs }` when a contended mutation must
  fail rather than queue. `slot.update` covers the case the templates actually
  had, which is why none of them demonstrates the raw primitive any more.

  Two more things the API shape is load-bearing about. `create` is a FACTORY
  called once per session, so a shared module-level default must be cloned
  inside it (`() => structuredClone(DEFAULT)`) or every session mutates one
  object — three templates need this. And `projection(fn)` hands `fn` a REAL value
  rather than the slot, which is what lets a `syncState` projection drop the
  optional chaining it used to carry for the pre-first-tool-call frame; in
  `retail`'s `storeView` that chaining read as security gating and was not (the
  gating that IS security is on `user`, and stayed). The client's empty-state
  fallback then comes from `slot.projection(view)(undefined)` — still derived
  from the projection, so a new field reaches the first render. `retail` is the
  one exception and says why in place: its factory pulls a 107 KB `seed.json`,
  so the client builds the fallback from a seedless `emptyRetailState()` rather
  than importing the slot.
- **`ToolFailure` / `isToolFailure()`** (`aai/sdk/utils.ts`, exported from the
  root and `/utils`) — the `{ error: string }` object a tool returns for a
  failure the MODEL should see and recover from, and the guard that narrows one.
  The guard is the point: failures propagate, so a helper returning `Order |
  ToolFailure` has a caller that forwards it unchanged, and `"error" in value`
  only works once the value is known to be an object. Five templates returned
  the shape; `retail` had its own `ErrorResult` + `isError` (used at ~40 sites)
  and `dispatch-center` narrowed with inline `"error" in inc` at six.

  **It is NOT `toolError()`, which is the trap the two names have to survive.**
  That function returns the pre-serialized wire STRING `'{"error":"…"}'` — what
  the host itself emits for a tool that threw — so `isToolFailure(toolError(m))`
  is `false`. `toolError` is used ~15 times inside `host/` and was used by ZERO
  of the fourteen templates despite its doc telling authors to return it, which
  is what a helper with the wrong shape for its stated audience looks like; the
  doc now names the split, and `utils.test.ts` pins the `false`.
- **`pushCapped(list, item, max)`** (`aai/sdk/utils.ts`, root and `/utils`) —
  append to a list holding a cap, mutating in place (the list is usually a
  property of the state object, so returning a new array is a reassignment the
  caller can forget). For the append-only lists an agent keeps in `ctx.state`: a
  timeline, an activity feed, a session log. Every one of them feeds an LLM
  summary or a `syncState` payload, so uncapped it grows what the model reads
  and what crosses the wire for the length of the call. Three templates had
  hand-rolled `push` + `slice(-MAX)`; the fourth,
  `infocom-adventure`, had NOT — its command history sliced only for display and
  grew without bound, which is the bug a shared primitive turns into a decision.
- **`omitUndefined()`** (`aai/sdk/omit-undefined.ts`, exported from
  `@alexkroman1/aai/utils`) — the one way to build the optional half of an
  object under `exactOptionalPropertyTypes`. That flag makes
  `{ name: maybeName }` an error whenever the value can be `undefined`, so the
  only spelling that compiles is `...(name !== undefined ? { name } : {})` —
  correct, and hand-written 44 times across five packages, eight of them in a
  single object literal in `host/agent-server.ts`. Each line names its key
  twice, which is what makes a mismatched pair (`x !== undefined ? { y: x }`)
  read as noise rather than as the bug it is. Write
  `...omitUndefined({ name, greeting })` instead; renaming a key
  (`{ leadMs: audioLeadMs }`) works the same.

  Three sites deliberately keep the long form, and they are the ones where the
  GUARD IS NOT THE VALUE — `params.port !== undefined ? { AAI_GUEST_PORT:
  String(params.port) }` (`omitUndefined` would stringify `undefined` into
  `"undefined"`), the `JSON.stringify` twin in `aai-server/test-utils.ts`, and
  `opts.mode !== undefined ? { mode: 0o700 }` in the CLI, which sets a
  DIFFERENT value from the one it tests. Check that before converting a
  fourth.

  It lives on `/utils` rather than `/internal` (where the other cross-package
  primitives above sit) for one reason: `/internal` re-exports
  `formatSchemaIssues` from `sdk/schema.ts`, so importing anything from it
  pulls **zod** — and `aai-cli/_utils.ts`, one of its callers, is on the
  documented zod-free CLI startup path.

### Fixed release coupling

`aai`, `aai-ui`, and `aai-cli` are in a **fixed release group** (configured
in `.changeset/config.json`). A changeset for any one of them bumps all
three to the same version. Keep this in mind when creating changesets —
you only need to list one package.

### Testing

- **Vitest**. Test files co-located: `foo.ts` → `foo.test.ts`.
- **The aai-server test project auto-builds the guest harness**:
  `scripts/ensure-guest-harness.mjs` runs as vitest `globalSetup` — wired in
  `packages/aai-server/vitest.config.ts`, the ONE config that declares it —
  and builds `aai-guest` when `dist/harness.mjs` is missing or older than the
  sources, tracking BOTH aai-guest and the `packages/aai` SDK it bundles.
  `createSandbox` resolves the harness eagerly, so an unbuilt one otherwise
  fails every sandbox test. `GUEST_HARNESS_PATH` skips the check.

  **Inside a turbo task (`TURBO_HASH`) it VERIFIES instead of building**, and a
  missing harness there THROWS, naming the `dependsOn` to add. Turbo already
  orders `aai-guest#build` ahead of every consumer and decides staleness by
  hashing inputs; the mtime heuristic is only a guess, and it guesses wrong in
  the ordinary case — a turbo cache HIT restores `dist/harness.mjs` with the
  archived mtime, so any edit under `packages/aai` makes a byte-correct harness
  look stale. The globalSetup then spawned a NESTED `turbo run build` inside
  the parent run, and two tsdown processes wrote `dist/` while sibling tasks
  read it: `aai-studio-server#test` (which declares no globalSetup of its own)
  and `aai-server#check:integration` failed intermittently with "Guest harness
  not built" or `MODULE_NOT_FOUND` on `aai-guest` — naming a file nothing in
  their own package touches. It is the mirror image of the race
  `packages/aai-server/turbo.json` documents: that comment notes this script
  cannot wait out a harness being rebuilt underneath it, and the script was
  itself that rebuild. **A harness a turbo task needs must be DECLARED**
  (`^build`, or `aai-guest#build`), never built at test time.

  The same script also runs as
  `predev` in aai-studio-server (the entry `pnpm dev:aai-server` runs, so dev
  always boots with a fresh harness for local-dev sandboxes) and as
  `predeploy:modal` in aai-server, which owns the Modal deploy (a fail-fast
  before the remote image build, which rebuilds the harness itself). Also
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
  `VITEST_PROFILE` (`integration` 30s / `e2e` 300s) with `VITEST_INCLUDE`
  choosing the files. There is no per-package slow config and no
  `vitest.integration.config.ts`.
- **Integration-tier membership is a NAMING CONVENTION: `*.integration.test.ts`.**
  Unit configs exclude that glob and `test:integration` selects it, so a new
  integration test lands in the right tier with no config edit. It replaced a
  hand-kept filename list duplicated between each `exclude` array and the
  `VITEST_INCLUDE` env var, which had gone stale: `aai` and
  `aai-studio-server` between them excluded five files that no longer existed.
  **Only the `.integration.` infix decides the tier**, so several tests are
  deliberately UNIT tests despite "integration" in the name — `aai-cli`'s
  `integration.test.ts` / `integration-edge-cases.test.ts`, and
  `aai-server`'s `agent-server-integration.test.ts`. That last one really does
  boot a real harness subprocess (hence that package's 20s timeout) and is a
  standing judgement call: it is the only test covering
  `subprocess-sandbox.ts` / `warm-harness.ts` / `sandbox-vm.ts`, so promoting
  it to the integration tier drops aai-server's measured line coverage ~92% →
  88.74% and trips its 89% floor. Moving it means restoring that coverage
  first, not lowering the floor.
- In tests, use `flush()` from `_test-utils.ts` instead of
  `await new Promise(r => setTimeout(r, 0))` to yield to microtasks — and note
  `flush()` is MICROTASK-only. For a full macrotask yield use `tick()`, and for
  real elapsed time `sleep(ms)`, both from `aai/host/_test-utils.ts`; several
  specs used to define a *local* `flush` as `setTimeout(r, 0)`, shadowing the
  export so one name meant two different waits.
- Use `vi.waitFor()` instead of arbitrary delays when polling for async results.
- **A spec that observes a TIMER runs on virtual time, never the wall clock.**
  The pipeline-transport specs used to wait out real milliseconds
  (`await sleep(60)`) to see whether a window had elapsed, which cost ~2.3s of
  the unit run and, far worse, made them races: they were the specs that failed
  first on a contended runner, and the flake named a timing spec rather than a
  bug. It also capped what a spec could describe — every window had to shrink
  to tens of milliseconds, so the dead-air cover was exercised at
  `deadAirCoverMs: 1` and the SHIPPED 5s default was tested by nothing.
  `useVirtualTime()` (`transports/_pipeline-transport-harness.ts`) installs
  fake timers per file; drive them with `vi.advanceTimersByTimeAsync(ms)`.

  **No scheduler had to be threaded through `PipelineTransportOptions` for
  this, and the note that said otherwise was wrong.** The claim was that fake
  timers could not compose with the fake providers because `_fake-llm.ts`
  schedules its own `setTimeout` for `delayMs` — but that is the GLOBAL
  `setTimeout`, which is exactly what `vi.useFakeTimers()` replaces, so it is
  driven along with everything else. `vi.waitFor` composes too. Check the
  cheap mechanism before building the seam.

  Two things virtual time does break, both mechanical: `tick()` is a
  `setTimeout(0)` and hangs until something advances the clock (use
  `vi.advanceTimersByTimeAsync(0)`), and a `vi.waitFor` that polls for work
  gated on a timer still polls in REAL time — prefer advancing by the amount
  the work actually needs, which is deterministic and has no race to lose.

  Deliberately NOT converted: `s2s-transport.test.ts`'s five `sleep(5)` calls.
  Those are queue-settle yields, not timer observations — nothing is racing
  them, and rewriting them would be churn.
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

#### Package-specific suites

The harnesses that only make sense next to the code they exercise are
documented in that package's guide, not here:

| Suite | Guide |
| --- | --- |
| Pipeline-transport interleaving fuzz, fixture replay (`host/fixtures/`) | `packages/aai/CLAUDE.md` |
| Browser session / audio fuzz harnesses (`fuzz-*.test.ts`, worklet stress) | `packages/aai-ui/CLAUDE.md` |
| Studio starter evals (`scripts/starter-eval/`), studio concurrency fuzz | `packages/aai-studio-server/CLAUDE.md` |
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

That line only works because `AAI_TEST_PM` is declared in the `check:e2e`
task's `env` — under turbo's strict env mode it was stripped before the task
started, so the documented command ran pnpm and said nothing (see "strict env
mode" above).

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

One known gap, found by audit and deliberately left alone because it is a
refactor in its own right rather than a fix that rides along with something
else. It is not blocked on a decision; it is sized, not stuck.

- **`aai-server` writes to `console.*` directly** — 47 calls, 45 of them
  outside `_debug-log.ts` — with no logger seam, so 39 of the repo's 86
  `spyOn(console, …)` calls exist purely to keep test output quiet. The
  abstraction already exists one package over — `aai/host` has a `Logger`
  type and `consoleLogger` — and this package has
  a partial one of its own in `_debug-log.ts`. The work is to give the
  package a single injected (or module-swappable) logger and convert the call
  sites, after which the silencing spies delete themselves. It is left out
  here because it touches ~25 files and changes production log wiring, which
  should not land inside a test-quality change.
