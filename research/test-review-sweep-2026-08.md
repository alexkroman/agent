---
issue: TODO
status: proposed
last_updated: "2026-08-15"

---

# Every test, and the machinery that gates them — 150 findings, 133 cleanups

A combined correctness (`/code-review`) and quality (`/simplify`) pass over
**every test file in the repository** (482 files, ~106,000 lines across the nine
workspace packages), and then over **the gates, configs and helpers that decide
whether those tests mean anything** (~99 files, ~12,800 lines). Part I is the
tests; Part II is the machinery. Nothing was edited — this document is the whole
deliverable.

This is the direct sequel to `code-review-sweep-2026-08.md`, which covered every
**non-test** source file (869 files, ~118,000 lines) and whose findings landed
in PRs #1117 and #1118. Tests were explicitly out of scope there, which left the
larger half of the repo's assertions unreviewed: the source sweep asked "is this
code right?", and this one asks the question that has to come second — **"and
would we find out if it stopped being right?"**

## Why this is in `research/` and not a guide

Same argument the source sweep made, and it applies more sharply here. A guide
says what to do in code that exists and is loaded into an agent's context on
every task; 283 findings about code that is about to change is exactly the
content that took the root guide to 233,000 characters. When a finding here is
fixed, the *rule* it establishes belongs in the owning package's `CLAUDE.md` as
a few lines, and this doc keeps the argument. Its `status` should move to
`implemented` (or the findings should be split into issues) rather than the file
being deleted.

No numeric prefix: this depends on nothing and nothing depends on it.

## Method, and what that buys

Thirteen independent reviewers, one per slice, each reading every file in its
slice in full. Each was given the package's own `CLAUDE.md`, the repo-wide rules
from `AGENTS.md`, and — the part that matters — an explicit list of **what is
already guarded** in its slice, so a reviewer would not spend its findings
reporting the gates. Each finding had to survive a refutation pass, and every
slice keeps a "Deliberately not reported" list of paths it checked and
*cleared*, because a checked-and-cleared path is worth as much to the next
reader as a finding.

The orchestrator then verified the cross-cutting claims independently, and three
of them **by execution** rather than by reading. Those three are the first three
findings below; each is reproducible from the commands recorded with it.

| Slice | Files | Lines | Correctness | Quality |
| --- | --- | --- | --- | --- |
| `packages/aai/sdk` | 47 | 7,028 | 8 | 9 |
| `packages/aai/host` (a–l) | 38 | 8,343 | 10 | 10 |
| `packages/aai/host` (m–z) + `aai/*.ts` | 39 | 8,967 | 10 | 10 |
| `packages/aai/host/transports` + `telephony` | 33 | 9,138 | 8 | 8 |
| `packages/aai/host/providers` + `integration` | 20 | 5,815 | 8 | 6 |
| `packages/aai-ui` | 43 | 9,588 | 9 | 9 |
| `packages/aai-cli` | 44 | 9,842 | 13 | 11 |
| `packages/aai-guest` | 26 | 5,285 | 11 | 8 |
| `packages/aai-server` (first half) | 46 | 8,745 | 12 | 7 |
| `packages/aai-server` (second half) | 45 | 9,483 | 7 | 7 |
| `packages/aai-studio-server` | 34 | 8,567 | 9 | 7 |
| `packages/aai-studio-client` | 26 | 4,739 | 5 | 9 |
| `packages/aai-templates` + `aai-evals` | 39 | 10,640 | 11 | 8 |
| **Total** | **480** | **~106,000** | **121** | **109** |

## The seven that matter most

Ordered by what they cost if left alone. The first three were reproduced by
execution.

### 1. The two flagship SSRF redirect tests make zero fetch calls

`packages/aai/host/ssrf-redirects.test.ts:60` and `:76` are the tests named
"rejects redirect to private IP" and "rejects redirect to cloud metadata" — the
two threats the module exists for. Both start from
`https://public.example.com/`, which is NXDOMAIN. `ssrf.ts:208` resolves the
*initial* URL before the first `fetchFn` call, and `ssrf.ts:120` wraps a
resolution failure in the same `SsrfBlockedError("Blocked request: …")` the
guard raises — so `rejects.toThrow("Blocked")` is satisfied by the DNS lookup,
not by the redirect screening. Reproduced against the real module:

```text

### fetch call count: 0

### error: Error: Blocked request: DNS resolution failed for public.example.com
```

**Redirect re-screening to `127.0.0.1` and to the cloud-metadata address
`169.254.169.254` is covered by nothing.** Delete the guard from `ssrfSafeFetch`
entirely and both tests stay green. The sibling three tests down already knows
the fix — `ssrf-redirects.test.ts:92` carries the comment "Use a public IP
literal to avoid DNS lookups". Fix: start from a public IP literal, assert
`mockFetch` was called twice, and assert the error *type* (`SsrfBlockedError`)
rather than the substring `"Blocked"`, which every failure mode in the module
shares.

### 2. `restoreMocks: true` does not clear a `vi.fn()`'s call history

Four reviewers converged on this independently, in four packages. Proven by
probe: a module-level `const log = { warn: vi.fn() }`, test A warns, test B
warns nothing and asserts `expect(log.warn).toHaveBeenCalled()` — **test B
passes on test A's call** (call count entering test B: 1). A second probe shows
an implementation primed at module scope with `mockReturnValue` is *also* still
primed in test B. `restoreMocks` registers only `vi.spyOn` mocks for restore; it
touches neither the history nor the implementation of a plain `vi.fn()`.

The consequence is a false-green class: any `expect(mock).toHaveBeenCalled()` on
a module-level `vi.fn()` is satisfied by an *earlier test in the same file*.
Confirmed live instances, where deleting the logging or the call under test
leaves the suite green:

- `packages/aai/host/workflow-client.test.ts:162` and `:474`
- `packages/aai/host/workflow-api.test.ts:343`
- `packages/aai-cli/workflow.test.ts:88` and `:154`
- `packages/aai-cli/_dev-server.test.ts:161`, `:439`, `:456-464`
- `packages/aai-server/workflow-webhook-handler.test.ts:228` (a
  `toHaveBeenCalledTimes(1)` that counts every spawn since the file started — a
  statement about file order, not about the case)

**The misconception is committed in the tree**, which is how it spread:

```text
packages/aai-cli/_dev-server-test-utils.ts:41-43
  /**
   * Re-prime the default implementations. `restoreMocks: true` wipes them
   * between tests, so call this from `beforeEach` (both files already do).
   */
```

It is false on both counts. A second comment teaches the same wrong mechanism at
`packages/aai-server/sandbox-resolve.test.ts:300-303`. The *correct* note has
been in the tree all along, at `packages/aai/host/_test-utils.ts:196` — and its
remedy is the one to copy repo-wide: `silentLogger` is built from **plain no-ops
rather than `vi.fn()`s**, so `toHaveBeenCalled` on it fails loudly and names the
reason instead of quietly passing.

Ten test files hold a module-level `vi.fn()`, assert `toHaveBeenCalled`, and
clear nothing anywhere in the file (6 in `aai`, 4 in `aai-cli`). The fix is at
the harness: clear call history in `primeDevServerMocks()`
(`packages/aai-cli/_dev-server-test-utils.ts:47`) and correct both comments.

### 3. 57 of 456 unit-tier files break the membership rule

AGENTS.md cuts tiers by what a test may TOUCH: "Unit — no filesystem writes,
subprocess, or real network." Files carrying no `.scenario.`/`.integration.`/
`.eval.` infix that nonetheless do:

| | files |
| --- | --- |
| bind a real TCP port (`listen(0`) | 15 |
| write to the filesystem (`mkdtemp`/`writeFile`) | 44 |
| spawn a subprocess (`spawn`/`execFile`) | 4 |
| **distinct files** | **57** |

By package: `aai-cli` 18, `aai` 16, `aai-guest` 13, `aai-server` 6,
`aai-studio-server` 2, `aai-templates` 1, `aai-studio-client` 1. (Two `aai-cli`
files that mock `node:fs` are excluded; the documented exceptions —
`agent-server-integration.test.ts`, `aai-cli`'s two `integration*.test.ts`,
`worker-bundler.test.ts` — are excluded from the reading below but not from the
count.)

The symptom is already in the tree as compensating scaffolding: `aai-guest`'s
`studio-test.test.ts` and `studio-build.test.ts` hand-write `timeout: 120_000`
per test — *that is the scenario tier's timeout, re-declared because the tier
was not used*. `packages/aai/host/server.test.ts:11-28` carries a 20-line
comment about a ~3s socket park "that intermittently blew this file's 5s default
budget". `aai-guest/studio-chat.test.ts:156-162` stubbed out a real `typecheck`
because it "alone blew this file's 5s budget". This is precisely the failure
AGENTS.md predicts when timeout is used as a proxy for tier.

**And renaming does not fix it in five packages.** A rename to
`*.scenario.test.ts` only moves a file if the package's `vitest.config.ts`
excludes that infix from the unit run. Five of nine do not: `aai-evals`,
`aai-guest`, `aai-studio-client`, `aai-templates`, `aai-ui`. None currently owns
an infixed file, so **the gap is latent — it bites the first person who does the
right thing.** Only four packages declare `check:scenario` at all. Relocating
one `aai-guest` test therefore costs four coordinated edits (rename, vitest
exclude, package script, turbo wiring), and that cost is why 57 files drifted
instead of one being moved.

The convention's whole selling point in AGENTS.md is that "a new slow test lands
in the right tier with no config edit". That holds for routing a *correctly
named* file and for nothing else: **nothing checks that a test's name matches
what it touches.** There are 32 scripts in `scripts/` and 15 gates in
`check.sh`; none of them looks at this.

### 4. Four gate gaps, one family: regex guards blind to a syntactic variant

| Gap | Live occurrences |
| --- | --- |
| `as never` is absent from `check-escape-hatches.mjs`'s `PATTERNS` | **110 in tests** (115 repo-wide) |
| Rule 3's `Promise\.race\(.*setTimeout` is line-anchored | 3 multi-line |
| Rules 4 and 19 require a literal `(` after `new Promise` | 5 with a `<T>` type argument |
| Rules 4 and 19 do not know `setImmediate` | 8 |

**`as never` is the one that matters.** It is the dominant type-laundering idiom
in this repo's tests — 110 occurrences against 62 of the counted `as unknown as`
— and it is strictly worse than the pattern the ratchet *does* count: `never` is
assignable to everything, so `{ … } as never` passes any parameter position, and
like `as unknown as` it **stops reporting when a field is added** to the type it
is standing in for. Between 2026-08-12 and 2026-08-15 it went 98 → 110 while the
counted pattern went 63 → 62. The concentrations are where the seam is missing:
`web-search.test.ts` (13 `{} as never` for a `ToolContext` that has a builder at
`host/_test-utils.ts:53`), `runtime-transport.test.ts` (13 on whole options
objects, so a renamed or newly required option on the very builder under test
compiles silently).

Rule 4's own comment celebrates fixing a version that "reported 0 against five
real occurrences". **The fixed version still reports 0 against five different
real occurrences**, for an adjacent reason — a type argument breaks
`new Promise\(`. This is the fourth and fifth time this trap has been paid for
in this repo, and the pattern across all four gaps is the same: a *substring*
guard over a language with syntax.

These are self-concealing in the way AGENTS.md warns about. Rule 3's
gate-under-the-gate feeds it a **single-line** positive sample
(`guard-invariants-gate.test.ts:196`), so the guard passes while the rule is
blind to the multi-line form Biome actually produces.

**And the escape-hatch gate's own spec cannot tell whether six of its seven
patterns are dead.** `escape-hatch-scope.test.ts:111` asserts an aggregate
`hits.length > 0` across all seven patterns at once. Measured against its
corpus: `as any` matches one line and the other six match **zero** — so one live
pattern satisfies the whole suite. Narrow six of them to something that matches
nothing and the gate reports `now=0 ✓` over a tree full of violations while the
spec stays green. That is the same bug AGENTS.md records paying for with the
`\b` patterns, and **this file is their home**. Worse, both baseline-gate specs
validate patterns with `new RegExp(re)` — JavaScript — while `_ratchet.mjs`
ships them to `git grep -nIE` (POSIX ERE, whose GNU-extension support varies by
build, which is exactly why `\b` was dead on some machines and not others).
`guard-invariants-gate.test.ts:401` mitigates with an explicit `\b` ban;
`escape-hatch-scope.test.ts` has **no `\b` assertion at all**.

The same shape sits under `check:file-length`: it carries **no corpus floor**
(its three sibling gates all do), so an empty `git ls-files` result prints
`all files within caps ✓` and exits 0 — and `git ls-files "scripts/*.ts"` and
`"scripts/**/*.ts"` **both resolve to 0 files today**, so two of the five globs
its gate spec asserts are already inert. The spec checks that the pathspec
*strings* appear in the source, never that they resolve.

Guard rules 1, 7 and 10 are enforced by no sample and no corpus floor at all:
their scanners derive a corpus from `git ls-files` and return only `found`,
never the file count, so a directory rename makes them report zero findings —
byte-identical to the rule being upheld. **Rule 7 is the supply-chain pin that
keeps a floating `@v7` tag out of the release job's npm token**, which makes it
the one rule here where a silent zero has a security consequence.

### 5. Five of eight property suites declare no coverage floor

AGENTS.md makes hand-rolled floors mandatory, because "an all-green property
proves nothing about a state the generator never entered". Present in `aai`
(`s2s-fuzz` 26 references, `pipeline-fuzz` 16) and `aai-studio-server`
(`studio-concurrency-fuzz` 6, at ~3.5x and ~8x below recorded actuals — the
model to copy). **Absent from all five `aai-ui` suites**: `fuzz-voiceio`,
`fuzz-hooks`, `fuzz-reconnect`, `fuzz-session-core`, `worklets/audio-stress`.

That is the package whose own guide documents the exact vacuous-run hazard. The
concrete case: in `fuzz-voiceio.test.ts:160-174`, if `playNode()` ever returns a
node the host is not driving, `lastDoneTurn()` yields `null`, the legitimacy
check short-circuits on `entry.turn === null`, **every settle is "legitimate",
L2 asserts nothing, and 200 runs report green.** `postDrainStop` has the same
`turn === null` escape, so the drain-stop race can go unexercised in every run.
`fuzz-reconnect.test.ts:194-215`'s `checkBrokerLatch` has three early `return`s
and the same exposure.

Two floors in `aai` also carry no measured actual
(`pipeline-fuzz.integration.test.ts:562-563`), and twelve of thirteen in
`s2s-fuzz.integration.test.ts:272-300` record none — in a file whose header
documents three floors flaking at 7.5% and prescribes re-measuring, which nobody
can do for a floor with no recorded baseline.

### 6. The seventh hand-rolled PRNG

AGENTS.md: "Six hand-rolled mulberry32/xorshift copies and their
`for (seed = 1; seed <= N)` loops are gone; **do not add a seventh.**" Exactly
one survives repo-wide, and it is in a test:
`packages/aai/host/transports/pipeline-history.test.ts:228` — an LCG
(`state * 1_103_515_245 + 12_345`) driving a 400-iteration property over turn
shapes. It forfeits shrinking on the one bug class the test exists for (`capLlm`
orphaning a `tool` message), so a failure reports iteration 287 of a fixed walk
rather than the minimal turn-shape sequence.

### 7. A pre-release integration gate that has never executed in either arm

`packages/aai/host/integration/pipeline-reference.integration.test.ts:42-90`
gates on all three of `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY` and
`OPENAI_API_KEY` (line 44) — then builds `createRuntime({ env })` carrying only
the first two (lines 79-84) while declaring `llm: openai(...)` at line 88.
`resolveLlm` reads the agent env only and throws on absence, and the file's own
comment says the point is to exercise "the same resolution path (and API-key
routing) a deployed agent takes" — which is exactly what makes it throw
`OpenAI LLM: missing API key` at `session.start()`. The shell export named in
the README is not a fallback path; `withHostCredentialFallback` is opt-in and
unused here. The other arm is dead too: `fixtures/` holds only `README.md`, so
line 49 throws first.

## What is in good shape

Stated plainly, so the sweep is not read as uniformly negative — the teardown
ratchets did their job, and the numbers are the evidence. Counted across all 482
test files:

| | count |
| --- | --- |
| dead `spy.mockRestore()` / `vi.restoreAllMocks()` | 6 |
| `vi.unstubAllEnvs()` | 0 |
| `as any` | 0 |
| hardcoded `/tmp` | 0 |
| `delete process.env.X` | 1 (the baselined CLI scrub) |
| `Promise.withResolvers()` | 67 in 37 files |
| `test.each` / `it.each` | 159 in 81 files |
| `vi.waitFor` | 385 in 67 files |
| `vi.mocked` | 59 in 23 files |
| files over the 700-line test cap | 0 (allowlist is empty by design) |

The dead-teardown campaign AGENTS.md describes is essentially finished: what
survives is six lines. Several reviewers went looking for the pattern and found
that nearly every candidate was **live** rather than dead — because
`restoreMocks` does not clear `vi.fn()`s (finding 2), a `mockClear()` next to a
`vi.fn()` is load-bearing, and `vi.useRealTimers()` / `vi.unstubAllGlobals()`
are outside `restoreMocks` and `unstubEnvs` entirely.

One gap that number hides: **`expect.assertions` is used zero times across
11,663 `expect()` calls**, which is what leaves the "an `expect` inside a
callback that never runs" class unguarded.

## Three corrections to AGENTS.md itself

Found by the sweep, in the file that specifies the sweep's own criteria. Part II
adds a fourth and a fifth.

1. **`AGENTS.md:9` names an enforcing test that does not exist.** The sentence
   "never paste content into `CLAUDE.md` (`agents-md-shim.test.ts` fails if you
   do)" cites a file that is not in the tree — `git ls-files` finds nothing, and
   that line is the only occurrence of the name in the repository. The behaviour
   *is* enforced, by `packages/aai-templates/claude-md-limit.test.ts:115` and by
   `check-claude-md.mjs`, so this is a doc defect rather than a coverage hole.
   It matters because that parenthetical is the whole reason an author believes
   the rule is checked.
2. **The `aai-studio-client` row of the "Vitest config differences" table is
   stale.** `AGENTS.md:1367` records the package as
   `node | .tsx tests via react-dom/server (no jsdom)`. **18 of its 26 test
   files carry `// @vitest-environment jsdom` on line 1.** Effects, clicks,
   timers, `beforeunload`, clipboard and fake-timer poll loops are all genuinely
   exercised there. The briefing for that slice repeated the stale claim and the
   reviewer refuted it with evidence, which is the system working.
3. **The `_test-utils.ts` inventory omits `aai-studio-client`**, though
   `packages/aai-studio-client/src/_test-utils.ts` exists with four shared
   helpers.

The judgement the guides should carry, from that reviewer: node is the default
and jsdom is a per-file pragma; interaction behaviour belongs in a pragma'd
file. It costs nothing in coverage — a `.tsx` test that forgets the pragma fails
loudly on `document is not defined`, never silently.

## Recommended order of work

**Superseded by "Revised order of work" at the end of Part II** — two CI-level
defects found there outrank everything here and cost minutes to fix. This list
remains the right order for the test findings themselves.

1. **`ssrf-redirects.test.ts`** (finding 1) — a security guard covered by
   nothing, one file, ~20 lines.
2. **The two false comments about `restoreMocks`** (finding 2) and the harness
   fix in `primeDevServerMocks()`. Cheap, and it stops the misconception
   spreading further while the eight live instances are fixed.
3. **Add `as never` to `check-escape-hatches.mjs`'s `PATTERNS`, and widen rules
   3/4/19** (finding 4). Then `--update` the baseline: the count is the
   campaign, exactly as it was for `as unknown as`.
4. **Coverage floors on the five `aai-ui` property suites** (finding 5).
5. **A tier-membership gate** (finding 3) as `guard-invariants` rule 20 —
   AGENTS.md's own advice is that a new ratchet there costs no new script, no
   new baseline file, no CI wiring and no new gate-under-the-gate spec. Land the
   five missing `vitest.config.ts` excludes in the same change, or the gate's
   remedy is unavailable in five packages.
6. Everything below, per package.

---

## Findings by slice

### `packages/aai/sdk` — 47 files, 7,028 lines

#### aai/sdk — correctness

1. **"Two concurrent calls cannot lose an append" contains no concurrency** —
   `sdk/session-slot.test.ts:472`. `updateTool` bodies are enforced synchronous
   (`session-slot.ts:203`, pinned by this file at `:502`), so both `execute`
   calls complete during array-literal evaluation, before `Promise.all` is
   entered. Behaviourally identical to the sequential test at `:466`; the
   read-then-write-across-an-await regression named in its comment is
   unobservable here.
2. **"Attaches no listener at all without a signal" asserts nothing about
   listeners** — `sdk/sleep.test.ts:69`. Byte-for-byte the claim of the file's
   first test. The sibling at `:59` spies `removeEventListener`; this one
   observes no `addEventListener`, so a leak on the no-signal path passes.
3. **`agentToolsToSchemas` is tested for the two fields it copies verbatim, not
   for the conversion it is named for** — `sdk/_internal-types.test.ts:22`.
   `parameters: toToolJsonSchema(...)` (`_internal-types.ts:46`) is never read,
   so neither the wiring nor the `EMPTY_PARAMS` fallback is covered, and the
   `parameters`-rename guard at `:37-41` is untested.
4. **A type-assignability claim backed only by runtime property-presence
   checks** — `sdk/schema-alignment.test.ts:65`. Three `toHaveProperty` calls on
   a value zod just parsed with those three keys; they cannot fail without the
   test at `:48` failing first. Narrowing `ToolSchema["parameters"]` past what a
   parse result satisfies slips through. Needs `expectTypeOf`.
5. **Four bare `toThrow()` where every sibling names its message** —
   `sdk/config-rules.test.ts:133`, `:184`, `:211`, `:212`. Passes on any throw,
   including one from an unrelated field in the shared `pipelineFields` fixture.
   The regression: the non-positive-`silenceTimeoutMs` and `minBargeInWords < 1`
   guards deleted while earlier validation happens to reject the same object.
6. **The date assertions depend on the runner's timezone, which nothing pins** —
   `sdk/system-prompt.test.ts:18`, `:29`, `:240`. `buildSystemPrompt` calls
   `toLocaleDateString` with **no `timeZone` option** (`system-prompt.ts:338`).
   The frozen `12:00:00Z` gives ±12h of slack — enough for common CI regions,
   not for UTC+13/+14 (Auckland in DST, Tonga, Samoa, Kiritimati), where it
   renders as the next day.
7. **`lock.size` assertions gated on an arbitrary five-microtask drain** —
   `sdk/keyed-lock.test.ts:7`, consumed at `:45`, `:57`, `:71`, `:80`, `:108`,
   `:131`, `:140`, `:150`. `flushMicrotasks` yields exactly five times, matching
   the lock's current cleanup-chain depth; one added `await` turns every
   assertion into a failure that reads as a per-key leak.
   `vi.waitFor(() => expect(lock.size).toBe(0))` states the invariant instead of
   the turn count.
8. **A byte-identity assertion done as a substring match over comma-joined
   numbers** — `sdk/step-fetch.test.ts:190`. `[...body].join(",")` `toContain`
   `[...bytes].join(",")` matches a body whose run was
   `[10, 128, 255, 254, 127]` — the first byte can be wrong and it still passes.

#### aai/sdk — quality

1. **A local `stubGateway` re-implements the published one this slice owns** —
   `sdk/step-generate.test.ts:27`. `stubGateway` from `./testing-gateway.ts` is
   exported as `@alexkroman1/aai/testing`, has its own spec, and is used exactly
   this way by `step-generate-json.test.ts:10`. The copy shadows the name and
   needs a second `sent()` helper (`:43`) to re-parse what the shared fake
   records structurally.
2. **A tool context spelled `{} as never`** — `sdk/define.test.ts:25`.
   `createToolContext()` is published and already imported by two files in this
   same directory.
3. **Dead teardown that hand-copies a module-private symbol** —
   `sdk/step-generate.test.ts:20`. `Symbol.for("@alexkroman1/aai.stepEnv")`
   duplicates the unexported `STEP_ENV_SLOT` (`step-env.ts:47`), and the
   `afterEach` deletes a global this file never publishes.
4. **The same symbol copy again, as the only available unpublish** —
   `sdk/step-env.test.ts:17`. Here the delete is load-bearing, which makes it
   worse: rename `STEP_ENV_SLOT` and both `afterEach`es silently no-op. The fix
   belongs in the module — an `undefined`-accepting `publishStepEnv`, matching
   `publishStepFetch(undefined)` / `publishUploadReader(undefined)` /
   `publishStepReporter(undefined)`.
5. **`sleep` imported through the host graph from an `sdk/` unit test** —
   `sdk/keyed-lock.test.ts:3`. `host/_test-utils.ts` re-exports it while itself
   importing `createRuntime`, `assemblyAIS2s` and `node:fs`. The sibling
   `coalescing-runner.test.ts:13` declines the host import for this reason.
6. **`Promise.race` against a timer — guard rule 3** —
   `sdk/keyed-lock.test.ts:39`. The intent (fail with a reason rather than hang)
   is right; `pTimeout(lock("b"), { milliseconds: 50 })` keeps it and drops the
   dangling timer.
7. **Four `for…of` loops that hide which case failed** —
   `sdk/step-generate.test.ts:140`, `:148`; `sdk/system-prompt.test.ts:218`;
   `sdk/utils.test.ts:123`. None shares expensive setup or labels via
   `expect.soft`. (`ws-upgrade.test.ts:61`/`:80` and `system-prompt.test.ts:274`
   are correctly exempt — they use the labelled form.)
8. **`let settled = false` flipped inside an async reporter** —
   `sdk/step-report.test.ts:18`. Also redundant with the `toEqual` on the next
   line.
9. **Two local wait/deferred aliases in one file** —
   `sdk/coalescing-runner.test.ts:11` (`gate` = `Promise.withResolvers`) and
   `:18` (a verbatim re-implementation of the exported `tick()`). If the
   host-graph weight is the real constraint, `tick`/`flush` belong beside
   `sleep` in `sdk/`.

#### aai/sdk — cleared

- `protocol.test.ts:57` vs `protocol-snapshot.test.ts:82` looked like a direct
  contradiction; refuted — `toBeValidSessionEvent` stamps a `meta` envelope
  first, so they assert different inputs.
- `protocol-compat.test.ts` reads fixtures at module scope in the 5s tier; the
  tier rule is filesystem *writes*, and it already guards the
  `describe.each([])` vacuity case at `:53`.
- `exports.test.ts` cold-imports 15 subpath barrels under a 30s override;
  in-memory module load, argued in-file at `:25`.
- `workflow-api-client.test.ts:362` reads as "expected derived from actual";
  only the *length* comes from the actual.
- `sleep.test.ts:5` / `system-prompt.test.ts:32` trailing `vi.useRealTimers()` —
  fake timers are outside `restoreMocks`.
- `step-retry.test.ts:26` / `step-errors.test.ts:51` wall-clock `Date.now()` —
  5,000ms and 1,000ms tolerances against synchronous computation, not timer
  windows.
- Escape hatches: two baselined casts, no `as any`, no `@ts-expect-error`.
  Largest file 542 lines against the 700 cap.

### `packages/aai/host` (a–l) — 38 files, 8,343 lines

#### aai/host (a–l) — correctness

1. **Two "shutdown warns …" tests assert nothing about the warn** —
   `host/runtime-lifecycle.test.ts:61`, `:79`. Both pass `logger: makeLogger()`
   as a literal argument, never binding it; their only `expect` is on
   `connectSpy`. Deleting the warn call, or swallowing the rejection silently,
   leaves both green — the only regression they can catch is `shutdown()`
   throwing.
2. **"Multiple rapid closes don't double-invoke stop()" closes the socket once**
   — `host/cleanup.test.ts:72`. `ws.close()` appears a single time at `:79`;
   remove the double-close guard entirely and it still passes. The
   `stop: vi.fn(() => sleep(50))` setup shows the intended shape.
3. **"visit_webpage follows redirects without re-validating target" involves no
   redirect** — `host/builtin-tools.test.ts:467`. The fake returns a plain
   `200`; the URL is only *named* "redirect". Adding or removing redirect
   re-validation is invisible.
4. **`expect.any(String)` swallows the two settings the log exists to pin** —
   `host/runtime.test.ts:678`. The STT block is pinned against real constants;
   `llm` is `{ model: expect.any(String) }` and `tts`
   `{ voice: expect.any(String) }`. `packages/aai/CLAUDE.md`: "a settings log
   that can drift from the wire is worse than no log, because it is believed."
   `ASSEMBLYAI_LLM_DEFAULT_MODEL` and `ASSEMBLYAI_TTS_DEFAULT_VOICE` are
   exported.
5. **Five tests name a behaviour and assert only that a constructor returned an
   object** — `host/runtime-lifecycle.test.ts:325`, `:340`, `:365`, `:374`,
   `:384`; also `host/runtime.test.ts:309`, `host/server.test.ts:182`. Dropping
   `skipGreeting` on the floor, or ignoring `sessionStartTimeoutMs`, is exactly
   the silent-config-drop class the package guide devotes a section to. Sibling
   coverage exists at `runtime-lifecycle.test.ts:461`, which is the shape the
   others need.
6. **"Message buffer is cleared when start() fails" checks the session map, not
   the buffer** — `host/cleanup.test.ts:58`. Its only assertion duplicates the
   test two above; the claimed behaviour is the unasserted `ws.simulateMessage`
   at `:69`.
7. **Four socket helpers settle only on the happy path, so a regression hangs to
   the tier timeout** — `host/host-server.test.ts:44`,
   `host/server-workflow-app.test.ts:82` and `:102`,
   `host/agent-server.test.ts:58`. `host-server.test.ts`'s whole premise is that
   a rejected handshake writes a frame *and closes*; a change that reports the
   error and leaves the socket open turns all five tests into 5s timeouts naming
   nothing.
8. **"Close resolves quickly" is a wall-clock assertion against a synchronous
   mock, and its suite never exercises a timeout** —
   `host/server-shutdown.test.ts:38`. `mockShutdown` is
   `mockResolvedValue(undefined)`, so `elapsed < 1000` can only fail from CI
   jitter. The `describe` is named "server shutdown timeout" and no test
   supplies a shutdown that hangs.
9. **An orphan `attachSessionStream` whose core is never started** —
   `host/runtime-session-stream.test.ts:39`. Discarded on the next line; reads
   as setup that matters and is not.
10. **A handler passed to a fixture that never emits** —
    `host/session-emitter.test.ts:62`. Hence the `void emitter;` at `:89`; the
    assertion at `:84` is satisfied entirely by the second emitter's own handler
    at `:76`.

#### aai/host (a–l) — quality

1. **Seven files bind a real TCP port (two also write files) in the 5s unit
   tier** — `_ws.test.ts:31`, `agent-server.test.ts:25`,
   `host-server.test.ts:35`, `server.test.ts:103`/`:240`,
   `server-static.test.ts:39`/`:54`, `server-workflow-app.test.ts:80`,
   `server-shutdown.test.ts:23`. See headline finding 3; the symptom is already
   visible in this package as `server.test.ts:11-28`'s 20-line comment and
   `server-shutdown.test.ts`'s three `10_000` overrides.
2. **`as never` on whole options objects, invisible to the ratchet** —
   `host/runtime-transport.test.ts` (13 occurrences),
   `runtime-tools.test.ts:74`/`:108`/`:140`/`:169`,
   `runtime-lifecycle.test.ts:50`/`:69`/`:92`/`:344`/`:359`. A renamed or
   newly-required option on the builder under test compiles silently — the
   dropped-field class `runtime-transport.test.ts`'s own header describes. The
   repo's idiom is one narrowing helper per builder (`asSessionWs()`,
   `fakeFetch()`).
3. **Eleven hand-rolled microtask yields where `flush()` is the documented
   helper** — `host/host-mode.test.ts:236`, `:286`, `:326`, `:356`, `:383`,
   `:401`, `:419`, `:438`, `:470`, `:494`, `:573`.
4. **Four local logger factories shadow the exported `makeLogger()`** —
   `runtime.test.ts:29`, `runtime-lifecycle.test.ts:32`,
   `runtime-providers.test.ts:18`, `server-static.test.ts:25`. Two files in the
   same directory already import it.
5. **`let began` + `new Promise` instead of `Promise.withResolvers()`** —
   `host/server.test.ts:86`. The one holdout; five sibling files already comply.
6. **A real 50 ms sleep with no stated invariant** —
   `host/runtime-lifecycle.test.ts:56`. Nothing explains what it buys and
   nothing observes a timer window.
7. **`lastSent()` returns the FIRST send** — `host/_s2s-test-utils.ts:102`
   (`calls[0]`), consumed by ~13 assertions in `s2s.test.ts`. Correct today only
   because every caller sends once; the first spec to send twice gets the wrong
   frame while reading like it asked for the newest.
8. **Two module-private constants hand-mirrored into tests** —
   `builtin-tools.test.ts:8`, `host-mode.test.ts:150`. Both fail loudly on drift
   today, but this is the pattern the package guide records failing twice with
   the voices list.
9. **`makeMockWs()` duplicates a slice of `_mock-ws.ts`** —
   `host/runtime-lifecycle.test.ts:36`. Using `MockWebSocket` also removes five
   of the `as never` casts above.
10. **Module-level mock reassigned in `afterEach` rather than `beforeEach`** —
    `host/server-shutdown.test.ts:8`, `:28`. The first test runs against
    whatever the module initializer left.

#### aai/host (a–l) — cleared

- `_ws.test.ts:26` handshake ordering — `negotiated.push()` runs inside
  `handleUpgrade`'s synchronous callback. Not a race.
- `postgres-db.test.ts:16`'s `vi.clearAllMocks()` — load-bearing, per headline
  finding 2.
- Every `vi.useFakeTimers()`/`useRealTimers()` pair — outside
  `restoreMocks`/`unstubEnvs`, so required.
- `server.test.ts:107`'s `closeMs < 1500` — its 22-line doc records the mutation
  testing that made it discriminate (~100ms passing vs ~3s regressed).
- `audio-pacer.test.ts` and `session-core.test.ts`'s idle block — already fully
  on `advanceTimersByTime`; `:492` already uses `test.each`.
- `builtin-tools.test.ts:419` ("two concurrent remember calls") — cannot
  distinguish concurrent from sequential, but its comment says why (synchronous
  `Map` writes) and the value is documenting that no lock is needed.
- `runtime.test.ts` at exactly 700 lines — the gate fails on `> cap`, so it is
  at the ceiling, not over it.

### `packages/aai/host` (m–z) + `aai/*.ts` — 39 files, 8,967 lines

#### aai/host (m–z) — correctness

1. **Two SSRF redirect tests never reach the redirect path — they pass on a DNS
   failure** — `host/ssrf-redirects.test.ts:60`, `:76`. See headline finding 1;
   reproduced by execution.
2. **`silentLogger` is a module singleton, so the listing-warn assertion is
   satisfied by an earlier test** — `host/workflow-client.test.ts:45`, asserted
   at `:162` and `:474`. See headline finding 2.
   `ws-handler-lifecycle.test.ts:392` already carries a comment explaining
   exactly this and does it correctly.
3. **The closing `vi.waitFor` in the start-timeout resume race waits for a
   condition already true** — `host/ws-handler-resume.test.ts:185`. `:182` has
   already asserted the same expression, so the waitFor passes on its first
   synchronous poll before the stop's continuation runs. A settled stop's
   cleanup key-deleting the entry lands after the waitFor returned.
4. **Three `resolveAndAssertPublic` "allows" tests silently become no-ops
   without DNS** — `host/ssrf.test.ts:154`, `:165`, `:176`. Each opens
   `try { await requireDns() } catch { return }`; in a network-less leg all
   three return before their single assertion and report green. Nothing
   announces the skip and no `AAI_REQUIRE_*` covers it. The assertion is also
   weak — `resolves.toEqual(expect.any(String))` passes for `""`.
5. **Two `web-search` fallback tests assert only that the result is an array** —
   `host/web-search.test.ts:72`, `:82`. Neither asserts the lite endpoint was
   dialled. A 429 returning `[]` without attempting the fallback keeps both
   green while the tool reports "the web has nothing". The correct sibling at
   `:52` asserts `toHaveBeenCalledTimes(2)` and the actual rows.
6. **Fake timers leak out of a failing timeout test** —
   `host/tool-executor.test.ts:112`, `:122`. Top-level in the test body; if
   `:121` fails the restore never runs and the five later cancellation specs run
   on a clock nothing advances. The sibling 55 lines below wraps the identical
   pattern in `try`/`finally`.
7. **"The infrastructure cause reaches the LOG" is satisfied by the preceding
   test's identical log call** — `host/workflow-api.test.ts:343`. See headline
   finding 2. The body-redaction half still discriminates.
8. **Two ws-handler specs observe a start-timeout window on the wall clock** —
   `host/ws-handler-resume.test.ts:160`+`:181` (`sessionStartTimeoutMs: 30`,
   `sleep(60)`), `host/ws-handler-lifecycle.test.ts:411`+`:416`. The window
   under test has to shrink to a value the product never uses, and the flake
   names a timing spec rather than a bug.
9. **"State ACCUMULATES across the drop" synchronizes on a fixed sleep, not the
   frame it names** — `host/session-resume-state.scenario.test.ts:252`.
   `client.waitFor(type)` scans all frames recorded so far (`:171`), so the
   second call returns the resume snapshot `:249` already consumed. The real
   arrival is guaranteed only by a hard-coded `sleep(100)` inside `addItem`.
   `waitFor` needs a since-index or a count predicate.
10. **A stubbed global `fetch` outlives its test** —
    `host/workflow-install.test.ts:72`, `:82`. `vitest.shared.ts` sets
    `unstubEnvs` but **not** `unstubGlobals`, so the last stub remains installed
    for the two remaining tests, which call `install()` against a `fetch`
    answering every request with `Response("global")`.

#### aai/host (m–z) — quality

1. **Eight unit-tier files bind ports, write temp files, or spawn — and
   `exports-no-dev-deps.test.ts` runs `pnpm build`** —
   `aai/exports-no-dev-deps.test.ts:83`; also `host/workflow-serve.test.ts:210`,
   `workflow-api.test.ts:96`, `workflow-api-uploads.test.ts:50`,
   `ssrf-dispatcher.test.ts:37`, `workflow-install.test.ts:30`,
   `workflow-uploads.test.ts:42`, `workspace-files.test.ts:25`. The root file is
   the sharpest: `execFileSync("pnpm", [… "build"])` with a 60s budget inside a
   5s tier, reachable because `turbo.json`'s `test` declares only `^build`,
   never `aai#build` — the same failure `ensure-guest-harness.mjs` was changed
   to refuse.
2. **`let settled = false` flipped in a `.then()`** —
   `host/workflow-api-wait.test.ts:85`. The `void`ed promise also turns a
   rejection into an unhandled rejection rather than a failure.
3. **A hand-rolled `Promise.race` + `setTimeout` that guard rule 3 cannot see**
   — `host/ssrf.test.ts:146`. `Promise.race([` is on `:148` and `setTimeout` on
   `:150`; the rule is line-anchored. See headline finding 4.
4. **Eight files build a module-level `vi.fn()` logger instead of `makeLogger()`
   per test** — `workflow-client.test.ts:45`, `workflow-api.test.ts:28`,
   `workflow-notify.test.ts:19`, `workflow-api-uploads.test.ts:24`,
   `workflow-wake-hint.test.ts:46`, `tool-call-repair.test.ts:23`,
   `tool-call-salvage.test.ts:8`, `text-agent.test.ts:27`. Two are live defects;
   the rest are latent. `text-agent.test.ts` is the worst shape — a *local*
   `silentLogger` built from `vi.fn()`s, shadowing the shared export whose doc
   exists to say that this exact construction caused two suites to assert
   against another test's history.
5. **Thirteen `{} as never` stand-ins for `ToolContext`** —
   `host/web-search.test.ts:43,55,67,78,89,96,106,122,143,160,178,191,198`.
   `createMockToolContext()` is at `host/_test-utils.ts:53`. See headline
   finding 4.
6. **Dead teardown** — `host/workflow-serve.test.ts:329`,
   `host/workflow-world.test.ts:116`. Both `mockRestore()` a
   `vi.spyOn(console, …)` that `restoreMocks` already restores.
7. **`toBeLessThanOrEqual` where the contract is an exact count** —
   `host/ssrf-redirects.test.ts:108`. `MAX_REDIRECTS` is 5 and the comment says
   so; the assertion would also pass at 1.
8. **`tool-call-repair.test.ts` re-tests through a `vi.mock("ai")` that its
   sibling covers with the real thing** — `host/tool-call-repair.test.ts:10`.
   The mock replaces `NoSuchToolError` with a sentinel, so `:53` exercises the
   stub; `tool-call-salvage.test.ts:197` drives the same branch with a real
   `NoSuchToolError` and a real `MockLanguageModelV3`. Folding the two unique
   abort-signal tests across retires the module mock and its `as never` options
   builder.
9. **Two case loops that should be `test.each`** —
   `workflow-client.test.ts:227`, `workflow-serve.test.ts:232`.
   (`workflow-serve.test.ts:304` and `workspace-files.test.ts:61` do label, and
   are correctly left as loops.)
10. **`workflow-api.test.ts` is 697 lines against the 700 cap.** The next spec
    fails `check:file-length`; the natural seam is the `describe("wait")` block
    at `:601`.

#### aai/host (m–z) — cleared

- `ssrf-pinning.test.ts:76`'s `toBeDefined()` — the dispatcher's content is
  asserted directly against `pinnedLookup` in `ssrf.test.ts:342`.
- `ssrf.test.ts` address tables — already `test.each`; the property tests
  already use fast-check at `:492`.
- `workflow-api-events.test.ts`, `workflow-api-wait.test.ts`,
  `workflow-notify.test.ts` — all drive with `advanceTimersByTimeAsync`; no
  wall-clock waits.
- `session-resume.scenario.test.ts` — earns its infix, and carries the negative
  controls the class needs (1006 vs a clean close at `:227`, the "no
  `severAfter`" control at `:291`).
- `step-fetch.test.ts` module-scope arrays — every test resets the array it
  reads before acting.
- `ws-handler.test.ts` / `ws-handler-close-race.test.ts` — clean: fresh
  `makeLogger()` per test, `Promise.withResolvers()`, `tick()`/`flush()` from
  the shared helper, and `:366` explicitly upgrades a former not-throws test
  into three discriminating assertions.

### `packages/aai/host/transports` + `telephony` — 33 files, 9,138 lines

#### transports + telephony — correctness

1. **A test named for a global negative pins the opposite of shipped behaviour,
   and its comment contradicts the source** —
   `transports/s2s-transport.test.ts:499`. Titled "S2S never emits agent
   transcript partials", comment says `transcript.agent.delta` is "documented
   but unimplemented". `s2s-transport.ts:252` says the opposite in its own
   comment ("DOES arrive — re-measured against the live service") and wires it
   to `agent-transcript.updated`; `:247` also reports `.updated` on
   `onAgentTranscript(text, interrupted=true)`. The test fires only the
   non-interrupted form, so both real producers go untested — and the name
   actively tells the next reader not to look.
2. **The only test of `sessionConfig.history` asserts nothing about history** —
   `transports/pipeline-transport.test.ts:548`. Seeds two messages, then asserts
   `start()` does not reject. Delete
   `createPipelineHistory(sessionConfig.history)` (`pipeline-transport.ts:83`)
   and it passes; a resumed session would silently start with an empty prompt.
   The file already has the probe — `llmCalls(opts).calls[0]?.prompt`, used by
   seven siblings.
3. **A runtime test whose whole assertion is `toBeDefined()` on a literal two
   lines above** — `transports/types.test.ts:5`. `test("file compiles")` plus a
   dead `type _CB`. The only real check is the type annotation, which `tsc`
   already performs; its presence makes the transport contract *look* covered by
   the unit suite.
4. **`expect.any(Object)` swallows the args coercion the test is named for** —
   `transports/pipeline-transport.test.ts:346`. `toArgsRecord` returns `{}` for
   anything non-record (`sdk/utils.ts:288`), and `{}` satisfies
   `expect.any(Object)` — so the one documented coercion on this path is exactly
   what the matcher cannot see. `openai-realtime-transport.test.ts:361` and
   `:388` get it right with literals.
5. **The fallback string a test is named for is asserted as
   `expect.any(String)`** — `transports/openai-realtime-transport.test.ts:564`.
   Any string passes, including `""` and `"[object Object]"` — and this is the
   only text a client operator sees for a message-less service error.
6. **"Persists nothing" is checked with the weaker of the two probes the file
   already uses** — `transports/pipeline-turn.test.ts:567`. Asserts only that no
   `agent-transcript.committed` was reported; its sibling at `:418` proves the
   same claim properly by firing a follow-up turn and asserting
   `not.toContain("[interrupted]")` on the prompt. As written, `record: false`
   filler leaking into history passes.
7. **A negative matcher that any change satisfies** —
   `transports/pipeline-dead-air.test.ts:144`.
   `expect(spoken.join("")).not.toBe("Found it. ")` passes for the wrong phrase,
   an empty string, or a duplicate — it only rules out *no output*. Every other
   test in the file uses `toContain(DEAD_AIR_OPENING_PHRASE)`.
8. **`toBeTruthy()` on a call id the fixture pins exactly** —
   `transports/s2s-transport-fixtures.test.ts:86`. Correlating a result to the
   *right* call is the property that matters on a multi-call reply (as the same
   file's `:323` shows); any non-empty string satisfies this.

#### transports + telephony — quality

1. **The one pipeline spec file left observing timers on the wall clock** —
   `transports/pipeline-transport-speech.test.ts:1-196`. Every sibling calls
   `useVirtualTime()`; this drives dead-air cover with `deadAirCoverMs: 1`
   against `delayMs: 15` on real timers, and its own header admits the squeeze.
   `pipeline-voice-events.test.ts:627` is the worked conversion ("The SHIPPED
   window, not a 1ms stand-in for it"). The package guide's "deliberately NOT
   converted" list names only `s2s-transport.test.ts`'s five `sleep(5)` calls,
   so this is an omission rather than a decision.
2. **A hand-rolled LCG driving a 400-iteration property** —
   `transports/pipeline-history.test.ts:226`. See headline finding 6.
3. **Seven casts of `callbacks.reported(...)` back to a spy type it already
   has** — `pipeline-voice-events.test.ts:435`, `:465`;
   `pipeline-silence.test.ts:94`, `:113`; `pipeline-transport.test.ts:521`.
   `_transport-recorder.ts:32` already declares `EventSpy`. Both files use the
   right idiom elsewhere (`vi.mocked(...)` at
   `pipeline-voice-events.test.ts:86,114,593`).
4. **Three local re-implementations of `makeLogger()`, one shadowing
   `silentLogger`** — `pipeline-trace.test.ts:14`,
   `pipeline-llm-trace.test.ts:18`, `telephony/telephony-bridge.test.ts:16`.
   `pipeline-trace.test.ts` types its copy as `Logger`, erasing the spy type and
   forcing the double cast at `:20`. `telephony-bridge.test.ts` names its copy
   `silentLogger`, colliding with the shared export whose doc says "it is NOT
   for asserting on" — while these tests assert on it at `:179` and `:222`.
5. **`useVirtualTime()` re-implemented inline one directory from the helper** —
   `transports/pipeline-dead-air.test.ts:45`. Verbatim
   `_pipeline-transport-harness.ts:128-135`.
6. **Hand-rolled microtask yields where `flush()` is imported into sibling
   files** — `transports/openai-realtime-transport.test.ts:408`, `:425`.
7. **The `llmCalls()` seam bypassed by inline casts in the file that needs it
   most** — `pipeline-voice-events.test.ts:496`, `:553`. The harness exists for
   this and says so ("keep it at this one seam; the escape-hatch ratchet counts
   every occurrence").
8. **A 15-field `consumeLlmStream` options literal copied eight times** —
   `pipeline-llm-stream.test.ts:86,139,165,186,211,257,296,331`. Only two or
   three fields vary per test.

#### transports + telephony — cleared

- `s2s-transport.test.ts`'s five `sleep(5)` calls — explicitly listed in the
  package guide as queue-settle yields deliberately not converted.
- `pipeline-turn.test.ts:647` — the synchronous assertion after `fireFinal`
  looked premature; `pipeline-user-speech.test.ts:226` shows `onSttFinal` aborts
  synchronously.
- `pipeline-transport-barge-in.test.ts:349` — never asserts the LLM stream
  aborted, but `:452` proves it via `[interrupted]` reaching the next prompt.
- `telephony/mulaw.test.ts`, `resample.test.ts` — `KNOWN_DECODES` sourced from
  the G.711 table rather than the module, avoiding the self-consistency trap by
  design.
- `pipeline-preemption.test.ts:153` — the loop *compares* the two runs
  field-by-field, so both must share one test body.
- `pipeline-openai-replay.test.ts` — constructs a real provider but injects a
  capturing `fetch`; correctly unit-tier.

### `packages/aai/host/providers` + `integration` — 20 files, 5,815 lines

#### providers + integration — correctness

1. **The reference-stack integration test can never pass in either arm** —
   `integration/pipeline-reference.integration.test.ts:42`. See headline finding
   7.
2. **Nothing anywhere asserts what the Rime adapter dials** —
   `providers/tts/rime.test.ts:104`. The fake records `url` and `options`; the
   only assertion against either is `perMessageDeflate` at `:138`. A dropped
   Bearer prefix, a wrong param name, a wrong `samplingRate` (chipmunk audio at
   the right byte count), or a 2-letter `lang` where Rime takes ISO 639-3 all
   pass. Grep confirms `speaker=`, `samplingRate` and `users-ws.rime.ai` appear
   in no test in the repo. `tts/assemblyai.test.ts:51` is the model.
3. **The nine-way `resolveLlm` happy path asserts a property every AI SDK model
   has** — `providers/resolve.test.ts:97`.
   `toHaveProperty("specificationVersion")` is true of Anthropic, OpenAI and
   Groq alike, so swapping two `create` entries — or dropping the `(model(d))`
   application so the model id never reaches the client — passes for six of nine
   kinds. Only gateway, openrouter and assemblyai get a real `toMatchObject`.
4. **The ElevenLabs mock throws away connect options, so the sample-rate map is
   untested** — `providers/stt/elevenlabs.test.ts:22`. `AUDIO_FORMATS`
   (`elevenlabs.ts:47`) is a hand-written six-entry table; a wrong entry
   declares the wrong rate and produces garbled transcription with no error
   anywhere. `openSession(sampleRate)` takes the parameter and is never called
   with anything but the default. Deepgram's sibling captures connect args at
   `:16`/`:160`.
5. **A thrown streaming oracle skips `stop()`, leaking a live session through
   shrinking** — `integration/s2s-fuzz.integration.test.ts:319`. `runPlan` has
   no `try`/`finally`, and the harness's oracles throw from inside event
   delivery, so `stopAndCheckTeardown` never runs and that run's `SessionCore`,
   transport and sockets stay live for the whole shrink — the failure AGENTS.md
   names as converging the shrinker on the wrong counterexample.
   `pipeline-fuzz.integration.test.ts:391` has the same shape.
6. **A unit-tier test opens a real TCP listener** —
   `providers/stt/assemblyai-timeout.test.ts:15`, `:25`. Real `node:net` server
   plus the real SDK, a 50ms connect timeout and a real `sleep(50)` — the
   wall-clock margins are what make this more than bookkeeping.
7. **Two coverage floors carry no measured actual, in files whose whole thesis
   is that a floor sits ~3× below one** —
   `pipeline-fuzz.integration.test.ts:562`;
   `s2s-fuzz.integration.test.ts:272-300`, where twelve of thirteen record none.
   The one that does (`drop.withToolInFlight`, `:290`) sits at floor 1 against
   "Measured 2-9" — half its recorded minimum rather than a third — and that
   comment predates the run-count tripling described above it.
8. **`sendAudio` "with the PCM bytes" asserts only the byte count** —
   `providers/stt/soniox.test.ts:411`. Cannot see an endianness flip, a wrong
   `byteOffset`, or a zeroed buffer — each of which sends silence or noise at
   exactly the right length. `deepgram.test.ts:180` does the byte-for-byte
   version of the same claim.

#### providers + integration — quality

1. **`vi.stubGlobal("fetch", …)` never undone** —
   `providers/_openai-stream-repair.test.ts:278`. Harmless only because it is
   the second-to-last test. `resolve.test.ts:207` has the `try`/`finally` fix.
2. **A hand-rolled `Promise.race` timeout, twice, both invisible to rule 3** —
   `pipeline-fuzz.integration.test.ts:468`, `s2s-fuzz.integration.test.ts:248`.
   Biome wraps both across lines. `pTimeout` also fixes the second-order defect:
   the losing `setTimeout` is never cleared, so each of 780 generated runs
   leaves a pending 5s timer.
3. **Three hand-rolled `ws` fakes, two copying a shared one that exists** —
   `providers/tts/_assemblyai-fake-ws-test-utils.ts:11` is the exported version;
   `rime.test.ts:10` and `soniox.test.ts:27` re-implement it. **They have
   already diverged in a way that matters**: soniox's starts at `readyState = 0`
   and transitions on open, the other two are pinned `OPEN` from the constructor
   — so a write-before-open regression is catchable in one suite and
   structurally invisible in the other.
4. **`let done = 0` counters instead of `vi.fn()`** — 15 sites in
   `tts/assemblyai.test.ts`, plus `cartesia.test.ts:205`,
   `rime.test.ts:254,285,301,315`, `assemblyai-reconnect.test.ts:76`.
   `cartesia.test.ts:206` and `rime.test.ts:255` are the worst — they push
   `Date.now()` into arrays never read.
5. **Dead `vi.stubEnv(<KEY>, undefined)` setup in four files** —
   `stt/deepgram.test.ts:94`, `stt/elevenlabs.test.ts:86`,
   `stt/soniox.test.ts:145`, `resolve.test.ts:106`. Neither `requireApiKey` nor
   `resolveApiKey` touches `process.env`. Worse than dead: it reads as if the
   adapter *had* an env fallback and passes whether or not one exists.
   `host-env.test.ts:20` already owns that property centrally, so the right edit
   is deletion.
6. **`await Promise.resolve()` where `flush()` is the repo's one spelling** —
   `tts/_assemblyai-session-test-utils.ts:26`, `tts/rime.test.ts:119`,
   `tts/assemblyai.test.ts:679`.

#### providers + integration — cleared

- `resolve.test.ts:95`'s `for…of` — wraps `describe(tc.label, …)`, so the
  reporter already names the case.
- `stt/elevenlabs.test.ts:47` mocking a different specifier than the source
  imports — the package ships no `exports` map, so classic directory-index
  resolution makes both the same absolute file.
- The `deepgram.test.ts` env-coercion class AGENTS.md names — fixed at `:92`,
  and no file in the slice hand-restores an env var.
- `host-env.test.ts` — the best-covered file under the credential lens: both
  resolvers pinned against a *present* `process.env` value, allowlist checked
  derived-not-listed.
- The pipeline fuzz generator contract — `ttsAudio` and `noiseBargeIn` refuse to
  emit outside a live synthesis window; lists are short and consumed cyclically;
  `stepArb` has the documented `minLength: 6`. No all-false-script hazard.
- `installHarness()`'s process-wide `unhandledRejection` collection — asserted
  *outside* `fc.assert`, never inside the property, so it cannot misdirect the
  shrinker.

### `packages/aai-ui` — 43 files, 9,588 lines

#### aai-ui — correctness

1. **None of the five property suites declares a coverage floor, and
   `fuzz-voiceio`'s L2 goes vacuous exactly when the harness is broken** —
   `fuzz-voiceio.test.ts:160`; same gap in `fuzz-hooks`, `fuzz-reconnect`,
   `fuzz-session-core`, `worklets/audio-stress`. See headline finding 5.
2. **"Caps the pre-init buffer instead of growing without bound" never observes
   the cap** — `session-core-events.test.ts:397`. Pushes
   `MAX_PREINIT_AUDIO_CHUNKS + 25` chunks and asserts `state === "speaking"` and
   `error === null`; the comment concedes "nothing observable grows past the
   cap". Delete the guard at `session-core-messages.ts:345` and both hold.
   `session-core-messaging.test.ts:87` does it properly with
   `toHaveLength(MAX_PREINIT_AUDIO_CHUNKS)`.
3. **Three `WorkflowProgress` "renders nothing" tests assert the pre-fetch
   frame** — `components/workflow-progress.test.tsx:43`, `:55`, `:65`. The
   component returns `placeholder ?? null` for both "no data yet" and
   "empty/unsupported", so `:43` asserts synchronously after `render` and `:55`
   awaits only `toHaveBeenCalled()`, satisfied inside the effect before the 404
   body is consumed. The hook's own spec awaits `supported === false`.
4. **"Audio chunk ignored in error state" asserts only that the error is still
   set** — `session-core.test.ts:486`. Removing the guard flips `state` to
   `"speaking"` but the fatal latch keeps `error` non-null, so the assertion
   holds either way. Two siblings already assert on `state`.
5. **A dead assertion plus a pre-flush one** — `define-client.test.tsx:147`.
   `not.toContain("HTTP turns")` references a string that appears nowhere else
   in `packages/` — it survived the removal of text-only mode and can never
   fail. The line above asserts the shell's *initial* render, reached before
   `fetchSpy` rejects.
6. **`AgentState` completeness asserted against a literal the test itself
   wrote** — `types.test.ts:33`. `toHaveLength(7)` counts the array on the
   previous line. The annotation catches a *removed* member; a member *added* to
   the union is caught by nothing, which is the direction that matters for a UI
   switching on it.
7. **The thinking indicator is asserted as a count of `.rounded-full` elements**
   — `components/integration.test.tsx:223`, `:246`. Swapping three dots for a
   spinner breaks the "shows" test while the behaviour is correct; any row
   gaining a round badge breaks the "hides" test (which asserts exactly `0`).
   The class-assertion argument the package makes elsewhere is about cascade and
   layout, which does not apply to element presence.
8. **`expect(socket).toBeDefined()` after a helper that already throws** —
   `session-core-reconnect.test.ts:272`. `waitForNextSocket` throws at `:39`, so
   the assertion is unreachable-as-a-failure and reads as if the re-dial were
   being verified.
9. **The drain-stop regression probe sends a stop carrying no turn id** —
   `session-core-drain.test.ts:134`. It does discriminate against removing the
   guard (`undefined !== 2`), but it does not model its own name ("turn 1's
   drain-stop … only now reaches the port"). The happy-path sibling ten lines
   down passes `turn: 1`, so a narrowing of the guard to "drop only *older*
   turns" would pass here and break in production.

#### aai-ui — quality

1. **A hand-rolled tick invisible to both guard rules** —
   `session-core-audio-init.test.ts:158`:
   `await new Promise<void>((r) => setTimeout(r, 0))`. The `<void>` type
   argument breaks rule 4's `new Promise\(` and rule 19's shared prefix, and the
   file carries no baseline entry because the gate never saw it. See headline
   finding 4; the regexes want `new Promise(?:<[^>]*>)?\(`.
2. **A fixed 20-microtask drain, in the file whose own helper doc retired that
   pattern** — `workflow-events.test.ts:212`. `collect`'s doc at `:42` explains
   that exactly this budget "held for two-frame streams and silently ran out at
   three".
3. **Session-core methods replaced by hand where `vi.spyOn` belongs** —
   `components/integration.test.tsx:38`, `:56`. A `calls: string[]` recorder
   plus hand-assignment, where a spy would name itself in the failure and be
   restored automatically.
4. **A local cast + optional call instead of the `crashWorklet()` seam** —
   `session-core-audio-failure.test.ts:113`. `_react-test-utils.ts:290` exports
   it, holds the cast at one seam, and calls the handler unconditionally so a
   missing handler is a `TypeError` naming the line rather than a silent no-op.
5. **`vi.unstubAllGlobals()` at the end of a test body is teardown that does not
   run on failure** — `define-client.test.tsx:144`, `:157`, `:170`, `:185`. A
   failure at `:160` leaks the `fetch` stub into `:173`, which then stubs
   `location`. Every other file in the package does it in `afterEach`.
6. **A whole hook suite on the wall clock while its sibling runs on virtual
   time** — `use-workflow-form.test.ts:27`. The give-up path at `:264` waits out
   `MAX_MISSING_READS` real intervals; `use-workflow-run.test.ts:85` specs the
   same loop under fake timers. The file's header defends real time on the
   grounds that `waitFor` and fake timers conflict — the sibling's `act` +
   `advanceTimersByTimeAsync` sidesteps the question.
7. **A local `flush` that is a timer advance, not a microtask yield** —
   `session-core-drain.test.ts:46`. Nothing is shadowed (nothing is imported),
   but the name now means "advance the clock" here and "yield microtasks"
   everywhere else.
8. **jsdom document styles leak forward** — `context.test.ts:222`.
   `ThemeProvider`'s unmount restores what it *found*, so the values persist
   into `:236` and anything added after.
9. **Two duplicated pairs in the audio suite** — `audio.test.ts:205`/`:408`
   assert the same settle; `:485` fully contains `:564`, which re-declares the
   same failing-`addModule` subclass to assert only the context close.

#### aai-ui — cleared

- `components/button.test.tsx`, `controls.test.tsx`, `sidebar-layout.test.tsx`,
  `tool-call-block.test.tsx:85` — class-name assertions, each with an explicit
  argument (jsdom has no cascade or layout, and three shipped variants had dead
  focus/hover states a behavioural suite could not see).
- `fuzz-voiceio.test.ts:262`'s per-run `restore()` — named in AGENTS.md as the
  legitimate exception; the ordering comment is right.
- `worklets/audio-stress.test.ts:77` — verified the `pacingArb` fix APPENDS
  rather than filters, so every generated value maps to a legal one and
  shrinking stays well behaved.
- `fuzz-session-core.test.ts:313` — the named `unhandledRejection` listener with
  `process.off` and the per-run `rejections.length = 0` are the documented
  shrinker-safety teardown.
- `use-workflow-progress.test.ts`, `workflow-events.test.ts`,
  `use-workflow-runs.test.ts` — checked for pre-flush assertions; every one
  awaits a settled predicate rather than a bare `waitFor(fetch called)`.
- `_session-core-test-utils.ts`'s `MockWebSocketConstructor` — checked as the
  cast-concentration candidate and cleared: single typed seams with rationale,
  no call site re-casts.

### `packages/aai-cli` — 44 files, 9,842 lines

#### aai-cli — correctness

1. **Two `workflow.test.ts` assertions are satisfied by earlier tests' calls** —
   `workflow.test.ts:88`, `:154`. See headline finding 2. Delete either
   `log.info` call from `workflow.ts` and both still pass.
2. **The empty-`AAI_DEV_HOST` test — the one whose comment says it exists
   because `listen(port, "")` means 0.0.0.0 — passes on a previous test's call**
   — `_dev-server.test.ts:456`. Eleven earlier tests record
   `listen(3000, undefined)`; if `devBindHost("")` regressed,
   `toHaveBeenCalledWith(3000, undefined)` still matches the stale entries. Same
   shape at `:161` and `:439`.
3. **The root cause is a documented-but-false premise in the shared harness** —
   `_dev-server-test-utils.ts:44`. See headline finding 2.
   `primeDevServerMocks()` resets implementations only, so every consumer
   inherits uncleared history; two files already work around it by hand, which
   is the signal the harness should do it.
4. **"Detects agent.test.ts files" never calls the code under test** —
   `test.test.ts:34`. Asserts `existsSync` on the file the test itself just
   wrote. Detection is genuinely covered at `:40`; as written this passes with
   `test.ts` deleted.
5. **`cli.test.ts` and `_dev-server-serve.test.ts` run real subprocesses and
   bind real ports in the 5s unit tier** — `cli.test.ts:21` (four tests, real
   `execa`), `_dev-server-serve.test.ts:148` (real port + real bundler pass).
   Neither carries an infix or an in-file argument, unlike
   `worker-bundler.test.ts:18` which argues the coverage-floor trade explicitly.
   `_dev-server-serve.test.ts` buys room with `{ timeout: 30_000 }` —
   timeout-as-tier-proxy.
6. **The e2e browser harness encodes its precondition as a deadline loop with no
   assertion** — `e2e.test.ts:338`. On expiry it falls out of the `while` and
   continues; every later `inject()` then evaluates on `undefined`, so a
   regression in the WS init-script hook surfaces as an opaque Playwright error
   in whichever of eleven concurrent tests reports first.
7. **The whole Playwright suite self-skips silently, with no `AAI_REQUIRE_*`
   counterpart** — `e2e.test.ts:391`, backed by a `try`/`catch` returning
   `false` at `:43`. The repo has `AAI_REQUIRE_PG`, `_STACK`, `_REGISTRY` and
   `_EVAL` precisely so a CI job cannot self-skip to green. If the cache restore
   leaves a path `executablePath()` cannot resolve, thirteen tests vanish and
   the job reports green with no note.
8. **"Secret list returns stored secrets" asserts only that a GET was made** —
   `integration.test.ts:205`. Discards the return value entirely; a regression
   returning `{ secrets: [] }` passes. (`integration-edge-cases.test.ts:181`
   does assert contents, so this is a mislabelled test rather than a hole.)
9. **"Stop/resume toggle works after fixture replay" never toggles anything** —
   `e2e.test.ts:627`. Waits for a button to exist and closes the page.
10. **The ".env filtering" test passes `cwd: undefined`, so no `.env` is read**
    — `_server-common.test.ts:14`. `fileEntries` stays `{}` and the loop has
    nothing to iterate, so `{}` is returned for *any* `baseEnv` —
    indistinguishable from the two tests that already assert the no-directory
    case. The real behaviour is covered at `:22`.
11. **The scenario tier runs without `_test-setup.ts`, so its credential scrub
    is absent** — `dev-workflow.scenario.test.ts:271`. `vitest.slow.config.ts`
    declares no `setupFiles`, so `process.env.ASSEMBLYAI_API_KEY ??= …` leaves a
    developer's real key in the fixture server's runtime env. Nothing dials it,
    so not a leak — but it is the machine-dependence `_test-setup.ts` documents
    having been bitten by. (The config-dir half of the protection does hold, via
    `getConfigDir()`'s in-code `VITEST` fallback.)
12. **The e2e fixture harness requires audio capture to FAIL to proceed** —
    `e2e.test.ts:350`. If capture ever degrades gracefully instead of erroring,
    all eleven fixture tests block for 10s and fail on a locator timeout that
    names a state, not a cause.
13. **`vi.doUnmock("vite")` is not in a `finally`** — `_dev-server.test.ts:204`,
    `:234`. A failure above it leaves the `vite` mock installed for every later
    test that reaches the client-build branch.

#### aai-cli — quality

1. **Fix the harness, not each call site: clear call history in
   `primeDevServerMocks()`** — `_dev-server-test-utils.ts:47`. Add `mockClear()`
   for the seven shared mocks and correct the comment at `:44`; that removes the
   per-test scaffolding at `_dev-server-restart.test.ts:103` and
   `_dev-server.test.ts:227,272,291` and fixes findings 1-3 at the source.
2. **Four hand-rolled copies of `linkSdkNodeModules()`** — `_build.test.ts:15`,
   `worker-bundler.test.ts:38`, `workflow-bundler.test.ts:33` are
   byte-equivalent to the exported helper. (`typecheck.test.ts:18` is a
   legitimate variant — repo root, not package.)
3. **`let releaseX!: () => void` + `new Promise` → `Promise.withResolvers()`** —
   `dev.test.ts:65`, `_dev-server-restart.test.ts:136`. Four sites in
   `_dev-restart.test.ts` already comply.
4. **Hand-rolled temp dir beside `withTempDir()`** — `test.test.ts:17`.
5. **Two hand-rolled poll loops where the file's own idiom is
   `vi.waitFor`/`expect.poll`** — `e2e.test.ts:338`,
   `dev-workflow.scenario.test.ts:531`. The latter file already uses
   `expect.poll` correctly at `:310`.
6. **`_fault-mode.scenario.test.ts` leaks its temp dir and hand-assigns ports**
   — `:113` (no `afterAll` removal, so every run leaves `aai-fault-*` in
   `tmpdir()`), `:109` (`let nextPort = 4861` where `get-port`'s `portNumbers()`
   is the in-package idiom). An occupied 4861 is an EADDRINUSE flake the retry
   at `:46` papers over rather than avoids.
7. **`_ui.test.ts` encodes test ordering as a comment** — `:31`. True of current
   file-order execution and silently false under `sequence.shuffle` or a
   reordering edit. `vi.resetModules()` + dynamic import makes it structural.
8. **Two unit-tier tests spend ~2s of real wall clock each** —
   `_config.test.ts:317`, `:342`, against the 5s default. The
   `Date.now() < 10_000` assertions cannot discriminate 2s from 9s; the real
   hang-detector is the vitest timeout, which the wait is already 40% of.
9. **`withTempDir`'s cleanup can mask the test failure** — `_test-utils.ts:14`
   uses `fs.rm` without `force`, so an ENOENT from the `finally` replaces the
   real assertion error. `test.test.ts:25` already uses `force: true`.
10. **Stale comment about teardown** — `_dev-server.test.ts:109`. Warns about
    something `unstubEnvs` already handles, as the `beforeEach` at `:101`
    correctly says.
11. **A test name pinning a rationale the platform no longer has** —
    `deploy.test.ts:90`. The assertion is still correct; only the parenthetical
    is wrong, and it is the part a reader uses to decide whether a failure is a
    regression.

#### aai-cli — cleared

- `integration.test.ts` / `integration-edge-cases.test.ts` in the unit tier —
  named in AGENTS.md as deliberate exceptions.
- `worker-bundler.test.ts` / `workflow-bundler.test.ts` driving real Vite passes
  — `worker-bundler.test.ts:18` states the standing judgement (floors sit
  1.3-2.2 points above actuals), the shape AGENTS.md blesses.
- Every hardcoded `/tmp` in the slice — all are mocked-away cwds, string
  operands, or a `fileExists` expecting `false`; none reaches the filesystem,
  and rule 11 scopes to shipped source.
- `dev-workflow.scenario.test.ts:205`'s inline timer promise — inside a fixture
  string of *user* workflow code, the documented rule 19 exemption.
- Seven files' `vi.clearAllMocks()`-style teardown that *looks* dead — all live,
  per headline finding 2. `eject.test.ts:41`'s comment is the only one in the
  package that states the reason correctly.
- `dev.test.ts`'s `withCapturedHandlers` `finally` — named in AGENTS.md as the
  legitimate sub-test-boundary exception.
- `integration.test.ts:296` — looks self-derived, but `:297` re-derives the slug
  independently.

### `packages/aai-guest` — 26 files, 5,285 lines

#### aai-guest — correctness

1. **A test whose assertion accepts either outcome, so the behaviour it names is
   never exercised** — `studio-project-tools.test.ts:121`. Branches on
   `Downloaded` vs `/^Error: /`; `safeFetch` blocks `data:` URLs, so the `else`
   always runs and the `readFile` assertion is dead code. The whole fetch → cap
   → decode → write path is unasserted, and the SSRF half is equally
   undiscriminating (any refusal reason produces the same prefix).
2. **The guard for "limits.ts has zero imports" cannot see the one import the
   file has** — `limits.test.ts:38`. The regex is `/^\s*import\s/m`;
   `limits.ts:114` is
   `export { MAX_WORKSPACE_FILES as MAX_STUDIO_FILES, … } from "@alexkroman1/aai/workspace-files"`
   — a live cross-package dependency. The file's own doc at `:5` ("must keep
   zero imports") and the test name are both false today, and a new
   `export … from "@alexkroman1/aai-cli/…"` would break guest bundling with this
   test green.
3. **A test named for summarizing the middle asserts that nothing was
   summarized** — `studio-compaction.test.ts:148`. `fakeModel = {} as …` makes
   `generateText` reject, so the only assertion is `toEqual(input)` —
   byte-for-byte the claim of `:186`. Its comment claims it asserts the shape
   contract "by shrinking the budget"; no budget is shrunk.
4. **`toBeDefined()` on a `string | null` return passes when the notice never
   fires** — `studio-turn-budget.test.ts:44`, `:70`. `null` is defined, so
   `toBeDefined()`/`toBeNull()`/`expired()` all hold for a budget that never
   offers a closing step — the failure the module's own comment says would "end
   the turn on a tool call, leaving the user no text at all".
5. **`GET /studio/tools` — a public, bearer-gated guest route — has no test
   anywhere** — dispatched at `studio-chat.ts:219`, declared
   `{ via: "direct-dial" }` in `guest-routes.ts`. The 401 test at
   `studio-chat.test.ts:203` posts only to `/studio/chat`. Dropping the route
   from the `url ===` disjunction turns it into a 404 the client reads as a dead
   sandbox; moving the labels response above `verifyBearer` leaks the tool
   inventory unauthenticated. Both pass every test in the slice.
6. **Eight files run real subprocesses, ports, compilers and installs in the 5s
   unit tier** — `studio-test.test.ts:24` (real `vitest` child),
   `studio-build.test.ts:164` (real `tsc`), `studio-chat.test.ts:126` (real
   server + real `bash` at `:364`), `studio-publish.test.ts:36`,
   `studio-spawn.test.ts:35` (real `npm`), `studio-tools.test.ts:82`,
   `harness.test.ts:176` (real worker threads). Several carry `timeout: 120_000`
   — the scenario tier's timeout, re-declared. **And `vitest.config.ts` does not
   exclude the infixes**, so renaming today would leave them in the unit tier
   anyway; see headline finding 3.
7. **A module-global host channel leaks in-flight turns across tests, and the
   assertions were weakened to tolerate it** — `studio-chat.test.ts:140`,
   `:195`, `:259`, `:298`. `setHostSend` is a singleton and `serve().close()`
   does not await the turn, so a previous test's settle lands in the next test's
   `host.calls` — documented in-file at `:306` with the flake message it
   produced. The workaround is `toBeGreaterThanOrEqual(2)` plus `toContain`, and
   `"// original"` is not unique to that test. The fix is for `serve()` to
   return a handle that awaits outstanding turns.
8. **`expect.anything()` swallows the only thing that bounds the bundle fetch**
   — `harness-agent-mode.test.ts:96`. The argument is
   `{ signal: AbortSignal.timeout(BUNDLE_FETCH_TIMEOUT_MS) }` — the 60s cap that
   keeps a hung Storage URL from parking agent-mode boot against the host's 120s
   readiness budget. Dropping the signal passes.
9. **Two wall-clock assertions inside default-5s tests** —
   `harness.test.ts:183`, `studio-edit.test.ts:150`. In both, the real invariant
   is asserted next to it, so the timing line adds no coverage and only a
   failure mode.
10. **A cross-package drift gate that turbo cannot invalidate** —
    `studio-project-shape.test.ts:16`, `:99`. It reads
    `../aai-templates/scaffold/{tsconfig,package}.json` to assert
    `WORKSPACE_DEPENDENCIES` still matches — but `aai-templates` is not a
    dependency of `aai-guest` and is not in this package's turbo `inputs`, so
    editing the scaffold does not change the hash and the gate is served FULL
    TURBO exactly when the file it guards changed. `aai-templates` re-includes
    its repo-root reads for precisely this reason.
11. **"Refuses paths that escape the workspace before fetching" never checks the
    ordering it names** — `studio-project-tools.test.ts:79`. The source does get
    it right, but swapping the two blocks would still refuse, still produce the
    string, and would have issued a model-controlled outbound request first. The
    mocked sibling already has the `safeFetch` spy needed to assert it.

#### aai-guest — quality

1. **The fake host control channel is written three times** —
   `harness.test.ts:23`, `harness-rpc.test.ts:21` (verbatim),
   `studio-chat.test.ts:141` (variant). Replacement: `installFakeHostChannel()`
   in a new `_test-utils.ts`, returning `{ sent, answerLast, lastFrame }`.
2. **Repeated `sent.at(-1) as { … }` casts are a missing typed seam** —
   `harness.test.ts:354,372,397,423`, `harness-rpc.test.ts:35,66`, each
   re-narrowing to a different ad-hoc shape.
3. **Three independent fake `ServerResponse` builders** —
   `harness-agent-mode.test.ts:142`, `studio-session-init.test.ts:41`,
   `studio-turn-stream.test.ts:112`, each with its own
   `as unknown as http.ServerResponse`.
4. **Three `execute()` wrappers that only re-wrap `runTool`** —
   `studio-project-tools.test.ts:25`, `studio-project-tools-mocked.test.ts:43`,
   `studio-template-tools.test.ts:39`.
5. **Temp-directory bookkeeping open-coded six times in three styles** — and
   `studio-project-shape.test.ts:45` leaks: `let dir` is never assigned by the
   second `describe`, so its `afterEach` re-`rm`s the first block's
   already-deleted path. `packages/aai-cli/_test-utils.ts` has the
   `withTempDir()` to mirror.
6. **The `materialize` callback inlined five times in one file** —
   `studio-build.test.ts:119,154,174,200,229`. `studio-test.test.ts:10` already
   exports the same three lines.
7. **Seven `try`/`finally` fake-timer blocks in one describe** —
   `harness-agent-mode.test.ts:367-523`. The teardown is needed; per-test is
   not.
8. **A `for…of` over seven TS codes where `test.each` would name the failure** —
   `studio-diagnostics.test.ts:57`. The message argument labels it, but the loop
   still stops at the first failure.

#### aai-guest — cleared

- Credential fallback — checked every `apiKey`/`process.env` occurrence: all
  literals; the only `process.env` read is inside a *generated* workspace test
  asserting a variable is absent.
- Hardcoded `/tmp` — every temp path goes through `join(tmpdir(), …)`, including
  `harness-bundle.ts`, the module that caused the Windows failure.
- Undeclared dependency on a built artifact — no test here loads
  `dist/harness.mjs`; the two that need sibling `dist/` are covered by
  `test.dependsOn: ["^build"]`.
- `workspacesRoot()` keying scratch dirs on `process.pid` — safe under Vitest
  4's default `forks` pool, but a latent trap if `VITEST_POOL=threads` is ever
  set here.
- `studio-tools.test.ts:82` and `studio-test.test.ts:51`, the guest-token scrub
  tests — both discriminate properly; the second makes the workspace's own
  vitest child assert the variable is `undefined`, so a broken scrub fails the
  child run.
- `resetTurnGate()` / `resetSessionIdentity()` as test-only exports — both reset
  genuinely process-global singletons no unit boundary can reach, and both are
  labelled as seams in source.

### `packages/aai-server` (first half) — 46 files, 8,745 lines

`_bearer.test.ts` → `platform-lock.scenario.test.ts`.

#### aai-server (first half) — correctness

1. **The delete/deploy race test posts to a route that does not exist, and both
   assertions accept the 404** — `orchestrator-concurrency.test.ts:53`. Deletion
   is registered as `agents.delete("/")` (`orchestrator.ts:341`); there is no
   `POST /:slug/delete`, so the request falls through to `notFound` every run
   and `[200, 404].includes(...)` accepts it. The redeploy arm accepts
   `[200, 403]` — every outcome it can produce. Nothing about ordering is
   exercised.
2. **The WebSocket slug-validation test asserts on a regex literal it defines
   itself, and that literal already disagrees with production** —
   `orchestrator-security-validation.test.ts:143`. The real one is composed from
   `VALID_SLUG_RE` with a `{0,62}` bound (`orchestrator-ws.ts:86`); the copy has
   no length bound, so it already accepts a 200-char slug the upgrade path
   rejects. Delete `SLUG_WS_RE` outright and this passes.
3. **"Concurrent putEnv calls do not lose updates" passes with the lock
   removed** — `bundle-store.test.ts:107`. `putEnv` is a wholesale replace
   inside `withLock` — there is no read-modify-write to lose, so the final env
   is `{ B: "2" }` either way. The invariant needs an observation of overlap.
4. **Two "under load" concurrency tests assert only that the static `/health`
   endpoint answers 200** — `orchestrator-concurrency.test.ts:18`, `:36`. The
   first fetches the *platform* health route, not `/my-agent/health`; the second
   never asserts the deploy responses at all (`results.slice(5)` skips them). A
   deploy path that 500s under concurrency passes both.
5. **A test named for `resolveSandbox` never calls it** —
   `orchestrator-security.test.ts:115`. It round-trips the memory store, which
   `bundle-store.test.ts:198` already owns. A regression dropping
   `ASSEMBLYAI_API_KEY` from `agentBootEnv` leaves this green with its name
   still promising otherwise.
6. **"Deleting agent A does not delete agent B" accepts any status under 500** —
   `orchestrator-security.test.ts:203`. Passes on 404 and 403, in which cases
   nothing was deleted and "beta still exists" is trivially true.
7. **Both CORS "untrusted origin is rejected" assertions pass if the header
   regresses to `*`** — `orchestrator-security-validation.test.ts:113`, `:130`.
   `not.toBe("https://evil.example.com")` is satisfied by `*` — on a surface
   serving every tenant's agent page. `app-middleware.test.ts:84` uses
   `toBeNull()`.
8. **The favicon fallback test asserts the opposite thing when the artifact is
   missing** — `orchestrator.test.ts:235`. Branches on `existsSync`; an aai-ui
   build change that stopped emitting `dist/default-client/favicon.ico` silently
   moves every run onto the 404 branch. The adjacent `:155` treats the same
   precondition as a hard failure, so the two disagree about whether the build
   is a given.
9. **The bundle-hash-mismatch matcher cannot tell a hash mismatch from any other
   spawn failure** — `agent-server-integration.test.ts:103`.
   `/not ready|spawn failed/i` is the generic wrapper text every failure
   carries. (Same file `:97`: the drain assertion is a bare unbounded
   `await new Promise(resolve => handle.onExit(resolve))`, so a guest that stops
   self-exiting hangs to the 60s timeout instead of naming the broken drain.)
10. **A suite titled "auth timing safety" asserts only digest formatting** —
    `auth.test.ts:78`. A plain `===` implementation satisfies every assertion
    under that heading. Separately `:19`'s
    `expect("keyHash" in result).toBe(false)` is over a type that has only
    `status` — permanently vacuous.
11. **Two suites open a real port / spawn a real subprocess in the unit tier** —
    `live-streams.test.ts:142`, `modal-harness-image.test.ts:383` (90s timeout).
    `vitest.config.ts:36` names exactly one deliberate exception and spells out
    its coverage trade; these two carry no such note.
12. **"Works without env in body (uses stored env)" asserts only the status
    code** — `deploy.test.ts:89`. The parenthetical is the claim; a regression
    that dropped the stored env on an env-less deploy passes. One `store.getEnv`
    read-back closes it.

#### aai-server (first half) — quality

1. **A fourth spelling of "yield a macrotask", invisible to rules 4 and 19** —
   `_semaphore.test.ts:8`, `orchestrator-key-auth.test.ts:113`, `:145`
   (`setImmediate`). Four sibling suites already import `sleep` from
   `@alexkroman1/aai/internal`. See headline finding 4.
2. **`let granted = false` flipped inside a `.then()`** —
   `_semaphore.test.ts:22`. Same file `:96` and `api-key-verify.test.ts:130` are
   `for…of` case loops that want `test.each`.
3. **A shared fixture cast `as never`, carrying a column the schema dropped** —
   `platform-events.test.ts:15`. `AGENT.config` was removed by
   `20260810030000_drop_agents_config.sql`; the cast is what stops the compiler
   saying so.
4. **A caching claim pinned by spying on the global `JSON.parse`** —
   `modal-harness-image.test.ts:366`. A resolver that stopped memoizing the
   SHA-256 over the 13 MB harness but happened not to re-read a manifest passes;
   an unrelated `JSON.parse` anywhere in the path fails.
5. **A scenario-tier file whose docstring claims a property it does not have** —
   `orchestrator.scenario.test.ts:2`. Says "a real HTTP server on a real port,
   which is what puts them in that tier"; the body uses in-memory
   `app.request(...)` and binds nothing, so it sits outside `pnpm test` and
   outside coverage for no reason the membership rule recognises. (`:13` also
   pulls every module through `await import()` with no mock or ordering need.)
6. **Three stale pointers to a script this package does not have** —
   `_pg-test-utils.ts:30`, `:36`; `jsonb-encoding.scenario.test.ts:30`;
   `platform-lock.scenario.test.ts:30`. The enforcement works (`turbo.json:223`
   declares `AAI_REQUIRE_PG` under `check:scenario`); only the documentation is
   wrong — and that comment is the one place a reader checks when asking whether
   the skip-to-failure wiring is live. `_pg-test-utils.ts:5` also says "Five
   integration suites" where the guide says seven.
7. **Duplicate specs that assert less than the ones they duplicate** —
   `orchestrator-security.test.ts:137`, `:148` vs `secret-handler.test.ts:89`;
   and `deploy.test.ts:301`/`:363` are the same test under two names.

#### aai-server (first half) — cleared

- `pg-cron`, `jsonb-encoding`, `platform-lock` scenario suites — all gate with
  `describeWithPg`/`describeWithStack` and read `pgUrl()` inside `beforeAll`, so
  the collection trap is respected and the skip announces itself.
- `guest-routes.test.ts` — introspects the real route table and carries three
  explicit anti-vacuity guards.
- `phone-signature.test.ts` — writes its own Twilio signer specifically so the
  implementation cannot validate itself.
- `agent-server-integration.test.ts` tier placement — the documented judgement
  call; only its assertion quality is reported.
- `spyOn(console, …)` throughout — the known, sized logger-seam gap.
- No dead `mockRestore()`/`unstubAllEnvs()` in this half;
  `_static-files.test.ts:41` and `live-streams.test.ts:25` are real resource
  cleanup.

### `packages/aai-server` (second half) — 45 files, 9,483 lines

`platform-lock.test.ts` → `ws.scenario.test.ts`.

#### aai-server (second half) — correctness

1. **The RLS suite's only leak control sits behind an unannounced hand-rolled
   gate** — `realtime-rls.scenario.test.ts:66`.
   `process.env.AAI_TEST_SUPABASE_ANON_KEY ? describe : describe.skip` is
   exactly the copy the package guide says was replaced by an announcing helper:
   it prints nothing, and no `AAI_REQUIRE_*` covers it. What it gates is, by the
   file's own words at `:299`, "the control that makes the tests above
   non-vacuous" — every other assertion waits for a frame to ARRIVE, so a grant
   or RLS change that lets walrus deliver `aai_platform.agents` rows to `anon`
   leaves the file green. The trigger is live: CI pins `supabase/setup-cli` at
   `version: latest`, and the day `supabase status -o env` stops emitting
   `ANON_KEY` under that name, the negative control silently disappears.
2. **The serialization claim is asserted by a tautology** —
   `slug-lock.test.ts:5`.
   `expect(record === null || record.slug === "my-agent").toBe(true)` holds for
   every possible interleaving, including a torn one. Remove the `slugLock`
   binding entirely and the file passes; nothing observes exclusion.
3. **Three unit-tier files bind real ports or spawn a real process** —
   `warm-harness.test.ts:54`, `transport-websocket.test.ts:274`,
   `subprocess-sandbox.test.ts:204`. `ws.scenario.test.ts:2` states the rule for
   this exact case. `warm-harness.test.ts:71` is the sharp one: it closes a
   server, waits `sleep(150)` of wall clock, and re-binds **the same port
   number**.
4. **The session-factory reset is a silent no-op, so a failing factory leaks
   forward** — `ws.scenario.test.ts:120`, `:280`.
   `makeSession: (factory?) => { if (factory) sessionFactory = factory; }` —
   calling it with no argument (`:295`, commented "Server should still accept
   new connections") restores nothing, so the failing `start` factory from
   `:281` stays installed and the line-296 connect validates the broken one.
5. **"One reservation at a time" rests on a sampler that may never fire** —
   `platform-lock.test.ts:228`. `peakLive` is sampled by `setInterval(…, 0)` and
   starts at 0, so **zero samples satisfies `toBeLessThanOrEqual(1)`**. The
   neighbouring test at `:172` shows the discriminating form.
6. **"Retires the old resident" only asserts the slot emptied** —
   `sandbox-invalidate.test.ts:148`. A straight `shutdown()` satisfies it
   identically, so terminating the old guest under live calls when the
   replacement crashes passes unchanged. The success-path sibling at `:365` does
   it right.
7. **A module-level `vi.fn()` accumulates calls, and one assertion counts them**
   — `workflow-webhook-handler.test.ts:228`. See headline finding 2;
   `toHaveBeenCalledTimes(1)` is a statement about file order rather than about
   the case.

#### aai-server (second half) — quality

1. **A second copy of the pg_cron-stripping migration reader** —
   `platform-schema.scenario.test.ts:75`. `platformMigrationSql()`
   (`test-utils.ts:365`) re-written down to the `skipped` counter, and that
   helper's doc asserts the regex no longer lives in this file.
   `pg-cron.scenario.test.ts:48` already imports it.
2. **Hand-rolled deferred beside two `Promise.withResolvers()` in the same
   file** — `platform-lock.test.ts:258`.
3. **Dead teardown hook** — `workflow-wake.scenario.test.ts:169`.
4. **A comment teaching a mechanism that is not there** —
   `sandbox-resolve.test.ts:300`. Blames `restoreMocks` for stripping the
   hoisted factory's default; the actual cause is the `afterEach(mockReset)` at
   `:241` in the preceding `describe`. See headline finding 2.
5. **A loop over HTTP verbs where the reporter should name them** —
   `storage-handler.test.ts:116`.
6. **Unqualified `rejects.toThrow()` on a constraint claim** —
   `workflow-wake.scenario.test.ts:289` ("the one-row invariant is enforced by
   the table"): any rejection passes, including a renamed column or an absent
   table. `secret-store.test.ts:100` asserts the SQLSTATE.
7. **Un-awaited teardown plus a stale claim** —
   `workspace-build.scenario.test.ts:114` (`server.close()` returns before the
   socket is released) and `:99`, whose comment describes a deleted path.

#### aai-server (second half) — cleared

- `rate-limit.test.ts:87`'s JS reimplementation of window semantics — a
  recorder, not an arm; `store-conformance.scenario.test.ts:117` runs the
  conformance suite over the real `createPgRateLimiter` against the database's
  own clock.
- Hardcoded `/tmp` in `sandbox-vm.test.ts:96` and
  `subprocess-sandbox.test.ts:76` — rule 11 explicitly excludes
  `packages/**/*.test.ts`, and neither path is written to.
- `vi.clearAllMocks()` and the `finally { vi.useRealTimers() }` blocks — live,
  not dead, per headline finding 2.
- All five gated scenario suites — every one uses
  `describeWithPg`/`describeWithStack` and reads `pgUrl()`/`stackEnv()` inside
  `beforeAll` or a test; the collection trap is clear.
- `store-conformance-registry.test.ts:126` — checked for the self-match trap;
  its `CASE_LISTS` values are bare names with no `(`, so it cannot satisfy its
  own probe.
- The three text-scanning schema suites — each asserts a non-empty corpus before
  comparing, so none can pass by matching nothing.

### `packages/aai-studio-server` — 34 files, 8,567 lines

#### aai-studio-server — correctness

1. **Two structurally identical `{}` sentinels make the option-forwarding
   assertion blind to a swapped wiring** — `studio-app.test.ts:141`. `registry`
   and `rateLimiters` are both `{} as NonNullable<…>` and `toEqual` is
   structural, so passing the rate limiters as `sessionRegistry` and vice versa
   still yields `{rateLimiters:{}, sessionRegistry:{}, …}`. The one thing the
   test exists to pin — which dependency lands on which key — is exactly what it
   cannot see. Needs `toBe` per key.
2. **The favicon and shell tests branch on whether the client bundle exists, so
   neither can fail** — `studio-app.test.ts:116`, `studio-routes.test.ts:62`,
   `:49`. `if (res.status === 200) {…} else { expect(res.status).toBe(404) }`
   accepts both; the shell test asserts only `toContain("<!DOCTYPE html>")`,
   which the built shell and the "has not been built" fallback both satisfy. Per
   the package guide a stale bundle "looks like NOTHING" — and nothing here
   would notice a `dist` that is absent, a year old, or from another branch.
   `studio-static.test.ts:224` covers both branches deterministically against a
   faked dist, so these three are non-discriminating duplicates; the surviving
   gap is that no test ties the served shell to the current client source.
3. **The SSE fuzz harness claims to check writes on both sides of the await and
   checks one** — `studio-concurrency-fuzz.test.ts:445`. The comment says "the
   response may close while one is in flight", but the `if (w.ended)` check runs
   only *before* `await s.schedule(…)`. The interleaving where a write starts
   legally and lands in a closed response — the chunked-body protocol error the
   header names as the production symptom — cannot be detected. A second check
   after `:448` closes it.
4. **A route test's name claims a property it never asserts** —
   `studio-project-routes.test.ts:211`. "One wins, the loser cannot reset the
   files" asserts only the status pair; nothing reads the workspace afterwards.
   Covered at the store level by `studio-workspace.test.ts:147`, so the
   route-level claim is the lie.
5. **Wall-clock `sleep(50)` gates the read-sharing count, and the count is the
   subject** — `studio-events.test.ts:289`. If the three initial reads have not
   landed inside 50ms on a loaded box, the counter reset happens mid-flight and
   a straggler is counted as a change-read. The three frames are observable;
   await them instead.
6. **"Explains why" / "with the reason" asserted as merely non-empty** —
   `studio-routes-contract.test.ts:155`, `:327`. Both tests exist because a bare
   400 was the bug, and the header says these strings are what the client
   renders and the CLI prints. `"Bad Request"` satisfies both matchers.
   `assertWorkspaceLimits` throws `/Too many files/` and `/File too large/`,
   already pinned elsewhere.
7. **A gateway model id hardcoded where the assertion beside it interpolates the
   constant** — `studio-prompt.test.ts:75`. Dropping `gpt-5.2` from the roster
   fails this test with no defect behind it, and a *stale* hardcoded list
   containing `gpt-5.2` would also pass. `:80` gets it right by reading
   `ASSEMBLYAI_LLM_DEFAULT_MODEL`.
8. **`toMatchObject({ files: {} })` asserts nothing about files** —
   `studio-events.test.ts:93`. An empty expected object means "any object", so
   only `previewStale: true` discriminates and a populated or wrong first-frame
   file map passes.
9. **The sweep cadence is a hand-copied constant, so the boundary tests can
   silently stop testing the boundary** — `studio-session-idle.test.ts:11`,
   feeding `:70`. `idleMs` is injected; the cadence is not. Change the module's
   interval to 30s and `advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)` fires two
   sweeps at ages the helper did not intend, while
   `"leaves a sandbox idle for exactly the window"` (`:145`) — the one assertion
   pinning the strict-inequality boundary — keeps passing without exercising it.

#### aai-studio-server — quality

1. **`wakePreviewMock` and `brokerMock` are untyped `vi.fn()`s, and four call
   sites re-narrow by hand** — `_studio-routes-test-utils.ts:70`, `:79`; casts
   at `studio-routes.test.ts:309`, `studio-preview-wake-routes.test.ts:102`,
   `:144`, `_studio-routes-test-utils.ts:74`. The seam already exists in the
   same file — `ensureSessionMock` is declared with `Parameters<…>`.
2. **The dev-auth onboarding scaffold is written four times** — `devToken` at
   `_studio-routes-test-utils.ts:82` versus verbatim copies at
   `studio-account-routes.test.ts:17`, `studio-cli-link.test.ts:13`,
   `studio-key-binding.test.ts:17`; `withAuth` duplicated twice; the
   `PUT /studio/account/key` call open-coded in five files; `createProject`
   re-declared twice.
3. **The slug-claiming and app-db fakes are triplicated** —
   `studio-database.test.ts:82`, `studio-database-routes.test.ts:66`,
   `studio-secrets.test.ts:36`; `fakeAppDb()` duplicated with *divergent*
   password generation (`Math.random()` vs `"f".repeat(32)`). `aai-server`'s
   `deployAgent` cannot serve here because `POST /deploy` refuses the `-preview`
   suffix, which is why the copies exist and why they should be one.
4. **`settled()` is a no-op `vi.waitFor` plus a bare macrotask, gating ~10
   negative assertions** — `_studio-preview-test-utils.ts:24`.
   `await vi.waitFor(() => Promise.resolve())` succeeds on its first attempt and
   waits for nothing. Sufficient today only because every step is a microtask
   over in-memory stores; the moment one acquires a real timer, six
   `not.toHaveBeenCalled()` assertions become vacuous with no signal.
5. **Two unit-tier suites write to the real filesystem** —
   `studio-sdk-exports.test.ts:28`, `studio-static.test.ts:179`. Stated honestly
   by the reviewer as a repo-wide convention mismatch surfacing here rather than
   a studio-specific lapse; see headline finding 3.
6. **`for (const backend of ["modal","subprocess"])` hides which case failed** —
   `studio-static.test.ts:105`. (The slice's other `for…of` loops are legitimate
   — one labels via `expect(workflow, shared)`, two are sequenced steps.)
7. **`vitest.config.ts:21` says this package owns no slow-tier files;
   `studio-store-conformance.scenario.test.ts` exists.** The comment is stale,
   and the package does declare `check:scenario`.

#### aai-studio-server — cleared

- Dead teardown: zero occurrences across all 34 files. The `mockClear()` calls
  are live, and every read of a shared mock's call log in the five route suites
  is preceded by a clear — no order-dependence to report.
- `studio-preview-deploy.test.ts:397`'s one-sided bound —
  `studio-concurrency-fuzz.test.ts:355` asserts both directions as a targeted
  property.
- `studio-sse.ts`'s hand-rolled owned map (rule 8) and the four baselined rule-4
  tick promises — all in `guard-invariants-baseline.json`, not new.
- `studio-store-conformance.scenario.test.ts` — `describeWithStack` announces,
  `pgUrl()` is read inside `beforeAll`, `AAI_REQUIRE_STACK` promotes the skip.
- Fast-check compliance beyond finding 3 — floors ~3.5x and ~8x below noted
  actuals, short lists consumed cyclically, intents that no-op when their
  precondition fails, per-run state constructed inside each property body. No
  hand-rolled PRNG.
- Publish's materialized shape — not in this slice; covered end-to-end by
  `aai-server/workspace-build-integration.test.ts`.
- `bundled-deps.test.ts` — cleared, and worth naming as the model for finding 2:
  it explicitly refuses to assert against `dist/` because "a test that silently
  skipped when it was missing would be no guard at all", and carries a corpus
  floor.

### `packages/aai-studio-client` — 26 files, 4,739 lines

#### aai-studio-client — correctness

1. **The suite's own 10s async ceiling is unreachable — the per-test timeout is
   5s** — `src/_test-setup.ts:26`, `vitest.config.ts:15`. The setup file exists
   to survive a contended `turbo run test:coverage` and raises Testing Library's
   ceiling to `10_000`, but neither config sets `testTimeout`, so vitest's
   5000ms default applies. `aai-server` and `aai-studio-server` both raise it to
   20s for exactly this rationale. Any `waitFor` needing 5-10s aborts as "Test
   timed out in 5000 ms", discarding the assertion message the setup file was
   written to preserve — and `app.test.tsx:257` and `:345` already request
   4000ms waits *on top of* an `openProject` wait in the same test.
2. **`api.test.ts` unstubs the global `fetch` in one of five `describe` blocks**
   — `src/api.test.ts:65`. Three later blocks each install a global `fetch` and
   never remove it, the last abandoned one being a rejecting `TimeoutError`.
   Nothing fails today only because every later block re-stubs first; a test
   appended to `isTransientError`, or a block inserted between them, runs
   against whatever the previous block abandoned.
3. **"The probe backs off" is an upper bound only, so a probe loop that STOPS
   passes it** — `src/preview.test.tsx:284`. Both assertions cap the call count;
   neither floors it. `useAgentPageReady` re-arms from inside the `.then`
   (`preview.tsx:104`), and the module's own docblock names the failure — a
   probe that ends the polling leaves the pane on "Starting your preview"
   forever. That regression yields one call and satisfies both bounds. The
   sibling floor at `:294` runs with no `onPreviewMissing`, so it cannot catch a
   loop that dies after `report()`.
4. **A tautological assertion stands in for "says which agent it is showing"** —
   `src/workflows-card.test.tsx:77`.
   `expect(screen.getByText(/preview/).textContent).toContain("preview")` cannot
   fail once `getByText` returns. Rewording the sentence at
   `workflows-card.tsx:215` while any element still contains the word "preview"
   (the slug `demo-preview`, the fallback copy at `:167`) keeps it green.
5. **`EVENTS_MIN_UPTIME_MS` is unpinned — only its sign is under test** —
   `src/use-event-stream.test.ts:54`. The two cases are 0ms and 20,000ms; the
   constant is `10_000`, unexported, asserted nowhere. Lowering it to 1ms leaves
   both green while restoring exactly the storm the test's comment describes ("a
   flat attempt every 3.0s indefinitely"). A third case just under the threshold
   is what the comment claims is guarded.

##### Is node + `react-dom/server` the right environment here?

**The premise is out of date, and so is `AGENTS.md`.** 18 of the 26 files carry
`// @vitest-environment jsdom` on line 1; only 8 run in node, and of those only
`chat.test.tsx` renders React at all. So the "server-render-only lie" class is
essentially absent — effects, clicks, timers, `beforeunload`, clipboard,
`AbortController`, fake-timer poll loops and a real `useChat` streaming turn are
all genuinely exercised. `chat.test.tsx` is honest about its limit (every
assertion there is a markup claim), and the interactions those components own
are driven in jsdom by `chat-panel.test.tsx:193` and `tool-row.test.tsx:82`.

**Recommendation: keep the split, and correct the guides.** node as default with
jsdom as a per-file pragma keeps eight pure-logic suites off a DOM they do not
need, and it costs nothing in coverage — a `.tsx` test that forgets the pragma
fails loudly on `document is not defined`, never silently. What is wrong is the
documentation; see "Three corrections to AGENTS.md" above.

#### aai-studio-client — quality

1. **`stubFetch` is untyped where its sibling `fakeFetch` in the same file is
   typed** — `src/_test-utils.ts:70`. Every consumer either casts (seven sites)
   or reads an unchecked `any` (`account-menu.test.tsx:63`, `api.test.ts:296`) —
   the second being worse, since nothing type-checks it.
   `vi.fn<typeof fetch>(...)`, exactly as `fakeFetch` does eleven lines above,
   whose docblock already argues the case.
2. **`afterEach(cleanup)` hand-written in 16 files; it belongs in
   `_test-setup.ts`** — four of them carry the same three-line comment
   explaining why RTL's auto-cleanup never registers. `use-event-stream.test.ts`
   is the file that has none and relies on a per-test `unmount()`; an assertion
   failing before that line leaves a mounted hook holding a pending fake timer.
3. **`ResizeObserverStub` duplicated verbatim** — `app.test.tsx:15`,
   `chat-panel.test.tsx:16`.
4. **The TanStack wrapper rebuilt in five files** — `app.test.tsx:31`,
   `settings.test.tsx:35`, `database-card.test.tsx:30`,
   `account-menu.test.tsx:14`, `workflows-card.test.tsx:33`.
5. **21 `as HTML*Element` casts, six in one file** —
   `top-bar.test.tsx:75,76,82,89,209,215` are all the same shape. Missing seam:
   `button(name): HTMLButtonElement` in `_test-utils.ts`.
6. **`let settled = false` flipped inside a `.then()`** —
   `stale-build.test.ts:120`, with a hand-rolled microtask yield at `:131` where
   the package's own `settle()` exists.
7. **`preview.test.tsx` mirrors four source constants instead of importing
   them** — `:19`. All four are module-private, so changing the source cadence
   silently *loosens* the bound in Correctness 3. `api.ts` shows the pattern —
   it exports its three timeouts and `api.test.ts:230` asserts relationships
   between them.
8. **The config omits both slow-tier infix excludes** — `vitest.config.ts:16`.
   See headline finding 3.
9. **`await settle()` used as a sync point where a condition is meant** —
   `api.test.ts:342,364,372,384,395,404,421,423,437`. Deterministic today only
   because `sseResponse` pre-enqueues every frame; any `pipeThrough` added to
   `api-events.ts` turns each into a partial-array comparison.

#### aai-studio-client — cleared

- `_test-utils.ts:60`'s `settle()` inline tick — baselined, and legitimate:
  `tick()` lives in an `_`-internal module this package may not import
  cross-package.
- `vi.unstubAllGlobals()` in twelve files — not dead teardown; nothing sets
  `unstubGlobals`.
- CSP — nothing in this slice asserts a policy string; `studioCsp` lives in
  `aai-studio-server`, so there is no client-side assertion that could drift.
- `chat.test.tsx:122` — asserts only aria-labels under `react-dom/server`, but
  the actual removal is driven in jsdom by `chat-panel.test.tsx:193`.
- `settings.test.tsx:72`'s `.eyebrow` class pins — deliberate and documented in
  the package guide.

### `packages/aai-templates` + `packages/aai-evals` — 39 files, 10,640 lines

This slice owns most of the gates-under-the-gates, so its review question was
different: **could this guard pass against an empty or degenerate extraction?**

#### aai-templates + aai-evals — correctness

1. **`escape-hatch-scope.test.ts` gives no per-pattern liveness check — six of
   the seven shipped patterns could match nothing and every assertion still
   passes** — `escape-hatch-scope.test.ts:111`. The assertion is an aggregate
   `hits.length > 0` over all seven patterns at once. Measured against
   `scaffold/CLAUDE.md`: `as any` matches 1 line; `@ts-expect-error`,
   `@ts-ignore`, `@ts-nocheck`, `biome-ignore`, `eslint-disable` and
   `as unknown as` match **zero**. One live pattern satisfies the whole suite.
   Narrow six of them to something that matches nothing and the gate reports
   `now=0 ✓` over a tree holding violations while this spec stays green — the
   exact bug AGENTS.md records having paid for with the `\b` patterns, **whose
   home is this very file**. Its sibling `guard-invariants-gate.test.ts:379`
   feeds every rule a positive sample and a negative twin; this file has
   neither. (This is also the gate that is missing `as never` entirely — see
   headline finding 4. The gap and the blind spec are the same story.)
2. **Neither baseline-gate spec bans `\b`, and both validate patterns in a
   different regex engine than the one that ships them** —
   `escape-hatch-scope.test.ts:107`, `:115`;
   `guard-invariants-gate.test.ts:365`, `:383`, `:394`. All use `new RegExp(re)`
   — JavaScript — while `_ratchet.mjs` runs them through `git grep -nIE` (POSIX
   ERE, whose GNU-extension support varies by build, which is exactly why `\b`
   was dead on some machines and not others).
   `guard-invariants-gate.test.ts:401` mitigates with an explicit `\b` ban;
   `escape-hatch-scope.test.ts` has **no `\b` assertion at all**, and the two
   patterns that historically carried one are still its two most complex.
3. **`check-file-length.mjs` has no corpus floor, and its gate spec asserts
   pathspec STRINGS rather than resolution** — `file-length-gate.test.ts:89`.
   Verified: with an empty `git ls-files` result the script prints
   `all files within caps ✓` and exits 0. Its three sibling gates all carry a
   floor. And AGENTS.md's own rule — verify with `git ls-files "<glob>"` — is
   not followed here: **`git ls-files "scripts/*.ts"` and `"scripts/**/*.ts"`
   both resolve to 0 files today**, so two of the five asserted globs are
   already inert and this test cannot tell.
4. **`test-assertion-gate.test.ts` pins the parser but not the two floors that
   are the gate's only defence against going quiet** —
   `test-assertion-gate.test.ts:38`. Its own doc says a broken parser "would
   print 'all 0 test(s) assert something ✓'". What prevents that is
   `MIN_TEST_FILES = 200` / `MIN_TESTS_SCANNED = 2000`, and no assertion
   mentions either. Delete both floors and this guard stays green while
   restoring exactly the failure mode it was written for.
5. **Guard rules 1, 7 and 10 are enforced by no sample and no corpus floor** —
   `guard-invariants-gate.test.ts:112` covers rule 12 and stops there by design.
   `scanUnpinnedActions` and `scanResearchFrontmatter` derive their corpora from
   `git ls-files` and return only `found`, never the file count — so a directory
   rename or a moved workflow makes either report zero findings, byte-identical
   to the rule being upheld. **Rule 7 is the supply-chain pin that keeps a
   floating `@v7` tag out of the release job's npm token** — the one rule here
   where a silent 0 has a security consequence.
6. **Every "state is scoped per session" test in the template suites is true by
   construction and cannot fail** —
   `templates/pizza-ordering/agent.test.ts:159`, `solo-rpg:142`,
   `support-line:298`, `plan-and-execute:298`, `travel-concierge:219`,
   `infocom-adventure:182`. `createToolContext()` gives each call its own
   `createDetachedSlotStore()`, and `session-state.ts:237` is a plain `Map`
   keyed by SLOT key with no notion of `sessionId` — so the distinct ids are
   decorative and `sessionSlot` could stop keying by session entirely with all
   of them passing. They still catch a template that put state in a module-level
   variable, which is worth keeping; the names and comments are what overclaim.
   `solo-rpg`'s `makeCtx(sessionId = "session-a", …)` makes the parameter fully
   inert.
7. **`starter-expectations.test.ts`'s four sweeps go vacuous if the field they
   filter on is renamed** —
   `packages/aai-evals/starter-expectations.test.ts:37`. Each `continue`s past
   every expectation lacking the key (3 of 12 today) and then asserts
   `offenders == []`. Rename the key and three tests check zero cases and print
   green. The floor at `:72` asserts `EXPECTATIONS.length > 0` but nothing about
   how many carry each field — in the file whose own doc says "a grader that
   says yes to everything measures nothing".
8. **`konsistent-config.test.ts` verifies a glob's literal PREFIX, not that it
   resolves** — `konsistent-config.test.ts:124`, `:182`. `literalPrefix` stops
   at the first magic character, so 4 of 13 conventions reduce to `packages/`. A
   typo *after* the first `*` — `*-barel.ts` for `*-barrel.ts` — leaves the
   prefix intact, makes konsistent check zero files, prints "No violations
   found", and passes this guard. It does catch a directory-segment typo, which
   is the case its comment names.
9. **`research-workflow/agent.test.ts:129` reads a mock's call list off a
   floating, unawaited promise** — `void run(...)` then a synchronous
   `mock.calls[0]?.[2]`. Passes only because the tool body happens to reach
   `start` before its first `await`; if anything async lands ahead, the cast at
   `:158` throws a `TypeError` instead of failing on `notify`, and the dropped
   promise becomes an unhandled rejection.
10. **`AGENTS.md:9` names an enforcing test that does not exist** —
    `agents-md-shim.test.ts` is not in the tree; the only occurrence of the name
    in the repo is that line. The behaviour *is* enforced
    (`claude-md-limit.test.ts:115` pins the root `CLAUDE.md` to `@AGENTS.md`,
    and `check-claude-md.mjs` repeats it), so this is a doc defect, not a
    coverage hole — but the stale pointer sits in the one sentence an author
    reads before deciding whether pasting into `CLAUDE.md` is checked.
11. **Three templates ship tool files no spec executes** —
    `templates/embedded-assets/tools/` (2), `health-assistant/tools/` (2),
    `night-owl/tools/` (1). `templates.test.ts:82` validates each config and
    resolves the registry but never CALLS a tool body — the exact state the
    package guide records as having shipped three tools that "could never have
    worked" and threw `TypeError` on first call.

#### aai-templates + aai-evals — quality

1. **A concentration of 18 identical result casts is a missing typed seam** —
   `templates/retail/agent.test.ts:38,46,145,163,…` plus 8 hand-written result
   interfaces. The file documents the cause at `:32` (`ToolDef["execute"]`
   returns `unknown`). Replacement: one `runOk<T>(tool, args, ctx)` that
   executes, narrows with `isToolFailure` and throws. The file also imports all
   15 tool modules directly where its sibling `registry.test.ts:29` already
   builds a `withDiscoveredTools` lookup.
2. **`structuredClone(seedJson) as unknown as Store` at two sites** —
   `templates/retail/shared.test.ts:8`, `:87`. One exported `seedStore()`;
   `seed.test.ts:84` already parses the seed against a zod schema, which is the
   honest narrowing the cast stands in for.
3. **A dead sample entry** — `guard-invariants-gate.test.ts:219` holds
   `rule6_templateStateCast`; rule 6 is retired and no longer in `LINE_RULES`
   (verified by import: 11 rules, ids 2,3,4,5,8,9,11,16,17,18,19). The suite
   asserts every rule has samples but never the converse, so dead samples
   accumulate silently.
4. **The only test in the file written as a sync body returning `.then(...)`** —
   `packages/aai-evals/runner.test.ts:69`. Works because the promise is
   returned; it is the shape that silently stops asserting the day the `return`
   is dropped.
5. **Single-field wrapper objects in two harnesses** —
   `templates/pizza-ordering/agent.test.ts:29` returns `{ ctx, sent }` where
   `sent` is destructured nowhere; `dispatch-center/agent.test.ts:15` returns
   `{ ctx }`, destructured immediately at every call site.
6. **Orphaned JSDoc block** — `templates/recap-workflow/agent.test.ts:511`, left
   behind when the helper became `installStubGateway`; it documents a
   declaration that is no longer there.
7. **`vitest.config.ts` declares no `exclude` for the slow-tier infixes** — its
   `include` matches both. Latent today; see headline finding 3.
8. **Shared mutable state plus a widening cast** —
   `packages/aai-evals/assertions.test.ts:20`. Module-level `let stamped`
   mutated by every `ev()` call, and `{ …body, meta } as SessionEvent` stops
   reporting when `SessionEvent` grows a field.

#### aai-templates + aai-evals — cleared

This is the clearance half, and for gate specs it is worth as much as a finding.

- **`api-contracts-gate.test.ts`** — an empty extraction fails on
  `packages.map(…).toEqual(["aai","aai-ui"])`, `contracts.length >= 21`,
  per-root `names.length > 0`, per-epoch `exports.length > 0`, and the
  load-bearing "every name a root selects appears in its current epoch"
  (`:169`). Its `declaredNames` reads the export CLAUSE (`:114`), which is
  exactly the fix for the Biome-collapses-a-short-clause trap AGENTS.md records.
- **`api-surface-file.test.ts`** — `entries.length >= 20`,
  `declarations.length > 0` per report, `combined.length > 50_000`, and an
  independent parser for the containment check. Empty-agrees-with-empty is
  unreachable.
- **`claude-md-limit.test.ts`** — `entries.length >= 9` plus four named paths.
- **`template-api-coverage.test.ts:159`** — an explicit "templates import from
  the scoped packages at all" floor plus `exported.size > 0`.
- **`retail/registry.test.ts`** — an empty registry fails `:95` before
  `test.each` can go vacuous; `:119` separately asserts SAMPLE_ARGS coverage.
- **`templates.test.ts:72`** — derives the expected prompt set from `existsSync`
  rather than from the glob under test. Two independent sources; the shape the
  others should copy.
- **`guard-invariants-gate.test.ts`** — rules imported as real values, a `>= 7`
  floor, per-rule positive/negative pairs, `repoFiles.size > 100`, and an "empty
  declared set flags everything" case for rule 12. The only gap is rules 1/7/10,
  reported above.
- **The eval tier not gating** — deliberate, documented, and correctly
  implemented. `_gate.ts` announces the skip with a remedy and **throws at
  import** under `AAI_REQUIRE_EVAL`, failing the file, which a green-skipped
  suite cannot be confused with; `starter.eval.test.ts:74` adds a studio
  `/health` probe with the same two-way behaviour. No silent skip anywhere in
  `aai-evals`, and no recorded assertion pinned to a model utterance —
  `behaviour.eval.test.ts` asserts tool choice, args, order and event ordering.
- **`pizza-ordering/agent.test.ts:215`** asserts `view.total` against the same
  `pizzaPrice` the projection uses — defensible: `pizzaPrice` is pinned against
  literals at `:50`, and the stated subject is that client and projection agree
  on one derivation.
- **Template files over the 700-line cap** (`retail` 1073, `recap-workflow` 770,
  `solo-rpg` 592, `transcription-workflow` 563) — `templates/` is exempt by
  `isExempt` at `check-file-length.mjs:90`.
- **The repo's documented cleanups have landed here.** Zero
  `delete process.env.X`, zero dead teardown, zero hand-rolled PRNGs, zero
  `Promise.race` + `setTimeout`, zero `let resolve!` + `new Promise`, and zero
  `{ … } as unknown as ToolContext` across all 39 files — the published
  `createToolContext`/`stubGenerate`/`stubGateway`/`toolOf`/`runTool`/`withDiscoveredTools`
  seam is used everywhere it applies.

---

## Part II — the machinery that runs and gates the tests

Part I reviewed `packages/**/*.test.ts` and stopped there, which left the more
important half unexamined: **the gates, configs and helpers that decide whether
those 6,002 tests mean anything.** Three more reviewers covered it — 12,800
lines across the ratchet scripts, the build/release/harness scripts, and the
vitest configs plus every shared test helper — with a standing instruction to
verify empirically rather than by reading: run every pattern through
`git grep -E` exactly as the script does, run `git ls-files` on every pathspec,
and confirm turbo `inputs` by A/B-ing a `--dry=json` hash.

| Slice | Files | Lines | Correctness | Quality |
| --- | --- | --- | --- | --- |
| Ratchet and gate scripts + baselines | 16 | 3,395 | 11 | 5 |
| Build, release and harness scripts | 23 | 4,594 | 8 | 10 |
| Vitest configs, shared helpers, task wiring | ~60 | ~4,800 | 10 | 9 |
| **Total** | **~99** | **~12,800** | **29** | **24** |

It found the two most severe defects in the whole sweep. Both are cases where a
green result means nothing, and neither is visible in a diff.

### M1. The single required CI check goes green when the build fails

`.github/workflows/check.yml:386-399`. The comment above it reads "Single gate
job for branch protection — add only `ci` as a required check", so this is *the*
check protecting the default branch.

- All five real jobs declare `needs: setup` (`:50`, `:147`, `:185`, `:283`,
  `:346`).
- `setup` runs `pnpm install --frozen-lockfile` and `turbo run build`.
- The `ci` job's own `needs` list (`:389`) **omits `setup`**.
- The result loop accepts `"skipped"` as a pass (`:395`), under `if: always()`.

So a broken lockfile or a failing build fails `setup`, GitHub reports all five
downstream jobs as `skipped`, the loop accepts every one, and the job prints
**"All CI jobs passed"** and exits 0. Verified against the workflow: **no
downstream job carries an `if:` condition of any kind**, so `skipped` can only
ever mean "a dependency failed" — accepting it buys nothing and costs the entire
workflow. The four `aai-templates` specs that read `check.yml` only assert that
gate *strings* appear in it; none looks at the gate job.

Fix is two lines: add `setup` to `needs`, and drop `"skipped"` from the accepted
results.

### M2. A NUL byte hides a shipped file from every ratchet — again

`packages/aai/host/workflow-keys.ts:79` writes its separator as a **raw NUL
byte**:

```text
const compositeKey = (workflow, key) => `${workflow}<NUL>${key}`
```

`git grep` classifies the file as binary and skips it, so it is exempt from all
11 `guard-invariants` line rules and all 7 `check-escape-hatches` patterns.
Verified three ways: the file holds 161 NUL bytes; `git grep -lI` over the
guard's own corpus does not list it; and `git grep -nIE 'workflow'` against a
file whose name and body are full of the word returns **0 lines**.

AGENTS.md records this exact failure already — "`host/workflow-notify.ts` held a
raw NUL byte, which makes a file BINARY to `git grep` — so it was silently
exempt from all nineteen rules and from `check:hatches`" — and the response was
to fix the one byte and add **no detector**. It has recurred in a different
file, which is the argument for the detector.

The corpus floor cannot catch it *by design*: the file is present in
`git ls-files`, and is invisible only to `grep`. Nothing compares the two lists.
Two cheap fixes, and both are worth doing: spell the separator ` `
(byte-identical behaviour, restores the file to text), and have
`assertScanCorpus` diff `git ls-files` against `git grep -lI -e '.'`, failing on
any difference that is not a known binary extension. The full diff today is 9
files: 6 `.woff2`, 2 `.ico`, and this one.

### M3. `aai-evals` is in no CI job, so its suites are gated by nothing

`.github/workflows/check.yml:152` lists eight packages in the test matrix.
`grep -c aai-evals .github/workflows/check.yml` returns **0**. The package has
seven test files and declares
`thresholds: { lines: 95, functions: 94, branches: 88, statements: 95 }`.

`scripts/check.sh` runs `turbo run test:coverage` unfiltered, so these pass
locally and are invisible in CI — the exact "green locally, red in CI" asymmetry
that AGENTS.md added `test:coverage` to `check.sh` to eliminate, running in the
opposite direction. Because the `ci` gate needs only the eight matrix legs, a PR
that breaks `aai-evals` unit tests is fully green.

This is **not** the documented eval-tier exemption: that is scoped to
`check:eval` (`packages/aai-evals/CLAUDE.md:99`), which is separately and
deliberately absent. The unit suites are ordinary tests.

### M4. `with-test-pg.mjs` exits 0 when the Supabase stack cannot be resolved

`scripts/with-test-pg.mjs:206`, `:211-225`, `:247`. `AAI_REQUIRE_STACK` is
exported only when `resolveStack()` succeeded; every failure path — no CLI,
stack down, unparsable `supabase status -o env` output — prints two lines and
lets the run continue. Demonstrated: with a bogus stack, the child process saw
`REQUIRE_PG=1 REQUIRE_STACK=undefined` and the script exited 0.

`check.yml:376-381` claims the opposite in its own comment — "so a variable that
stops arriving is a red job rather than a green one with the only arm for the
platform stores silently absent" — but the `platform-stack` job's only
enforcement *is* this script. With `AAI_REQUIRE_STACK` unset,
`_pg-test-utils.ts:146` turns `describeWithStack` into `describe.skip`, so
`supabase start` succeeding while `supabase status -o env` changes shape yields
a green job in which **`realtime-rls.scenario.test.ts` — the only walrus/RLS
leak test in the repository, and the file Part I flags as gating its own
negative control — never runs at all.**

Fix: a `--require-stack` flag that exits 1 when a stack was expected, passed by
the platform-stack job.

### M5. The `as any` budget is 100% phantom â the hatch gate has no comment filter

`scripts/check-escape-hatches.mjs:80-117`, `:193`. The script's header spends 25
lines on precisely this hazard ("these patterns are plain substrings with no
notion of code versus prose") and fixes it **for markdown only**.
`guard-invariants` solved the general case — `LINE_RULES` carries a per-rule
`skipComments` flag and passes a filter into the shared engine — and
`check-escape-hatches` calls the same `scanGroups` with no filter at all.

Measured: of 119 counted hatches, 25 sit on comment-only lines. Twenty-one of
those are correct (a `biome-ignore` *is* a comment). But **all four cast-pattern
hits on comment lines are prose**, and two of them are the entire `as any`
budget — `agent-tools.ts:35` and `agent-tools.test.ts:94`. Demonstrated on the
real gate: replacing that JSDoc sentence with a genuine
`export const smuggled = (globalThis as any).x;` leaves the run reporting
`as any allowed=2 now=2 … every file within its baseline ✓`.

So the repo's claim that it holds "3 `as any` (all three of which are prose in
comments, not casts)" is right about the prose and wrong about the protection: a
real cast can move into that budget without the gate noticing. Fix is a
per-pattern `skipComments: true` on the two cast patterns only.

### M6. Both baseline ratchets count matching LINES, not occurrences

`scripts/_ratchet.mjs:106`, `:176`. `grepMatches` runs `git grep -nIE` without
`-o`, and `scanGroups` increments once per returned row — i.e. per matching
*line*. Both baseline files describe themselves as recording "how many
**occurrences** each file is allowed".

Demonstrated on the real gate: three `as unknown as` casts on one line report
`found 1`; the same three on three lines report `found 3`. It is honest today —
measured 94 lines against 94 occurrences — so this is a structural undercount
rather than a live one. **Any file already at its budget can absorb further
hatches by appending them to the line that bought the budget**, and rule 16 is
affected identically. Fix: `-o` for the counting pass; the report already
carries `file:line`, so nothing is lost.

### M7. Rule 12 scans `aai-guest`, but most routes live in `aai/host`

`scripts/guard-invariants-scanners.mjs:192-204`. The rule exists because, per
AGENTS.md, the `GUEST_ROUTES` drift "has landed twice". Measured: the scan finds
**8** route literals in `packages/aai-guest`, while `GUEST_ROUTES` declares
**15**. The other seven — `/health`, `/websocket`, `/phone`, `/client-config`,
`/workflows`, `/session-events`, `/.well-known/workflow/v1/*` — are implemented
in `packages/aai/host/server.ts`, `host/telephony/telephony-server.ts`,
`host/session-events-api.ts`, `host/workflow-serve.ts` and
`sdk/workflow-api-client.ts`, all of which the guest bundles.

That is where the guest's HTTP surface actually grows, and it is entirely
outside the rule's pathspec: adding `if (url === "/metrics")` to
`host/server.ts` is served by every guest and invisible to the rule written to
catch exactly that.

### M8. Five more gates can report success over an empty or degenerate scan

Part I found four; the machinery review found five more, all the same shape.

- **`check-gateway-models.mjs:36-48`** has **no floor at all** — its `[^}]*`
  entry parser cannot cross a nested `}`, so one reformatted entry drops both
  the committed and the generated map to zero, the diff is empty, and it prints
  `catalog current — 0 advertised, 0 usable ✓`. The regression it exists to
  catch is a model silently removed from the gateway, which its own closing line
  says "reaches users as a retried 500, not a clear error".
- **`scripts/artifact-size-report.mjs:289`** does not floor
  `publishablePackages()`, though `_fs.mjs:103` documents that the caller is
  expected to ("an empty list means the scan stopped matching") and
  `api-report.mjs:310` does. Verified twice, including a hand-built degenerate
  report through `artifact-size-budget.mjs`: "no regressions ✓", exit 0.
- **`guard-invariants` rule 13** (`scanners.mjs:282`) discovers 175 template
  files with no floor — a new member of the already-reported rule 1/7/10 family,
  and the largest. `git ls-files` exits **0** on a pathspec that matches
  nothing, where `git grep` exits 1, which is why this half is silent and the
  grep half is not.
- **Rule 11** has a *third* corpus (`SOURCE_PATHSPECS` plus two exclusions,
  1,027 files) that neither `assertScanCorpus` call covers. It is the
  Windows-portability rule — the one whose regressions are invisible on every
  machine that runs CI.
- **`check-doc-examples.mjs:183`**'s floor is `MIN_EXAMPLES = 45` against a
  measured **98** examples today; the comment beside it still says "49 at the
  time of writing". More than half the corpus can stop being discovered while
  the gate prints `all N doc examples compile ✓`. Its `extractFences` separately
  drops blocks silently on an unclosed fence (demonstrated: a 2-example document
  with one backtick missing extracts 1).

`check-claude-md`, `check-publish-names` and `check-publish-protocols` floor at
`length === 0`, which only catches total failure — the real, stable numbers are
12 and 3.

### M9. The Postgres gate throws at import time in the *unit* tier

`packages/aai-server/_pg-test-utils.ts:58-67`, re-exported by
`packages/aai-server/test-utils.ts:39`. The gate's module body warns or throws
at load — deliberately, so a skipped scenario file fails loudly. But
`test-utils.ts` re-exports from it, and **49 unit test files** import
`test-utils`.

Proven: `vitest run auth.test.ts` prints the "real-Postgres suite not run"
banner on files containing no such suite, and
`AAI_REQUIRE_PG=1 vitest run auth.test.ts` **fails 2 of 3 files** with a message
about a database those files never touch. Turbo's strict env mode hides it under
`turbo run test`, so it surfaces only through the documented shortcuts — i.e.
exactly where a developer working on the platform arm has the variable exported.
Fix: move the gate out of the module body into
`describeWithPg`/`describeWithStack`; the "it fails the FILE" intent survives,
because the file that calls the gate is the file that fails.

### M10. Three turbo `inputs` gaps, each verified by hash A/B

The documented method — capture `--dry=json` hash, touch the file, capture
again; an identical hash is the bug — found three live cases:

- **`aai-server#test` does not hash its own `globalSetup`.**
  `packages/aai-server/vitest.config.ts:19` declares
  `scripts/ensure-guest-harness.mjs`; `inputs` globs resolve relative to the
  package and it is in neither `inputs` nor `globalDependencies`. Hash
  `795e731fbf0bde81` before and after editing that script — byte-identical,
  while `aai-templates#test:coverage` (which declares `$TURBO_ROOT$/scripts/**`)
  moved. So a change to the harness verify logic replays a cached green run.
- **`check:e2e` does not hash `vitest.shared.ts`** (`turbo.json:266-278`),
  though the e2e run imports `sharedConfig` through the slow config. The other
  four test tasks all declare it. Hash `f0b03dbaec637bfe` before and after.
- **`check:e2e` omits `VITEST_POOL` from `env`**, so
  `VITEST_POOL=forks pnpm test:e2e` is stripped silently — the same class as the
  `AAI_TEST_PM` bug the adjacent comment documents.

### M11. Four dead script chains, invisible to knip by configuration

`knip.json:44` declares `"scripts/**/*.{mjs,ts}"` as **`entry`** — so every file
in `scripts/` is an entry point by declaration, and the repo's one "what is
unused" tool can never report a dead script. Reachable from nothing:

- `gen-gateway-models.mjs` (no `package.json` script exists for it) and its only
  consumer `_api-key.mjs`; its verifier `check:gateway-models` is in
  `package.json` and in no pipeline at all.
- `starter-eval/builtins.mjs` and `starter-eval/tsconfig-ab.mjs`, which both
  read a `run.json` produced by `scripts/starter-eval/run.mjs` — a file that was
  deleted, as `builtins.mjs`'s own header line 22 says.
- (Adjacent: `scripts/aai-dev.sh`, referenced by nothing, duplicating
  `pnpm aai`.)

This is the documented dead-config family — `.size-limit.json` referenced by
nothing, an `ls-lint` config no pipeline ran, a `.turbo` path that never matched
`cacheDir`, six mutation scopes no guide mentioned. Narrow the knip glob to what
pipelines actually invoke so the exception becomes a reviewable line.

### M12. `unstubGlobals` belongs in the shared config

`vitest.shared.ts:17-26` sets `restoreMocks` and `unstubEnvs` and not
`unstubGlobals`, and nothing anywhere sets it. Measured: **41 files call
`vi.stubGlobal`; 22 hand-roll `vi.unstubAllGlobals()`; 19 clean up not at all.**
Proven with a scratch spec spreading `sharedConfig.test`: test A's stub is still
visible in test B and the suite passes.

The refutation pass clears the one risk — no file anywhere stubs a global inside
`beforeAll` — so per-test restoration breaks nothing. Adding it deletes 22
hand-rolled calls and closes 19 leaks, by exactly the argument the file already
makes for `unstubEnvs`.

### What Part II clears

As in Part I, the checked-and-cleared list is worth as much as the findings, and
several long-standing worries turned out to be fixed or unfounded:

- **The baseline `--update` contract holds.** Verified by construction: a new
  hatch is refused and the file is left byte-identical; a deleted file's entry
  is removed; a rename is lowered on one side and refused on the other. The
  corpus floor covers the `--update` path too (renaming `packages/` made it exit
  1 at 41 files).
- **POSIX-ERE portability is clean.** No rule uses `\b`, `\d`, `\s`, `\w`, a
  lookaround, or a non-greedy quantifier — every escape is standard ERE. The
  `\b` disaster has not been re-introduced.
- **Multi-line escapes are confined to rules 3, 4 and 19.** A multi-line probe
  over the full corpus for rules 2, 8, 9, 17 and 18 found zero escapes; Biome's
  trailing-operator formatting is why.
- **All nine package vitest configs spread `sharedConfig.test`**, none
  re-declares an inherited option, and **no `retry` exists anywhere** — not in
  the slow config, not per-package, not per-test.
- **A zero-match slow-tier run fails** (exit 1, "No test files found"), so the
  property AGENTS.md relies on holds.
- **CI's caches now sit with their producers** — `.tsbuildinfo` is a
  restore-and-save cache in the typecheck job, `.turbo` is the parent of
  `cacheDir`, and the matrix runs `test:coverage` rather than `test`. All three
  previously-documented bugs are fixed.
- **`.test-d.ts` files are genuinely gated** by `turbo run typecheck` — all four
  are inside their package program.
- **Every gate in the ratchet slice is wired into both `check.sh` and
  `check.yml`** — the two `check:*` lists were extracted and diffed: identical,
  24 entries each.
- **`check-doc-examples`' scratch directory cannot pollute the other gates**
  (`.gitignore:45-46`, verified with `git check-ignore`), and
  `check-template-types` cannot report success over an empty program (`tsc`
  exits non-zero on "No inputs were found").

### Two more corrections to AGENTS.md

Beyond the three in Part I, a fourth and a fifth:

1. **The `aai-ui` row of the vitest table is wrong in the opposite direction to
   the `aai-studio-client` row.** `AGENTS.md:1364` records `aai-ui` as
   **jsdom**; its config declares no `environment` at all, so 22 of 42 files opt
   in by pragma and 20 run in node. `_jsdom-setup.ts` guards on
   `typeof globalThis.Element !== "undefined"`, which is what makes the mismatch
   invisible. Fix one side or the other — but the table is what an agent reads
   before adding a test.
2. **Several counts in the guides have drifted from the tree**: "22
   capabilities" / "20 published entry points" against a measured 25 and 23;
   "`harness.mjs` — 13 MB" against 17.6 MB; "the guide is 78k characters"
   against 105,795; "the six files under `scripts/starter-eval/`" against 3;
   "(49 at the time of writing)" against 98. The gate floors keep the *specs*
   from rotting, so this is prose-only — but the drift is uniformly in the
   direction of understating how much the gates now cover.

### Revised order of work

M1 and M3 are CI configuration and cost minutes; M2 is one character plus a
detector. They come before everything in Part I:

1. **M1** — the required check accepts a failed build. Two lines.
2. **M3** — put `aai-evals` in the CI test matrix. One line.
3. **M2** — respell the NUL byte as ` `, and add the `git ls-files` vs
   `git grep -lI` diff to `assertScanCorpus` so the third occurrence fails
   loudly.
4. **M4** — `--require-stack`, so the only RLS leak test cannot silently vanish.
5. **Part I finding 1** — the SSRF redirect tests that make zero fetch calls.
6. **M5 + Part I finding 4** — the hatch gate's comment filter and the missing
   `as never` pattern are one change to one file; do them together, then
   `--update` the baseline.
7. Everything else, per package.
