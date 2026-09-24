---
summary: >-
  Every gate beyond lint/typecheck/test: what each one checks, the failure it
  was written for, and the baseline or floor it carries.
read_when: >-
  a `check:*` gate fails, or you are adding, loosening or retiring one
---

<!-- Moved out of AGENTS.md so it is read ON DEMAND rather than loaded into
every task's context. AGENTS.md's "Detailed references" table points here. -->

# Quality ratchets

Beyond lint/typecheck/test, `scripts/check.mjs` **and the CI check job** run
the **gates** in its `GATES` table (all also runnable standalone) that hold the
line on technical debt — the count is not written here, because a hand-kept one
was already stale when two more landed. Four compare against a COMMITTED
PER-FILE BASELINE (`check:hatches`, `check:invariants`, `check:api-nameable`,
`check:duplication`); the rest are absolute. They must stay
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
- **`pnpm check:package-layout`** (`scripts/check-package-layout.mjs`) — a
  package's TypeScript lives under `src/` (see "Package layout"). Stated from
  BOTH sides, since "no `.ts` outside `src/`" is vacuously true of an emptied
  package: every package must also HAVE a non-empty `src/`. Two corpus floors,
  for the reason every counting gate here carries them. Its header has the
  argument and the three failures the flat layout cost.

- **`pnpm check:bundled-deps`** (`scripts/check-bundled-deps.mjs`) — every npm
  package INLINED into `packages/aai-studio-server/dist/index.mjs`, against
  `scripts/bundled-deps-baseline.json`. Only ever lowered. Same mechanism as
  `check:optional-peers` below, from the other end: that one asks what an
  inlined dynamic import does to a CONSUMER's build, this asks what inlining
  does to the package itself. Compiling `aai-server` into the service entry
  swallows its dependencies too — 52 of them, named nowhere — and a swallowed
  module does not run from where its source lives, so anything in it that
  resolves by module location breaks while the build, tsc and the whole suite
  stay green. `@alexkroman1/aai-ui` was one: `defaultClientDir()` finds the
  browser client by self-referencing its own `package.json`, legal only from
  inside that package, and every deployed agent page answered 500 for a UI that
  was installed. That one was fixed by injection
  (`createDefaultClientHandlers`); the next cannot be, since nobody injects into
  `node-gyp-build-optional-packages` — so `modal` and `microsandbox` are
  `external` (the first takes 26 of the 52 with it, being their tree) and the
  25 that remain are pure JS where inlining is free.

  It RUNS the studio build and reads tsdown's own `Detected dependencies in
  bundle` hint rather than re-deriving the set from the lockfile: rolldown
  inlines what is imported, not what is declared, and a gate whose set
  disagrees with the real bundle is worse than none. An ABSENT hint is a hard
  failure — `deps.onlyBundle` suppresses it while ALSO externalizing
  `aai-server` itself, which is the cold-start regression that config's comment
  exists to prevent, and an unparsed hint and a bundle that swallows nothing
  look identical from here. `bundled-deps.test.ts` holds the config to
  `alwaysBundle` from the authoring side, because the specifier checks beside it
  pass either way.

- **`pnpm check:optional-peers`** (`scripts/check-optional-peers.mjs`) — no
  module a PUBLISHED entry can reach may statically import an OPTIONAL PEER.
  A consumer bundles these packages with `ssr: { noExternal: true }` and
  `codeSplitting: false` (that is `aai build`'s worker and every deployment
  target's entry), and both settings together INLINE a dynamic import — so a
  module reached only lazily still has its own imports resolved at the
  consumer's build time, against a project that installed nothing it never
  enabled. Vite substitutes `__vite-optional-peer-dep:<peer>`, which exports
  nothing, and rolldown fails every named binding against it. Twelve
  `[MISSING_EXPORT]` errors killed a real `vercel deploy`, out of
  `aai-runtime/_tracing-otel.ts`; the same module had done it once before
  through a different importer, and the remedy both times was "keep it out of
  that bundle" — an invariant over the whole import graph, re-decided by every
  new caller and checked by nothing.

  So the rule is about the IMPORT FORM, which is local and visible: an optional
  peer is reached through `await import(...)`, or through `import type`, never
  through a static value import. Measured against vite 8 / rolldown, a dynamic
  import is not export-checked in either spelling (`(await import(p)).X` and
  `const { X } = await import(p)` both build clean), so the missing peer
  surfaces when the feature is switched on rather than at a stranger's build.
  `import type` is erased entirely; `import { type A }` is NOT allowed, because
  `verbatimModuleSyntax` still emits an `import {} from "..."` that evaluates
  the stub.

  The corpus is REACHABILITY, not a file-name convention: the transitive graph
  (static and dynamic edges, since a bundler inlines both; type-only edges are
  erased and therefore not edges) from each package's `exports`, minus the
  entries declared test-only in the script's `TEST_ONLY_ENTRIES`. That is what
  distinguishes `_tracing-otel.ts` from the dozen test helpers that import
  `vitest` — also an optional peer — perfectly correctly. Two floors, for the
  reason every counting gate here carries them: the modules reached, and the
  dynamic peer imports found (a parse that stopped seeing specifiers would
  otherwise print a clean zero).

  **`TEST_ONLY_EDGES` is the one exemption, and it is two edges**: the dynamic
  imports inside `internal.ts`'s conformance loaders, whose only callers are
  `aai-server`'s platform arms. They are the one place where following a
  dynamic edge over-reports — a bundler inlines one, but it also tree-shakes an
  export nobody calls, and no runtime path calls a conformance suite (measured:
  the guest harness bundles `/internal` with `codeSplitting: false` and carries
  no vitest). Keyed by the module that names them, so a NEW edge out of the
  same module is still checked, and a declared edge that stops existing fails
  the gate rather than rotting. The shape this gate was written for — a loader
  a shipped feature really calls — is still caught on that same subpath.

  Its empirical half is `aai-cli`'s `_target-bundle-peers.scenario.test.ts`,
  which builds a real target entry in a project whose runtime is COPIED out of
  the workspace with the peers unlinked — the only way to reproduce a user's
  install, since resolution follows a symlink to its realpath and finds this
  workspace's devDependency.

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

  **Read the HEADROOM report before starting a feature in `transports/`, because
  the cap is where a four-branch integration nearly broke.** The gate prints the
  files closest to their ceiling for exactly this, and it is advisory, so nobody
  reads it until something is already red. Measured 2026-09-11 on the
  integration branch: **105 files sit within 10% of a cap.** Two of them were
  already over on an unpushed branch —
  `aai-runtime/src/transports/pipeline-transport.ts` at 530 and
  `pipeline-user-speech.ts` at 592, neither allowlisted, 122 lines over between
  them — and the violation went unnoticed only because that branch had never been
  pushed and so had never run a pre-push `pnpm check`. Both files sat within six
  lines of the cap on `main` (500 and 494), so *any* feature touching them
  owed a split before it owed anything else. Two branches then extracted from
  the SAME
  file independently and produced duplicate modules, which is the shape to expect
  when a hot file has no headroom.

  **And `aai-runtime/src/session-history-replay-equivalence.test.ts` is at
  exactly 700/700**, so the next line added there forces a split. Recorded rather
  than pre-split: the seam is not obvious and the split should belong to whoever
  next needs the room.
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
  `packages/aai-gates/src/test-assertion-gate.test.ts` — both for the same
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

- **`pnpm check:claude-md`** (`scripts/check-claude-md.mjs`) — caps agent
  guides in two tiers. **Auto-loaded** guides (`AGENTS.md`, every package or
  directory `CLAUDE.md`, `docs/CLAUDE.md`) get **40,000 characters**, because
  Claude Code loads them unasked on every task in that directory.
  **Reference** files (`*-CLAUDE.md` siblings, `.agents/*.md`, the scaffold and
  template guides) get **120,000**, 20% under the ~150k point past which a read
  silently drops the rest. An auto-loaded guide still over 40k is listed in
  `scripts/claude-md-baseline.json`, which is shrink-only: growing past an
  entry fails, shrinking below one fails until `pnpm claude-md:update` records
  it, a stale entry fails, and `--update` never raises or adds. When it fails,
  move the section to the `CLAUDE.md` of the directory it governs and leave a
  pointer (the report names the largest `##` sections); the scaffold guide has
  to be cut. It also pins the root `CLAUDE.md` to `@AGENTS.md`. Mirrored as a
  test, `packages/aai-gates/src/claude-md-limit.test.ts`, which reads the same
  baseline and asserts the caps match.
- **`pnpm check:shell`** (`scripts/check-shell.mjs`) — ShellCheck over every
  tracked `*.sh` and extensionless `sh`/`bash`-shebang file, since Biome reads
  no shell. The binary comes from PATH (or `SHELLCHECK`): a missing one is an
  announced SKIP locally and a failure under `AAI_REQUIRE_SHELLCHECK=1`, which
  `check.yml` sets. Floored at the measured script count.
- **`pnpm check:guide-index`** (`scripts/docs-list.mjs --check`) — every agent
  guide (`.agents/*.md`, `docs/CLAUDE.md`, each package's `CLAUDE.md`, its
  `*-CLAUDE.md` siblings, and directory guides under `src/`) opens with a
  frontmatter block holding exactly `summary` and `read_when`, and AGENTS.md's
  four guide tables match what `pnpm sync:guide-index` generates from them; a
  missing marker pair fails. Hand-kept tables drift. `pnpm docs:list` prints
  the same index for a reader. Floored at 30 guides.
- **`pnpm check:workflows`** (`scripts/check-workflows.mjs`) — actionlint and
  zizmor over `.github/workflows/`, the config agents edit most and which
  nothing read before GitHub ran it. actionlint type-checks expressions,
  `needs` and outputs, and runs ShellCheck over every `run:` block (the shell
  `check:shell` cannot see); zizmor audits template injection, default token
  scopes and persisted checkout credentials. The first run found 30 zizmor
  findings and 3 ShellCheck notes, all fixed: every workflow now opens with
  `permissions: contents: read`, every checkout that does not push sets
  `persist-credentials: false`, and the two that do carry an inline
  `# zizmor: ignore[artipacked]` saying why. **CI passes `--base origin/main`,
  so zizmor's policy (`.github/zizmor.yml`, none today) is read from the base**:
  a PR that relaxes it is still audited under the policy it is trying to
  change. Same PATH/`AAI_REQUIRE_WORKFLOW_LINT=1` shape as `check:shell`;
  `check.yml` installs pinned versions with pipx. Offline audits only.
- **`pnpm check:template-types`** (`scripts/check-template-types.mjs`) — every
  template, plus the scaffold's `server.mjs`, `global.d.ts` and two configs,
  compiled under the tsconfig `aai init` ships (derived at run time by
  `_scaffold-tsc.mjs`, never copied). **It runs TWICE**: that config verbatim,
  then with `exactOptionalPropertyTypes: true` overlaid. The second pass exists
  because `_api-contracts-compat.mjs` proves an epoch revision compatible
  under that flag, while nothing compiled a real consumer under it — so a
  published optional field that rejects an explicit `undefined` passed every
  gate and broke only the user who turned the flag on. It is an OVERLAY, not a
  scaffold setting: flipping it in `scaffold/tsconfig.json` ships it into every
  user project, a product call rather than a gate's. `noUncheckedIndexedAccess`
  needs no second pass — the scaffold already sets it. Both passes were clean
  when the second landed; a canary `{ a?: number } = { a: undefined }` in a
  template fails only the strict one. When the strict pass fails inside an SDK
  type, fix the PUBLISHED type (`?: T | undefined`), not the template.

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

**An EXPLICIT FILE LIST gets a floor too, and its floor is its own LENGTH.**
`SCAN_CORPORA`'s glob entries carry a measured number with headroom, because
the interesting failure there is partial; a hand-written list of exact paths
has no headroom to allow — every entry must resolve, so `minFiles:
THE_LIST.length` is the honest floor and a single renamed file fails it by
name. `SESSION_SURFACE_PATHS` had that from the start and
`RUNTIME_ROUTE_SOURCES` did not, which is the worse of the two failure modes
rather than a smaller one: rule 12 does not merely SCAN those six modules, it
`readFileSync`s each to resolve the `export const` a `server-routes.ts` entry
references — unguarded — so one moved file threw an uncaught `ENOENT` out of
the gate and took the OTHER 29 rules' findings with it. `check:invariants`
reported nothing about anything, which is the one output a ratchet must never
have. Being SPREAD into a wider pathspec list is not a floor for the entries
either: `RUNTIME_ROUTE_SOURCES` feeds `GUEST_SURFACE_PATHSPECS`, whose 32 files
clear a floor of 20 with five of the six missing.

The general rule, which is what the `src/` restructuring cost four times over:
**a path or specifier written down in a gate needs an assertion that it still
resolves, sited before anything reads it.** TypeScript cannot supply one — a
gate script runs outside the program it checks, and the whole reason these
lists exist is to reach files nothing imports (see "Before turning another
prefix into a directory" in `packages/aai-runtime/CLAUDE.md`). What is available
instead is the choice between a named finding and a silent narrowing, and it is
made per mechanism: `check-optional-peers.mjs` fails when a `TEST_ONLY_EDGES`
exemption names a subpath that is gone, `JOURNAL_BACKENDS`' sweep fails when a
registered `module` is absent from the tree, and this floor covers the third
shape. A `readFileSync` over a path literal with no such assertion is the shape
to refuse in review.

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
