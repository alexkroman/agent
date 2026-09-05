<!-- Moved out of AGENTS.md so it is read ON DEMAND rather than loaded into
every task's context. AGENTS.md's "Detailed references" table points here. -->

# Quality ratchets

Beyond lint/typecheck/test, `scripts/check.mjs` **and the CI check job** run
thirteen **gates** (all also runnable standalone) that hold the line on technical
debt. Three compare against a COMMITTED PER-FILE BASELINE
(`check:hatches`, `check:invariants`, `check:api-nameable`); the rest are
absolute. They must stay
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
  `packages/aai-templates/src/test-assertion-gate.test.ts` — both for the same
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
  (`packages/aai-templates/src/claude-md-limit.test.ts`), so it fails in the
  ordinary test run and not only in `pnpm check` — an agent editing a guide
  sees it without knowing this gate exists. It asserts both lines separately
  (over budget = refactor before adding more; over 150k = a guide is being
  truncated right now), that the root still links every package guide, and
  that the script and CI wiring still agree with it.
- **`pnpm check:api-nameable`** (`scripts/check-api-nameable.mjs`) — a type a
  published signature references and NO subpath of its package exports. The
  value passes, and the consumer cannot write the type down. Three things
  already touched this and none FAILED — `includeForgottenExports` RECORDS such
  a type, TypeDoc only covers what it renders, and `check:api-contracts` hashes
  a declaration without asking whether it is importable — so the surface a
  consumer must satisfy and the one it can NAME had drifted apart unmeasured. It
  cost `@alexkroman1/aai-runtime`'s eval and workflow-test surface, which could
  not be rendered at all until four types were exported. Scored per PACKAGE and
  baselined rather than absolute (some must stay unnameable: the `*Misuse`
  compile-error types); its own doc argues both, and the two floors.
- **`pnpm check:coverage-per-file`** (`scripts/check-coverage-per-file.mjs`) — a
  50% per-file statement floor over what `test:coverage` wrote, because the
  `vitest.config.ts` thresholds are PACKAGE-wide and cannot see one new module
  landing untested. **Its ratchet runs the other way** — coverage may only go up,
  so `--update` refuses to lower an entry and never creates one; `--seed` is the
  bootstrap, opened at 15 files. Runs per package in CI's coverage matrix
  (`--package`). The script's own doc carries the rest.

- **`pnpm check:module-tests`** — a co-located test per module; read the script.

- **`pnpm check:konsistent`** ([konsistent], config in root `konsistent.json`)
  — enforces **structural** conventions: the shapes that are wrong only in
  relation to their siblings, which is why no per-file tool can see them.
  Biome lints statements and tsc type-checks a program; neither can say "every
  module in this directory must look like the others." Their count is not
  written here — a hand-kept one went stale twice. They cover the four things
  this repo restates by hand — the
  per-package file set (`package.json`, `tsconfig.json`, `vitest.config.ts`,
  `CLAUDE.md`, plus README/`tsconfig.build.json`/`tsdown.config.ts` on the
  four published ones) and each `vitest.config.ts` importing `sharedConfig`;
  `*-barrel.ts` files being pure re-export surfaces; the **dependency-graph
  boundaries** under "Dependency flow" (aai imports no sibling, aai-runtime
  imports only aai, the CLI imports neither server nor guest, the guest imports
  no server code, the SERVER imports no guest source, neither browser bundle
  — aai-ui, the studio client — imports platform or runtime code, the studio
  server and the evals keep one legitimate edge each, `sdk/` reaches no `host/`
  module, and a TEMPLATE imports no internal subpath and no private package —
  shipped product, so an import that resolves here is absent from a user's
  install and `check:template-types` compiles it clean);
  and the repeated-by-construction shapes — every
  STT/TTS/LLM/S2S provider module's `*_KIND` / `*_API_KEY_ENV` / `*Options` /
  factory / `resolve*Settings` set, checked by SIGNATURE (its own Options in,
  the stage type out) and for importing no vendor SDK,
  every CHANNEL module's `*_CHANNEL_KIND` / `*ChannelOptions` / factory set (no
  `*_API_KEY_ENV`: a channel's credential is its destination and is passed in,
  never read from the agent env), each store factory returning the interface it
  implements, and every template's `agent.ts` + `agent.test.ts` + `client.tsx` +
  `tools/` default exports.
  Four more were prose in this file until a roster in one of them went stale:
  `test-helper-modules`, `published-testing-split`, `concurrency-primitives`
  and `guest-route-exposure`, plus `type-level-tests` (a `.test-d.ts` really
  asserts with `expectTypeOf`), which was never enforced at all. Each carries
  its deleted paragraph as its `description` — that field is where the argument
  goes, so a violation explains itself and a reviewer never re-explains it.
  `pnpm check:konsistent-config` (`konsistent validate`) checks the config
  against its schema without touching the tree.

  `template-tools` was once retired on the ground that a DISCOVERED tool leaves
  nothing per-file to assert. The DEFAULT EXPORT is what discovery reads, so
  that is what it asserts now. See "A `tools/` file IS the tool" in
  `packages/aai-templates/CLAUDE.md`.

  Two things to know before editing `konsistent.json`. **A convention that
  matches nothing passes** — a typo'd `paths` glob checks zero files and prints
  the same "No violations found" as a healthy run, with no error anywhere, so
  `packages/aai-templates/src/konsistent-config.test.ts` asserts every pattern's
  literal prefix exists (plus that each convention is named, described, and
  declares at least one predicate). **A deny list also goes stale by SILENCE**,
  there being no allow-list form, so that test derives the package set from the
  manifests and asserts the boundary matrix is TOTAL. And **the case maps
  compose**:
  `kebabToCamelMap` is DERIVED from `kebabToPascalMap` when absent, so
  declaring `openai: OpenAI` for the type names also makes the factory
  `openAILlm`. That is the wanted derivation; the identity entries that used to
  suppress it (`openai: openai`, `openrouter: openrouter`) are gone with the
  lowercase spellings they kept alive. `elevenlabs: elevenLabs` stays, being a
  real override rather than an identity.

  The exact version pin, and the predicate-catalog trap that comes with it, are
  in `packages/aai-templates/CLAUDE.md`.

  [konsistent]: https://github.com/vercel-labs/konsistent

- **`pnpm check:invariants`** (`scripts/guard-invariants.mjs`, rules in
  `scripts/guard-invariants-rules.mjs`) — **the mechanical half of this file.**
  Numbered rules, each printing WHY the invariant exists and what to use
  instead, so a violation is self-correcting and a reviewer never re-explains
  it.

  **`node scripts/guard-invariants.mjs --rules` prints the catalogue.** There
  used to be a copy of it here, a `# | Rule | Instead` table of all 32, and it
  went stale twice — it stopped at 23, then at 28 — while the one DERIVED line
  beside it, the printed count, stayed right. That is the same failure the
  script's own prose catalogue was deleted for, and the file already said so
  about itself ("when it disagrees with `--rules`, `--rules` is right"), which
  is an instruction to read the other thing rather than a reason to keep this
  one. So there is no copy now: the catalogue is computed from the `id`,
  `label` and `remedy` every rule carries, and a new rule joins it by existing.

  Rule IDs are **stable** — they appear in commit messages and in the baseline,
  so a deleted rule leaves its number retired rather than letting a later rule
  inherit it (6, retired with `ctx.state`; 10, with the `research/` directory it
  checked; 15, reserved). Several are at zero and enforced
  absolutely; the rest carry per-file baselines. **Rule 3 is back at zero**: it
  used to carry a baselined entry that was never a violation — a wrapped
  `Promise.race([` was matched by its opening LINE, which cannot see whether a
  timer is among the elements, so a timer-free race scored. It is a node rule
  now and looks at the elements, which is the difference between over-reporting
  as the cheap error and not having to choose.

  **Rule 2's `undefined` scope is a BOUNDARY, and rule 22 is why.** Rule 2 tests
  presence, which `omitUndefined` *is*, so its matches rewrite without changing
  behaviour; `...(x && { x })` also drops `""`, `0` and `false`, so widening rule
  2 to reach it would have the gate recommend a behaviour change on 145 lines.
  Rule 22 counts that family instead, the first rule here **seeded as debt** (145
  across 75 files, goal zero) — its entries are lines nobody has read yet.

  **Eight scopes, eight corpus FLOORS**, and three were missing — the
  shipped-source corpus rules 11 and 27 share (1,224 files, and 11 is the
  Windows-portability rule whose regressions are invisible on every machine
  that runs CI), rule 12's guest HTTP surface, and rule 13's 175 template
  files. The last two derive their corpus from `git ls-files`, which
  exits **0** on a pathspec matching nothing where `git grep` exits 1 — that
  asymmetry is exactly why the grep-based rules announced their own blindness
  and these two could not.

  **TWO ENGINES, chosen by what a rule ASKS.** A **line rule** carries a POSIX
  ERE for `git grep -E`; a **node rule** carries a `match(node)` over a real
  parse (`oxc-parser`, via `scripts/_ast-scan.mjs`, predicates in
  `-nodes.mjs`). Everything else is shared — one baseline, one `--update`
  contract, one report — so a rule keeps its id, key and budgets across a
  migration, and the gate interleaves both lists by id. Ask whether the thing
  banned is a **name** or a **shape**: `delete process.env.X` (5), a `/tmp`
  literal (11), an `on*` declaration (16) are names, and grep answers them
  exactly; "a callback that is `async`", "a delay that is zero", "a timer among
  a race's elements" are shapes, and **every gap this gate has ever had was a
  shape written as a pattern.** The timing family (3, 4, 19, 21, 23, 31) is all
  six of them and went first — its module doc lists the four misses that closed,
  including a rule 21 printing `0 ✓` over two live `expect.poll` calls Biome had
  wrapped. Line rules keep one thing the parse gives up: they see code inside a
  TEMPLATE LITERAL, which several fixtures write out and then execute. Parsing
  the repo costs ~1.6 s; the gate went 1.2 s to 2.4 s.

  **The rule definitions are seven modules behind one barrel.**
  `guard-invariants-rules.mjs` re-exports `LINE_RULES` and `NODE_RULES` (each
  sorted by id) and the scope constants; under it sit `-ere.mjs` and `-nodes.mjs`
  (the two vocabularies), `-scopes.mjs` (the corpora), and four rule groups —
  `-rules-timing.mjs` / `-rules-shape.mjs` / `-rules-state.mjs` /
  `-rules-workflow.mjs`, the last holding the two rules over a shipped
  `workflows/` body, which left the timing module when rule 31 took it past the
  source cap.
  **Every LINE-rule module is in the gate's `SELF_REFERENTIAL` set**,
  because each `label` and `re` describes the thing it bans — a split that
  forgot one file would be the fifth time this repo pays for that trap. The two
  node modules are absent by proof rather than by oversight: a node rule's own
  definition cannot match it, a remedy quoting the anti-pattern being a string
  literal and not a call — the entry was removed and the gate stayed green. A
  rule may also carry `samples: { matches, ignores }`, where a widened pattern's
  proof belongs: rule 3 shipped for months with a single-line positive sample
  while blind to the multi-line form. A node rule's samples are SOURCE, so that
  gap is not expressible — but a node rule can still be silently dead, and rule
  31 was, matching nothing until `unwrap` existed (oxc preserves
  `ParenthesizedExpression`). Its own sample caught it.
  The per-file baselines carry the same `--update`-only-lowers contract as
  `check:hatches`.

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
