# aai-gates

The repo's **meta-gate suite**: the tests that hold `scripts/check-*.mjs`,
`konsistent.json`, `turbo.json`, `lefthook.yml` and the GitHub workflows to
their own contracts. Nothing here is about the product. Nothing here ships.

## Why it is its own package

These 28 suites lived in `aai-templates` for as long as they existed, which put
7,700 lines of test about the REPOSITORY inside the package that holds the
example agents — 265 lines of source against 8,846 lines of test, four of the
files about templates and the rest about `ship.yml`.

Three things were wrong with that, and none of them was cosmetic:

- **`aai-templates`' coverage floors measured the gate suite.** A package whose
  numbers come from tests of something else has no floor of its own; the
  template surface it was supposed to ratchet was a rounding error in the
  denominator.
- **CI's `test (aai-templates)` job was really "the repo gate suite"**, so a
  red job named the wrong thing.
- **`aai-templates/turbo.json` reached four levels out** to hash `../../AGENTS.md`,
  `../*/CLAUDE.md`, `scripts/**` and `.github/workflows/*.yml`. A package
  declaring the repo root as its input is the build config saying those tests
  belong somewhere else. Those entries are in THIS package's `turbo.json` now,
  where they describe the truth, and `aai-templates` kept only the two it
  really reads (`biome.json` and `scripts/_api-contracts-tree.mjs`).

## What it may depend on: nothing

`package.json` declares `oxc-parser` and `vitest` and no workspace package at
all — deliberately. A gate spec reads the repo as TEXT (Vite `?raw` globs) and
asserts on it; it must never import the script it guards, which would be
asserting a module against itself, and the scripts reach `node:` builtins this
package's `tsconfig.json` does not admit. `_gate-support.ts`'s hand-rolled path
walk exists for exactly that reason and says so at the declaration.

The same rule runs the other way: `byCodeUnit` and `sole` are duplicated in
`aai-templates/src/_template-support.ts` rather than exported from here. That
is the repo's `test-helper-modules` convention — a spec reaches for the helper
beside it — and publishing a test helper as a subpath so one sibling can reach
it is the shape `aai-server`'s exports map is criticized for.

## A gate spec's SOURCES are shared; its assertions are not

`_gate-support.ts` holds what every gate spec here reads and none of them owns:
`GATE_WIRING` (the three files a gate must be NAMED in — `package.json`,
`scripts/check.mjs`, `.github/workflows/check.yml`), `ERE_UNSUPPORTED` (the regex
constructs POSIX ERE has no answer for, banned by both pattern-shipping gates),
`repoPathOf` (a Vite glob key as a repo-relative path), `sole` (the one value a
single-file glob resolved to), `byCodeUnit` (the explicit comparator the repo
requires of anything a gate reads) and `numericConstant` (a cap read out of a
gate script's source rather than restated). The wiring block alone stood in FIVE
specs at seventeen lines each, differing only in the gate name the caller then
asserts; `sole` replaced two dozen reads that spelled the globbed path TWICE,
once for the transform and once to index the result — a pair that drifted would
have read `undefined`, i.e. a gate checking an empty string.

Sharing them is safe precisely because none of it is an assertion: each spec
still makes its own, over its own gate, and a glob that stopped resolving leaves
`GATE_WIRING`'s values `undefined` so every caller's `toBeTypeOf("string")`
fails. What must NOT move here is a positive/negative sample or a floor — the
per-gate discipline is the whole point of these files, and one spec asserting
another's samples is the vacuous-guard failure they exist to prevent.

`import.meta.glob` is a compile-time transform, so a caller cannot hoist the
pattern OR the options object into a constant. It can import the result, which
is the only reason this module works — and it is why the glob-per-source shape
stays wherever a spec reads a source only it cares about.

It never ships — nothing under `aai-templates`' `templates/` or `scaffold/`
may import it, and `guard-invariants` rule 13 enforces that, which since the
split is true by construction: this package is not a dependency of anything.
The shared-helper shape is right here and wrong inside a
template.

## A new guard-invariants rule, and what the linter cannot do for you

Two things any new rule must respect, and `guard-invariants-gate.test.ts` is
where both are asserted.

**A pattern that matches nothing prints the same checkmark as a rule being
upheld**, so the spec feeds every rule a positive sample it must catch and a
negative twin it must spare, importing the rules as real values rather than
scraping them out of the source. Rule 4 shipped its first draft with `[^)]*`
between `new Promise(` and `setTimeout(`, which cannot cross the arrow's own
parameter list — 0 reported against five real occurrences, the same
silently-dead-pattern shape as the `\b` bug in `check-escape-hatches.mjs`. And
**the rules module matches most of its own rules**, since every `label` and `re`
describes what it bans; it, the gate, the baseline and the gate's spec are all in
the script's `SELF_REFERENTIAL` set. That is the third and fourth time this trap
has been paid for.

### `vitest-setup-wiring.test.ts` — a gate is only as wide as its rollout

`scripts/fail-on-process-warning.mjs` re-raises `MaxListenersExceededWarning` as
an unhandled error, turning Node's only built-in leak detector into a failure.
Measured before it existed: a test attaching 25 listeners to one emitter PASSED
while printing the warning into a scrollback CI's `dot` reporter buries.

**The signal was already trusted twice, which is the argument FOR enforcing it in
tests.** `aai-guest/harness-leak-watch.ts` watches it at RUNTIME in the guest,
written because Node warns exactly once per emitter (measured there: 500
listeners, one warning, at 11) — which is what made the `streamTail` leak of
\#1203 expensive to diagnose from a log. And `aai/host/transports/
pipeline-transport.ts` raises the threshold with `setMaxListeners` under a
comment calling it "A LEAK threshold, not a capacity one". So a leak reaching
production is watched; a leak a suite already provokes is what this closes.

Measured over the whole unit run (536 files, 7998 tests): **nine occurrences,
all nine in `aai-guest/harness-leak-watch.test.ts`**, whose subject IS the
warning — it synthesizes them through `process.emit` and attaches 88 real
listeners to a real emitter. That suite sets
`globalThis[Symbol.for("aai.expectsProcessWarnings")]` at module scope, which is
the one legitimate opt-out; every other suite is clean, so the rule is absolute
rather than baselined. `vitest-setup-wiring.test.ts` asserts the opt-out has
exactly ONE user, because an exemption nobody counts is how a gate narrows with
no diff saying so.

**Only `MaxListenersExceededWarning` fails a run.** Failing on every
`process.on("warning")` would fold in `DeprecationWarning` /
`ExperimentalWarning` from dependencies we do not control, which is how a gate
gets muted rather than fixed.

**What this spec guards is the ROLLOUT, because a partial one looks identical to
a complete one.** `setupFiles` is an ARRAY, so a package config writing
`setupFiles: ["./_jsdom-setup.ts"]` after `...sharedConfig.test` REPLACES the
shared list rather than extending it — no error, no warning, that package simply
stops being gated. FOUR of the nine packages declare their own — plus
`vitest.slow.config.ts`, a fifth config — so that is five chances to opt out
silently, and the tenth package added will be a sixth. It is
the same trap the root guide records for `test` itself, where it cost every
package its `reporters`; that one was found by reading, this one is mechanical.
The spec asserts against config SOURCE rather than a loaded config object
deliberately: a resolved array is what is right today and silently regresses on
the next edit — the spread is the invariant.

Two mechanical notes on the script, both load-bearing. The listener installs
once per PROCESS via a marker property read off `process.listeners("warning")`:
`setupFiles` runs per test FILE and `process` is itself an EventEmitter capped
at 10, so a plain `process.on` here would trip the gate on ITSELF around the
eleventh file in a worker — correct code reported as a leak, by the leak
detector. And it throws from a `queueMicrotask` rather than from the listener,
so the failure does not unwind whichever call site happened to add the listener.

### Rule 23 exists because Biome cannot see a `node:` builtin

Biome's `noFloatingPromises` / `noMisusedPromises` are ON, so a rule duplicating
them would be noise. Measured against Biome 2.5, what they DO catch: a floating
call in local or relatively-imported source, from a third-party package
(`p-timeout`, `zod`), from a global (`fetch`), a `.then` chain with no rejection
handler, `Promise.all`, a promise in a boolean position, and an async callback
passed to a **locally-declared** `() => void` parameter.

What they report NOTHING for is every promise whose type comes from a `node:`
module: `writeFile` (node:fs/promises), `pipeline` / `finished`
(node:stream/promises), `setTimeout` (node:timers/promises), `resolve4`
(node:dns/promises), `once` (node:events) — and the two that matter most here,
`EventEmitter.on(…, async …)` and `AbortSignal.addEventListener(…, async …)`.

Three hypotheses were tested and all three are wrong, which is worth recording
so nobody re-tests them: it is not a resolution failure (`@types/node` resolves
from the package), not a `Promise<void>` exemption (both are caught when declared
locally), and **not fixable by re-exporting** — routing the import through a
local `export { writeFile } from "node:fs/promises"` restores nothing, because
the blindness follows the type's ORIGIN rather than the import path.

**typescript-eslint cannot close it.** Its type-aware rules need
`ts.createProgram` and a `TypeChecker`; `typescript@7.0.2` exports only
`lib/version.cjs` plus the `unstable/*` subpaths, which is the same constraint
that makes `docs/` pin `typescript@~6`. Linting with a second compiler the repo
does not build with is a worse trade than the gap — so if that pin ever moves,
re-measure the list above before retiring rule 23.

**The floating half is deliberately NOT a rule.** `readFile(…)` written as an
arrow expression body that legitimately RETURNS the promise is indistinguishable,
line-wise, from a floating statement, and three of the tree's occurrences are
exactly that — a rule flagging correct code is one that gets muted rather than
fixed. The listener half has no such twin, which is why it is rule 23.

## `check.yml`'s push list and concurrency group are specced here

`ci-gate-job.test.ts` guards the `ci` job — the single required check — and it
also owns the two facts about WHEN that workflow runs, because both are the
shape this package's gates exist for: config that looks live while checking
nothing.

**The push list is `main` and nothing else.** `changeset-release/main` sat beside
it and was a straight duplicate: a Version Packages PR targets main, so the
`pull_request` arm already covers that branch, the two runs land in different
concurrency groups (`check-<number>` vs `check-<sha>`), and nothing dedupes
them — every push to a version PR ran the whole matrix twice. 97 such push runs
are in the history, and they stopped on 2026-08-07 when `RELEASE_TOKEN` went
dead: `GITHUB_TOKEN` cannot trigger a workflow. That PAT is gone now, so the
entry can never fire again — but it was invisible in a diff AND in the run list
for weeks, which is the shape worth asserting against.

**The push concurrency group is per-SHA, and that is what makes
`cancel-in-progress: false` mean anything.** GitHub keeps at most ONE pending run
per group and cancels it when a newer run joins, so declining to cancel the
IN-FLIGHT run does not save the QUEUED one. With every commit on main sharing a
single `github.ref` group, each main run died at the exact second the next merge
arrived — measured over 28 consecutive main pushes: 5 cancelled, every one's
`updated_at` equal to the next run's `created_at`, and nothing reaching a verdict
on main across five merges between 16:00 and 21:57 on 2026-08-18. That is
precisely the "gap in its history exactly where it is merging fastest" the
workflow's own comment says the setting prevents. The pull-request side stays
keyed on the PR NUMBER: a PR's `github.sha` is the merge ref and changes on every
push, so a bare per-SHA group there would supersede nothing.

Both specs were A/B'd against the old config before landing — the non-vacuity
rule every gate in this package carries.
