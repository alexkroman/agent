# packages/aai-evals — the behaviour eval tier

The repo's eval FRAMEWORK — a recording runner, a spread report, an assertion
vocabulary over the session event stream, and the key gate — plus the level-1
behaviour cases that use it (private package). It is importable: `aai-studio-server`
drives the same runner for the studio starter eval. See "This package is a
LIBRARY, and what that excludes" for the subpaths and for the line between the
two. Repo-wide conventions and
the test-tier table live in the root `AGENTS.md`; the turbo rules are in
`.agents/ci.md`.

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
would be a worse outcome than having neither. `eval/stub-speech.ts` in
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

## The vocabulary reads a TEXT agent too, and grades VERIFICATION

`createTextAgent({ onEvent })` reports a turn as the same `SessionEvent` union a
voice session emits (`packages/aai-runtime/TEXT-AGENT-CLAUDE.md`), so
`assertions.ts` takes a text agent's events with **no second implementation** —
which was the whole point of narrowing that union rather than inventing a
parallel one. That is verified rather than asserted: `assertions.test.ts` drives
a real `runTextAgent` turn through the real `createTextAgent`, the real tool
executor and real tool results, and every arm of the existing vocabulary holds
over it. `openEvalTextAgent` (`@alexkroman1/aai-runtime/eval`) is the harness a
live case uses, and it hands back the same `EvalTurn` `say()` does.

Two differences a case meets, both properties of the MODE rather than of any
arm: there is no greeting turn, so `said()` opens empty where a session's opens
with the agent's line; and a text turn commits its reply ONCE, joined across
steps, where a session commits per utterance.

**What the vocabulary could NOT say is what a VERIFYING agent is graded on**, and
`tool-assertions.ts` is those three arms — spread into the same scope, recording
through the same prefixed `check`, in a sibling module only because
`assertions.ts` is at its 500-line cap:

- `toolResultMatching(pattern, { tools, min, max, count })` — did a result come
  back RED, and how many did. `calledTool(name, { result })` asks whether SOME
  call to ONE tool carried a substring; a verification is the other quantifier
  over the other axis, and the count is the REPAIR count.
- `noToolResultMatching(pattern, { tools })` — the green-at-the-end claim, whose
  failure carries the offending output itself rather than a tally.
- `eachToolFollowedBy(first, second)` — every write was CHECKED.
  `toolOrder(["write_file", "check_types"])` is a subsequence, so it holds when
  the agent wrote nine files and checked once; this is per occurrence, and zero
  calls to `first` FAILS on this vocabulary's standing rule that "nothing was
  measured" is not "nothing was wrong".

`calledTool` also takes `min`/`max` now, and all four counting arms share ONE
`countVerdict` — which fixed a bug the spelled-out copy carried: a `max` alone
is a CEILING and implied a floor of one, so `event(type, { max: 3 })` could not
hold at zero and `{ max: 0 }` could not hold at all.

**The classification stays the CASE's**, deliberately. A tool's result is a wire
string whose words that tool chose, so `/error TS\d/` is a fact about
`check_types` and not about the event stream — a vocabulary shipping
`buildFailed()` would be asserting on prose the agent's own tools may reword.
What these arms remove is the counting and the failure MESSAGE, which is the
half every hand-rolled version got wrong (a call that never completed rendering
identically to one that answered green).

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
(see `eval/stub-speech.ts` and `eval/session.ts`'s `repliedTo` in
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
OUTSIDE any package at `scripts/starter-eval/expectations.mjs`, which a
package-relative glob cannot see, and the cached UNIT tier had to name it in a
`turbo.json` override to avoid replaying a green run over an edited grader.
Moving the corpus into a package retired both the override and the hazard; it is
`aai-studio-server/src/studio-starter-expectations.ts` today.

**Four packages declare `check:eval`** — `aai-templates` (the template evals, and
the only one `pnpm check` and CI run, against a SCRIPTED model), this one,
`aai-guest` (the coding agent's in-process eval) and `aai-studio-server` (the
studio starter eval). The `env` block is declared once on the TASK, so every
package that declares the task gets every variable; `AAI_EVAL_ORIGIN`,
`AAI_EVAL_CONTRACTS` and `AAI_STEP_CAP_HINT` are read only by
`aai-studio-server`.

## The gate ANNOUNCES its skip

`gate.ts`, published as `aai-evals/gate`. The tier needs a live key and spends
real tokens, so it skips
without one — and a silent skip is the worst outcome available to a tier nobody
runs, because a green run of nothing is indistinguishable from a green run of
something. Same shape as `aai-server/_pg-test-utils.ts`: the skip prints how to
fix it, and `AAI_REQUIRE_EVAL` turns it into a hard failure. CI deliberately does
NOT set `AAI_REQUIRE_EVAL` — unlike the Postgres tier there is no argument for
gating merges on a live model's behaviour.

`describeEvalTierWhen` is how a caller adds a precondition of its own, and the
studio starter eval in `aai-studio-server` is the one caller — a `/health` probe
of the studio origin: with a key but no studio every case would fail as a
harness error, which reads like the codegen being broken. The gates COMPOSE: a
missing key still skips when the caller's own precondition holds.

**Importing this module RESOLVES a credential and ANNOUNCES at import time**, so
nothing the unit tier loads may reach it — `konsistent.json`'s
`eval-gate-is-not-unit-tier` here, and `studio-eval-gate-is-not-unit-tier` over
there, where the same hazard arrived with the eval. That is why the
side-effect-free readers are `env.ts` (`aai-evals/env`) and why the settings that
name a target read the environment through those rather than living behind the
gate.

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
`toolCallsInEvents` from the published subpath rather than restating them, which
is the same one-declaration rule that section records being bitten by twice, now
across a package boundary. What is REAL: `createRuntime`, the pipeline
transport, the LLM on a live key, the tool executor, `ctx` and its slots,
history trimming, the step budget, and the session event stream. What is not,
stated rather than papered over: `ws-handler.ts`, the audio pacer, and frame
ordering — all of which have unit and scenario coverage, where "given this
utterance, did the agent do the right thing" had none.

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
`@alexkroman1/aai-runtime/eval` — `konsistent.json`'s `eval-turn-terminators`
requires `assertions.ts` to import it, with the two event readers beside it,
rather than restate it, and carries the argument: the second bug above arriving
by a different route.

**`openEvalSession` releases the fake stages when its own setup throws.**
`installStubSpeechProviders()` registers a PROCESS-GLOBAL kind pair and the only
thing that unregisters it is the handle the function returns, so a runtime that
would not start, or a greeting that timed out, left the pair registered for the
worker's life with nobody holding a release. `runEval` catches the throw and
runs the next repeat, which is what made it compound — `AAI_EVAL_REPEAT=5`
against a failing agent orphaned five pairs. The runtime is shut down on that
path too.

## This package is a LIBRARY, and what that excludes

It is importable — five subpath exports, `@dev/source` only, since nothing here
builds:

| Subpath | What a consumer takes from it |
| --- | --- |
| `aai-evals/runner` | `runEval`, `createRecorder`, `EvalRecorder`, the report types |
| `aai-evals/report` | `formatEvalReport`, `evalShortfalls`, `condense` |
| `aai-evals/gate` | `describeEvalTier`, `describeEvalTierWhen`, `evalApiKey`, `evalKeyEnv`, `sayFromHarness` |
| `aai-evals/register` | `registerEvalCases`, `evalOnlySelects` |
| `aai-evals/env` | `envValue`, `envFlag`, `envInt` |

**Five and not seven.** `assertions.ts` and `tool-assertions.ts` are the natural
next entries and are deliberately NOT exported: no consumer imports them today,
and an export nobody resolves is the same dead-config shape this repo keeps
finding — the `.size-limit.json` nothing ran, the `ls-lint` config no pipeline
invoked. Adding one when a case outside this package needs the vocabulary is a
one-line change, and it will then be a line somebody can review.

`aai-studio-server` is the one consumer, and it exists because the STUDIO
starter eval lives there now — `studio-eval-target.ts`, `studio-starter-*.ts`,
`studio-template-contract.ts` and `studio-starter.eval.test.ts`, all of which
were in this `src/` until they were not. See "Studio starter evals" and
[`packages/aai-studio-server/STARTER-EVAL-CLAUDE.md`](../aai-studio-server/STARTER-EVAL-CLAUDE.md)
for what that eval measures, why single runs cannot adjudicate a prompt change,
and the template behaviour contract it can opt into.

**The line is what a module is ABOUT, not what runs it.** Everything here is
framework-general: it names no product surface, no HTTP route, no prompt and no
tool. Everything that moved named the studio in every constant it declared — its
chat route, its per-sandbox token, its step cap, the prose its own tools write,
the eighteen starter prompts and what each one asked for. The two halves had
been sitting in one `src/` since the tier absorbed `scripts/starter-eval/`, and
what that cost was legible: this package depended on `aai-studio-client` for the
starter list, on `undici`, `ai` and `eventsource-parser` for one target's
transport, and carried an `evals-package-boundary` exception for a subpath one
file read. All four are gone, and the boundary is a total deny again — which is
the half worth keeping, because a package that MAY import the studio's starter
list is one where the next studio-shaped eval will land.

Three mechanical consequences, each of which was a small decision:

- **`_gate.ts`, `_register.ts` and `_env.ts` lost their underscores.** The
  prefix means "not part of the public API, never import cross-package" (root
  `AGENTS.md`), and a subpath export pointing at one would say the opposite.
- **`evalOrigin`, `evalContracts` and `evalStepCapHint` went with the eval**, to
  `aai-studio-server/src/studio-eval-env.ts`, and read the environment through
  `aai-evals/env` from there rather than re-deriving "blank counts as unset" —
  the rule that was spelled five different ways before it was one function.
- **`eval-case-registration` and `eval-gate-is-not-unit-tier` each have a
  studio-side twin** (`studio-eval-case-registration`,
  `studio-eval-gate-is-not-unit-tier`). Two conventions rather than one widened
  `paths`, because konsistent matches an import SPECIFIER literally and
  `./register.ts` and `aai-evals/register` are two strings for one module — a
  single rule could require only one of them and would exempt the other package.

**No cycle, and it is worth being able to say why quickly.** `aai-evals`
depends on `@alexkroman1/aai` and `@alexkroman1/aai-runtime` and on nothing else
in the workspace; `evals-package-boundary` denies `aai-studio-server` from here,
so the edge cannot acquire a reverse. `turbo.json`'s `build` is
`dependsOn: ["^build"]` and would fail hard rather than quietly if it did.

## Adding a case

1. Put it in an existing `*.eval.test.ts`, in the array `registerEvalCases`
   takes — `konsistent.json`'s `eval-case-registration` requires that import
   and carries why the indirection is mechanical rather than stylistic.
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
