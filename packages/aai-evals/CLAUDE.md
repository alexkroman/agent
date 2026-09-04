# packages/aai-evals — the behaviour eval tier

The repo's eval runner and its cases (private package). Repo-wide conventions,
the test-tier table and the turbo rules live in the root `AGENTS.md`.

## What this exists for

There was no way, inside this repository, to assert that an agent called the
right tool in the right order and said the right thing. Every such measurement
in the guides was produced by a harness that lives somewhere else, and one of
them no longer exists at all — `packages/aai/CLAUDE.md` cites "184
`speech_started` against 87 `cancelled`" from `scripts/voice-replay/`, "since
removed". A measurement that cannot be re-run is indistinguishable from an
assertion, and these decide shipped constants: `DEFAULT_MAX_TURN_SILENCE_MS` has
been changed and reverted twice on numbers like those.

Three things looked like they covered this and none did. The fuzz harnesses
assert INVARIANTS over generated orderings (nothing breaks — not that the right
thing happened). Unit and integration tests exercise modules. And
`scripts/starter-eval/` graded generated SOURCE, not behaviour. So the middle
was missing: **given this input, did the agent do the right thing.**

## Two levels, and only one of them is built

The constraint eve's eval framework does not have, and the reason the harnesses
ended up external: eve drives `t.send("What is the weather in Brooklyn?")`, and
a voice agent's input is paced PCM.

- **Level 1 — text-driven. BUILT.** `behaviour.eval.test.ts`, over the
  published target (`@alexkroman1/aai-runtime/eval`). Everything above the audio
  boundary: tool choice, tool arguments, tool ORDER, step count, what the agent
  said, history handling.
- **Level 2 — paced audio replay. NOT BUILT.** The only level that can measure
  endpointing, splits and merges, barge-in, and the `speech.started` /
  `reply.cancelled` ratio.

**Neither substitutes for the other**, and the SDK guide already says so: "a
turn-taking-only replay harness CANNOT settle this knob (no tools, no database,
so the truncated-auth regression is invisible to it)". Level 1 cannot see an
endpointing bug; level 2 without tools cannot see the bug an endpointing change
caused. **Nothing here may be named, documented or reported in a way that
implies level 2 coverage** — building level 1 and claiming level 2's questions
would be a worse outcome than having neither. `eval/fake-speech.ts` in
`aai-runtime` repeats the warning at the seam where it would be forgotten.

**Level 2's corpus decision is deferred, not made.** The honest options were a
small committed corpus of recorded caller audio or a fetch-on-demand cache, and
committing bytes for a level nobody has written is the version of that choice
that ages worst: the shape of the corpus follows from what the paced replay
target needs (sample rate, per-utterance framing, whether a barge-in point is
annotated), and none of that is known yet. So: **fetch-on-demand, keyed by
content hash, when level 2 is built** — the same rule the platform's blob store
uses, and it keeps a multi-megabyte corpus out of every `git clone` and out of
the `aai-cli` tarball that ships `templates/`. Nothing is committed today and
nothing here reads audio.

## The runner: assertions RECORD, they do not throw

`runner.ts`. A case body is handed an {@link EvalRecorder} and calls
`check(ok, label, detail)`; `runEval` runs the body N times and reports. An
`expect()` that throws turns a behaviour run into a bisect — the first failing
turn ends the case and everything after it is unmeasured — where what a
behaviour eval wants is a PROFILE: "it called the right tools in the wrong order
and never said the confirmation", not "turn 3 failed".

Two consequences worth knowing:

- **`check` is the only primitive.** The event vocabulary (`assertions.ts`) and
  the studio's source-grading expectations both go through it, which is what let
  `scripts/starter-eval/`'s 745-line second runner be deleted rather than
  reimplemented. One tier, one runner.
- **A HARNESS failure is kept apart from a failed assertion.** A dead sandbox
  and a wrong tool call want different fixes, and averaging them hides both. A
  throw from the body is recorded as that pass's `error`; the other repeats still
  run.

  **And it is kept out of the SCORE, which for a while it was not.** `runEval`
  averaged every pass, so a pass that died after two passing checks scored 1.0
  and set `score.max` — a harness failure could RAISE the number the tier is read
  for and widen the spread, and `AAI_EVAL_MIN_SCORE` (which asserts `score.min`)
  was partly answering a question about the harness. `score` and `ms` are over
  the passes that did NOT die; `measuredPasses` says how many that was, and a
  report with `measuredPasses: 0` prints `not measured` rather than the 0% an
  empty spread would otherwise produce. `unstableLabels` was already guarded this
  way — the spread simply had not caught up.

## One number is not a result

The instrument is noisy in a measured way: identical code has scored **0.56 and
0.60** on the same tau2 tasks with **9 of 25 tasks flipping** outcome. So:

- runs REPEAT (`AAI_EVAL_REPEAT`), and the report carries `min`/`max`/`mean`
  plus the width — `75% (50%–100%, ±50%)`, never a bare mean;
- `EvalReport.unstable` names the assertion labels that were **not unanimous
  across repeats**. That list is the instrument measuring itself: an assertion in
  it cannot adjudicate a change until it is out of it;
- an assertion a pass never REACHED is missing data, not a flip — otherwise every
  harness error would read as agent nondeterminism.

**This tier is not a merge gate and must not become one.** THIS package's
`check:eval` is absent from `pnpm check`, from `scripts/check.mjs` and from CI —
each of which runs `check:eval` filtered to `aai-templates`, in scripted-model
mode, which is a wiring gate and not a live measurement (see
`packages/aai-runtime/CLAUDE.md`). A flaky required check that
blocks merges is worse than an unreliable number nobody is forced to believe.
`AAI_EVAL_MIN_SCORE` makes it assert, and it asserts `score.min` — the spread's
LOWER bound — because a mean over a flipping suite passes on a lucky repeat.

**A model-graded judge is a separate surface and is not built.** "Did it say the
right thing" needs one and it is also the noisiest possible assertion; the tau2
numbers this repo quotes mix DB-state reward with NL assertions, and conflating
them is what made "the agent talked better and acted worse" hard to see (DB
reward 1.00 → 0.40 while NL assertions rose 0.60 → 0.80). Deterministic
assertions first; a judge only once the variance work above exists to measure it
with. `saidSomething(token)` is a substring/regexp check and is not a judge.

## Measured, on the day it landed

4 level-1 cases × 5 repeats × 3 runs = 60 passes, one small support agent on the
default AssemblyAI pipeline LLM:

| | |
| --- | --- |
| score | **100% in all 60 passes**, per-case spread **±0%**, `unstable` empty |
| wall clock | **46s / 93s / 70s** per 20-pass run — 2.0x between the fastest and slowest |
| one repeat of all four cases | ~6s |

The finding is the asymmetry: at this scope the SCORE is not the noisy thing,
LATENCY is. Read the 100% carefully — it says these four cases do not
discriminate between a good agent and a slightly worse one; it does not say they
check nothing. They failed loudly on two real harness bugs during development
(see `eval/fake-speech.ts` and `eval/session.ts`'s `repliedTo` in
`aai-runtime`), which is the
discrimination evidence there is. A case that flips is more informative than one
that always passes, and the way to get there is a harder case, never a lower
floor.

## The tier's own wiring

Membership is the `.eval.` infix — `*.eval.test.ts`, excluded by this package's
`vitest.config.ts` and selected by `test:eval`, so a new eval needs no config
edit. `VITEST_PROFILE=eval` in `vitest.slow.config.ts` sets the timeout (30 min:
one studio codegen turn legitimately runs for minutes).

```sh
pnpm test:eval                                   # the whole tier
AAI_EVAL_REPEAT=5 pnpm test:eval                 # a spread worth reading
AAI_EVAL_ONLY="cancels only" pnpm test:eval      # one case
AAI_EVAL_MIN_SCORE=0.8 pnpm test:eval            # opt in to gating
```

Every one of those variables is in `check:eval`'s **`env`** in `turbo.json`, not
in `globalPassThroughEnv`: strict env mode strips an undeclared variable silently
(the failure that made `AAI_TEST_PM=npm pnpm test:e2e` run pnpm).

**`AAI_EVAL_ONLY` is one variable across the whole tier, and a file it selects
nothing from WARNS rather than failing.** The first draft failed it, on the rule
that a mistyped filter must not read as a passing tier — and that is wrong here,
because each eval file sees only its OWN cases in its own vitest worker, so
`AAI_EVAL_ONLY="math tutor"` correctly selected one starter and failed the
level-1 file for not containing it. A typo now ends in a run with zero cases and
one warning per file listing what it could have matched. The unmatched file still
registers a passing test naming the situation: vitest fails a file whose suite
holds no test at all.

**`check:eval` sets `cache: false`, and it is the one task in the repo where the
`inputs` rule does not apply.** Everywhere else a task is a pure function of its
inputs and the fix for a replayed green run is to hash more; here two runs of the
same tree legitimately differ, so a cache hit would REPLAY a measurement rather
than take one — the second `pnpm test:eval` of a variance check would print FULL
TURBO and the first run's number. No `inputs` are declared rather than declaring
a set nothing reads; if this ever becomes cacheable, a package-relative
`$TURBO_DEFAULT$` is now enough. It was not always: the starter corpus lived
OUTSIDE the package at `scripts/starter-eval/expectations.mjs`, which a
package-relative glob cannot see, and the cached UNIT tier had to name it in a
`turbo.json` override to avoid replaying a green run over an edited grader.
Moving the corpus in retired both the override and the hazard.

## The gate ANNOUNCES its skip

`_gate.ts`. The tier needs a live key and spends real tokens, so it skips
without one — and a silent skip is the worst outcome available to a tier nobody
runs, because a green run of nothing is indistinguishable from a green run of
something. Same shape as `aai-server/_pg-test-utils.ts`: the skip prints how to
fix it, and `AAI_REQUIRE_EVAL` turns it into a hard failure. CI deliberately does
NOT set `AAI_REQUIRE_EVAL` — unlike the Postgres tier there is no argument for
gating merges on a live model's behaviour.

The starter eval carries a SECOND gate, a `/health` probe of the studio origin:
with a key but no studio every case would fail as a harness error, which reads
like the codegen being broken.

## Level 1 does NOT drive `?host=1`, and the plan expected it to

The plan this tier came from left "does level 1 use host mode?" open, and the
answer is that it CANNOT: **the client protocol has no text command.**
`sdk/protocol-commands.ts` carries five commands (`audio_ready`, `cancel`,
`reset`, `playback_progress`, `tool_result`) and a user turn reaches a session as
PCM and nothing else — so a text-driven level 1 has no socket to speak down.
Host mode is unaffected and unblocked (the per-session agent-definition resolver
that would have needed it cannot be built safely); it is simply the wrong seam
for a text target, and the right seam is below the wire.

So the level-1 target drives `runtime.createSession()` with a recording
`ClientSink`, the agent's own `events` hooks feeding the assertions, and the two
speech stages faked. **That target is no longer in this package**: it is
published as `@alexkroman1/aai-runtime/eval` (`openEvalSession`, the fake speech
stages, the event readers, and `describeEval` on `/eval/vitest`), because a
template is a user's project and had no way to ask this question at all — see
"Driving an agent from text is a published surface" in
`packages/aai-runtime/CLAUDE.md`. What stays here is the half that is a promise
about a NOISY instrument: the recording runner, the spread report, and the
assertion vocabulary. `assertions.ts` imports `TURN_ENDS`, `saidIn` and
`toolCallsIn` from the published subpath rather than restating them, which is the
same one-declaration rule that section records being bitten by twice, now across
a package boundary. What is REAL: `createRuntime`, the pipeline transport, the
LLM on a live key, the tool executor, `ctx` and its slots, history trimming, the
step budget, and the session event stream. What is not, stated rather than
papered over: `ws-handler.ts`, the audio pacer, and frame ordering — all of which
have unit and scenario coverage, where "given this utterance, did the agent do
the right thing" had none.

**The fakes go in through `registerSttKind`/`registerTtsKind` on
`@alexkroman1/aai-runtime`.** That seam's own doc gives the reason: a fake
resolving through the registry resolves exactly like a real provider, its env var
included, and production code only ever sees descriptors. Exporting it widened
`/runtime` — a NON-authoring subpath, so no capability contract moves — and
`SttOpener`/`TtsOpener` lost their `@internal` tags with it, since they are now
that seam's parameter type. They stay OFF `/stt` and `/tts`, where the rest of
the opener-layer types live: an agent author picks a descriptor and never writes
an opener.

## Two harness bugs, and why they are documented in code

Both were found by the tier failing on its first live run, and both are the class
of bug that would have made a report LIE rather than error:

- **The fake TTS must forward NO AUDIO.** A chunk of silence per flush looks
  harmless; the pipeline estimates playback open-loop from forwarded audio plus
  a grace, so for several hundred ms after a reply the agent is modelled as holding
  the floor — and a harness that commits its next utterance in the same tick
  commits it *during* speech, i.e. as a barge-in. Every case after the greeting
  recorded a spurious `reply.cancelled`.
- **`say()` waits for the reply to THIS utterance.** Waiting for "a reply
  terminator" settled on the previous reply's cancel, so `say()` returned before
  the model had run and the case recorded "called no tools" — a green harness
  reporting a broken agent. The utterance's own `user-transcript.committed` is the
  anchor; every event of its reply follows it.

**What ENDS a reply is declared once**, `TURN_ENDS` in
`@alexkroman1/aai-runtime/eval`, imported by both the session that WAITS on it
and `assertions.ts`, which partitions a run into turns with it. It was written
out in both, and the two must agree by construction: a third terminator added to
one copy makes `say()` return mid-reply while the assertions still think the turn
is open — the same shape as the second bug above, arriving by a different route.
The declaration crossing a package boundary is what makes the rule hold now that
the target is published.

**`openEvalSession` releases the fake stages when its own setup throws.**
`installStubSpeechProviders()` registers a PROCESS-GLOBAL kind pair and the only thing
that unregisters it is the handle the function returns, so a runtime that would
not start, or a greeting that timed out, left the pair registered for the
worker's life with nobody holding a release. `runEval` catches the throw and runs
the next repeat, which is what made it compound — `AAI_EVAL_REPEAT=5` against a
failing agent orphaned five pairs. The runtime is shut down on that path too.

## The studio starter eval

`starter.eval.test.ts` + `studio-target.ts` are `scripts/starter-eval/run.mjs`'s
case loop, verdict and reporter (485 + 175 + 85 = 745 lines, deleted) on the
shared runner. The GRADING is a different job — those checks read generated
source rather than behaviour — so it was kept when the runner was not, and it is
`starter-expectations.ts` in this package. See "Studio starter
evals" in `packages/aai-studio-server/CLAUDE.md` for what it measures and why
single runs cannot adjudicate a prompt change.

**It was `scripts/starter-eval/expectations.mjs` until it was the last file
there.** Its two neighbours were deleted as dead chains; it survived as the one
thing in that directory nothing had outgrown, reached by both starter suites
through a `../../scripts/` specifier. That cost a package `allowJs`, two
`turbo.json` input overrides to hash a corpus living outside the package that
reads it, and a grader whose eval-only half — `parseLoadedConfig`, `checkMode`,
`checkWorkflowShape`, `checkUi` — was in no coverage report at all, so it was
exercised only by a run needing a live key and a live studio. Moving it in
retired all three; the four functions have unit tests now.

**The same shape recurred one level UP, and `starter-grade.ts` is the fix.**
`gradeStarter` — which decides WHICH of those four run, under what label, and
holds the failure taxonomy — sat in `starter.eval.test.ts`, a file
`vitest.config.ts` excludes. So every function it calls was unit-tested while
the thing calling them was not, which matters because the labels are the keys
`EvalReport.unstable` reports and `AAI_EVAL_ONLY` matches: renaming one silently
resets the flip history with nothing red. It is a module with its own tests now,
driven by a canned `StudioTurn`.

**Note what that move exposed: `_gate.ts` may not be imported by anything the
UNIT tier loads.** Importing it resolves a key and ANNOUNCES at import time —
or, under `AAI_REQUIRE_EVAL`, throws — so a unit-tested module reading a setting
from there fails the whole file on any machine with that variable set and no
key. Verified before it landed. The tier's side-effect-free settings therefore
live in `_env.ts` (`envValue` / `envFlag` / `envInt`, plus `evalStepCapHint`)
and `_gate.ts` keeps only the POLICY: which precondition a tier has, what a
missing one means, and when a skip becomes a failure. That module also exists
because the "blank counts as unset" rule was spelled FIVE ways in two files —
including inside the function whose own doc warns that "a rule spelled out twice
is one that can come to be spelled differently".

**`run.mjs` could not have run, and porting it is what found that out.** The
chat request belongs to the GUEST and is authenticated by the per-sandbox token
the session broker returns beside the URL; `run.mjs` sent the account's API key
and gets `401 {"error":"Unauthorized"}`. So the harness the guides cite numbers
from had rotted, in the way a second runner nobody exercises does. Verified
against a live studio after the fix: one starter, **100%, 15s**, driving create
project → broker a sandbox session → stream a chat turn → read the synced
workspace.

The port also **dropped one check `run.mjs` never made**: a bare "did it write a
`client.tsx`". That file was recorded as INFORMATION there and kept out of the
`shippable` verdict, because most starters never ask for a UI — asserting it
failed the math-tutor template for shipping exactly what it should. `checkUi` is
the whole UI claim.

**`regrade.mjs`'s job is not reproduced, deliberately.** It re-graded a SAVED run
with today's expectations, because the grader had been corrected four times after
the runs it should have applied to. The cheap version of that is
`starter-expectations.test.ts`, which was a fail-fast block at the top of
`run.mjs` — so it ran only when somebody spent tokens — and is now a UNIT test:
an expectation demanding a tool its prompt never asks for, and a
`builtinDelegation` that passes on prose alone, both fail in the ordinary test
run with no key, no studio and no model.

## The template behaviour contract (opt-in)

`template-contract.ts`. The starter eval grades generated SOURCE — does a tool
whose name or description carries "cancel" exist, is the mode pipeline, is there
a client that reads live state. Every one of those is a question about
STRUCTURE, and a generated retail desk can answer all of them while
authenticating nobody. The other half of this package grades BEHAVIOUR, and for
a long time nothing ran it against generated code: the two halves sat disjoint,
and the starter eval's verdict stopped exactly where the interesting question
started.

```sh
AAI_EVAL_CONTRACTS=1 AAI_EVAL_ONLY=retail pnpm test:eval
```

**The contract is the TEMPLATE'S OWN `agent.eval.test.ts`, and three facts make
that work.** Twelve of the eighteen starter prompts say "use the `<name>`
template", which makes the template the ask rather than an illustration —
`checkCapabilities` already special-cases them for it. Twenty-five of the
twenty-six templates ship an eval. And those files were written to drive a
DEPLOYED agent rather than their own directory: they import `virtual:aai/agent`,
which `aaiAgentPlugin` resolves against the IMPORTER's directory, so dropping one
into a materialized workspace drives that workspace's agent. They also assert
MECHANISMS — a refusal sentence, a tool result, the projection sent to the
browser — never the words the model chose, which is what lets a
different-but-valid implementation pass.

**The canonical copy always wins.** `use_template` copies template files verbatim,
eval file included, so a workspace can arrive holding a contract the coding agent
was then free to edit. `contractWorkspace` overwrites it with the copy read from
`packages/aai-templates/`. That is the whole non-gameability argument, and it is
the same one `starter-expectations.ts` rests on: the prompt is ours, the contract
is ours, and the only thing the agent controls is the agent.

**Why the scratch directory is inside this package.** A contract imports
`@alexkroman1/aai/protocol`, `@alexkroman1/aai-runtime/eval`, `vitest` and `zod`,
and Node resolution walks UPWARD — a directory under `packages/aai-evals/`
resolves all four with nothing installed, where one in `tmpdir()` resolves none.
It is `.eval-workspaces/`, gitignored, and removed in a `finally`: a leak here is
a tree that `git status`, `biome check` and `tsc` all walk into.

**Off by default, and that is a cost decision rather than a doubt.** A contract
run is a live model session on top of a codegen turn that already takes minutes,
so making it unconditional would roughly double the tier's wall clock and spend
to answer a question most runs are not asking. A starter naming no template, or
naming one that ships no eval, records NOTHING rather than a passing check — a
check that cannot fail is one more line saying "green" for no reason.

**What is NOT verified: the live path.** The selection, the overwrite, the
materialization, the cleanup and the subprocess plumbing all have unit tests
(`template-contract.test.ts`, 23 of them, with the vitest spawn faked and
`spawnCommand` driven through `node -e`). What no test here reaches is one real
`npx vitest run` against a real generated workspace, because that needs a live
studio, a key and a model. Treat the first `AAI_EVAL_CONTRACTS=1` run as the
validation it has not had — and note that a contract failing for want of the
template's DATA files, rather than for behaviour, is the failure mode to watch:
`use_template` copies them, but only if the agent asked for them.

## Adding a case

1. Put it in an existing `*.eval.test.ts`, in the array `registerEvalCases`
   takes. Registration lives in `_register.ts` for a mechanical reason: Biome's
   `noMisplacedAssertion` accepts an `expect` only inside a literal `test(` call,
   so an `expect` reached through a `const run = matches ? test : test.skip`
   alias — or `test.skipIf(…)(…)` — is a lint error.
2. Name it in a way that survives a rename: the name is the key `unstable`
   reports and the thing `AAI_EVAL_ONLY` matches.
3. Assert through the vocabulary in `assertions.ts`, and prefer a TURN scope
   (`all.turn(1).calledTool(…)`) to a whole-run one — "on that turn" is most of
   the meaning, and `turn(index)` out of range FAILS rather than silently
   asserting nothing.

   **That claim used to be true of the first call only.** An out-of-range
   `turn()` recorded one failure and then returned an EMPTY scope — and half the
   vocabulary is negative (`noErrors`, `notEvent`, `notCalledTool`,
   `usedNoTools`, `maxToolCalls`, `saidNothingAbout`), every one of which holds
   vacuously over no events. So a three-call chain on a turn that never happened
   recorded one failure and two passes and scored **75%**, which reads as a
   mostly-correct agent. It returns a scope that fails EVERY assertion now, each
   under its own label, because "nothing was measured" is not "nothing was
   wrong".
4. Reach for `eventsSatisfy(label, predicate)` for a claim the vocabulary does
   not carry — a ratio between two event types is the shape the guides' own
   findings take.
