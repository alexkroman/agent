---
issue: TODO
status: proposed
last_updated: "2026-08-14"
---

# An in-repo behaviour eval tier

There is no way, inside this repository, to assert that an agent called the right
tool in the right order and said the right thing. Every such measurement in the
guides was produced by a harness that lives somewhere else — and one of them no
longer exists at all.

This proposes a fifth test tier whose assertions read the session event stream,
in the shape eve's eval framework already uses.

**Depends on `3-session-event-stream.md`.** The assertions are over the typed
event stream; without it there is nothing to assert against but log text, which
is what the external harnesses already do.

## What exists today, and what each of it is for

Three things look like they might cover this and none does:

- **`scripts/starter-eval/`** (1,335 lines of `.mjs`) grades **generated source
  code**, not behaviour. Its `expectations.mjs` (416 lines) is
  `toolNamesFromSource`, `toolDescriptionsFromSource`, `builtinsFromSource`,
  `checkMode(config, source)`, `checkWorkflowShape(files)`, `checkUi`,
  `checkCapabilities` — it asks whether the studio scaffolded a plausible agent,
  never whether that agent behaves.
- **The fuzz harnesses** (`pipeline-fuzz`, `s2s-fuzz`, the four `aai-ui/fuzz-*`)
  assert INVARIANTS over generated orderings — turn serialization, no callback
  after `stop()`, every `done()` settles. Property tests, and a different job:
  they prove nothing breaks, not that the right thing happened.
- **Unit and integration tests** exercise modules. The one that boots a real
  harness subprocess (`agent-server-integration.test.ts`) is documented as a
  standing judgement call, parked in the unit tier because promoting it drops
  `aai-server` coverage under its floor.

So the middle is missing: *given this input, did the agent do the right thing.*

## Every behaviour number in the guides came from outside the repo

This is the part that makes it worth a plan rather than a backlog note. The
guides are full of measurements presented as standing facts:

- "184 `speech_started` against 87 `cancelled` — 53% of the events the client
  acted on were not interruptions at all."
- "15 of 294 utterances corrupting a tool argument", "old 72% clean / 12.5%
  split / 8.6% merged" against "new 73% / 9.9% / 8.9%".
- "tool turns averaging 6.24s", "`pretoolspeech_rate` 0.933",
  "`verbosity_or_filler_rate` 0.38".
- Reward numbers that decide shipped constants: "1600/3500 scored **0.68** …
  against 800/1600's **0.12**", the measurement that reverted an endpointing
  change.

None of it is reproducible from this repository. `tau2-bench` is not a sibling
checkout — the only `tau2` references in the tree are the retail template's
FIXTURES (field names, `seed.json`, status strings). The guide names two Python
scripts as "**Two reusable instruments, both in tau2-bench** … do not rewrite
either", pointing at a repo that is not here. And the `speech_started` finding
above was "measured by replaying the benchmark's own recorded caller audio
against a live pipeline agent (the `scripts/voice-replay/` harness, **since
removed**)" — a number that shipped a behaviour change, cited from an instrument
that has been deleted.

That is the failure mode: a measurement that cannot be re-run is indistinguishable
from an assertion, and it decides constants. `DEFAULT_MAX_TURN_SILENCE_MS` has
already been changed and reverted twice on numbers like these.

## Prior art: eve's eval framework

eve treats evals as a first-class tier (`docs/evals/`, split across cases,
assertions, judge, targets, reporters, running). One `async test(t)` per case;
the runner drives the target, captures every event, and computes a verdict from
recorded assertions. Four properties are the ones worth taking:

**Assertions RECORD rather than throw.** "The runner reads every recorded result
to compute the verdict, so a single run reports every failing assertion rather
than dying on the first." For a behaviour eval that is the difference between
"turn 3 failed" and a profile of what the agent got wrong.

**The vocabulary is behavioural, not structural:**

```text
t.succeeded()  t.parked()  t.messageIncludes(token)
t.calledTool(name, { input, output, status, count })   t.notCalledTool(name)
t.toolOrder([...names])   t.usedNoTools()   t.maxToolCalls(n)
t.noFailedActions()
t.event(type, opts)   t.notEvent(type, opts)
t.eventOrder([...matchers])   t.eventsSatisfy(label, predicate)
```

**Assertions are SCOPED** — on `t` (the whole run), on a session (snapshotted
when called), on a turn (one immutable response). So "the agent called
`get_weather` exactly once *on that turn*" is expressible without hand-filtering
a log.

**Model grading is a separate surface** (`judge`), not mixed into the
deterministic assertions. That split matters here: the tau2 numbers this repo
quotes are a mix of DB-state reward and NL assertions, and conflating them is
what made "the agent talked better and acted worse" hard to see — recorded in the
guide as DB reward 1.00 → 0.40 while NL assertions rose 0.60 → 0.80.

## What it buys AAI specifically

- **`t.eventOrder` expresses invariants currently pinned by hand.** The audio
  pacer has two ordering rules — `audio_done` queued behind pending audio, and
  `cancelled`/`reset` discarding held audio — and there is a standing note that
  "audio pacing makes `reply_done`/transcript ordering load-bearing." Those are
  ordering assertions, written today as bespoke specs.
- **`t.calledTool` with `input` matching is the tool-argument-corruption
  metric.** "15 of 294 utterances corrupting a tool argument" is exactly
  `calledTool(name, { input })` over a dataset.
- **The `speech_started` finding becomes a test.** Its whole content is a ratio
  between two event types across a run — `t.event` counts plus a predicate.
- **A reward regression becomes a gate rather than a memory.** The 0.68 → 0.12
  endpointing revert was caught because somebody ran a benchmark by hand and
  compared against a number in a guide.

## Design

### Two levels, because the input is audio and eve's is text

This is the constraint eve does not have, and it is why the harnesses ended up
external. eve drives `t.send("What is the weather in Brooklyn?")`. A voice agent's
input is paced PCM.

- **Level 1 — text-driven.** Drive turns through the existing text/host path, no
  audio, no STT, no TTS. Deterministic, fast, in-repo, and covers everything
  above the audio boundary: tool choice, tool arguments, tool ORDER, step count,
  what the agent said, history handling. This is where eve's vocabulary transfers
  unchanged, and it is the level to build first.
- **Level 2 — audio replay.** Recorded caller audio, paced, against a live
  pipeline. The only level that can measure endpointing, splits/merges, barge-in,
  and the `speech_started` ratio.

**Neither substitutes for the other, and the guide already says so**: "a
turn-taking-only replay harness CANNOT settle this knob (no tools, no database,
so the truncated-auth regression is invisible to it)". Level 1 cannot see an
endpointing bug; level 2 without tools cannot see the bug the endpointing change
caused. Building level 1 and claiming coverage of level 2's questions would be
the worse outcome than having neither.

### A single score is not a result — variance is part of the verdict

The instrument is noisy in a documented, measured way: identical code has scored
**0.56 and 0.60** on the same tau2 tasks with **9 of 25 tasks flipping**
outcome. So a tier that reports one number per run invites exactly the mistake
the guide warns about ("measure the instrument before any A/B").

Requirements that follow: runs are repeated, the report carries a spread rather
than a point, and a pass/fail gate is set against the spread — or the tier
reports and does not gate. **Do not wire this into `pnpm check` as a merge
gate** until the variance is characterized; a flaky required check that blocks
merges is worse than an unreliable number nobody is forced to believe.

### Where it lives

A sixth tier alongside unit / integration / integration+pg / e2e / templates,
selected the way the slow tiers already are: `VITEST_PROFILE` in
`vitest.slow.config.ts` with a naming convention (`*.eval.test.ts`) so
membership needs no config edit — the same rule that fixed the hand-kept
integration file list.

Two mechanical rules the repo has already paid for. Any env var that selects
what the tier DOES (which target, how many repeats, which corpus) goes in the
owning turbo task's **`env`**, never `globalPassThroughEnv`: strict env mode
strips an undeclared variable silently, which is how `AAI_TEST_PM=npm pnpm
test:e2e` ran pnpm and said nothing, and `env` also keeps two different runs from
sharing one cache entry. And the tier's `inputs` have to include its corpus —
`$TURBO_DEFAULT$` rather than an extension list, per the audit that found five
tasks hashing only the file types that existed when they were written.

### It is also where the repo's OTHER bespoke runner should land

`scripts/starter-eval/` is a parallel test runner: `run.mjs` (485 lines) plus
`report.mjs` (175) plus `regrade.mjs` (85), with its own case loop, its own
verdict aggregation and its own reporter, none of it vitest. Its ASSERTIONS are
different job — `expectations.mjs` grades generated source, not behaviour, which
is why this document lists it under "what exists today and does not cover it" —
but the machinery underneath is exactly what this tier builds: run N cases
against a target, record every result rather than throwing on the first, and
verdict.

So the honest sequencing is: build the runner here so that recorded assertions
and a spread-carrying report are tier infrastructure, then move starter-eval's
expectations onto it and delete its harness. That is the largest single deletion
this whole series makes available in build tooling — a second runner and reporter
whose only reason for existing is that the first tier could not host it. Left
undone, the repo ends with two eval runners, which is the failure this series
keeps naming.

Worth noting what that fixes incidentally: `scripts/starter-eval/` is the
directory the `scripts/**/*.mjs` pathspec bug matched *exclusively* — a literal
slash makes a subdirectory mandatory, so for as long as the file-length gate
existed it measured those six files and none of the ~29 at the top level. Six
files under a gate nobody meant to point there is a strange place for 1,335 lines
of unreviewed harness to live.

Level 2 needs recorded audio, which is bytes in the repo. Given the guide's
existing rule that a workflow input may not carry bytes and that
`aai-templates`' fixtures are already committed, the honest options are a small
committed corpus or a fetch-on-demand cache; that is a real decision and belongs
in implementation rather than being guessed here.

## Scope

| Change | Where |
| --- | --- |
| Eval runner: `test(t)`, recorded assertions, verdict from all of them | new package or `scripts/`, driving a real server |
| Assertion vocabulary over the typed event stream (doc 3) | same |
| Level 1 target: text/host-driven turns | reuses the existing text path |
| Level 2 target: paced audio replay | new; needs a recorded corpus |
| Repeat-and-report-spread; NOT a merge gate initially | the runner |
| Tier wiring by `*.eval.test.ts` + `VITEST_PROFILE`; selectors in the task's `env`, corpus in its `inputs` | `vitest.slow.config.ts`, `package.json`, `turbo.json` |
| Move starter-eval's expectations onto the runner; **delete** `run.mjs` / `report.mjs` / `regrade.mjs` (745 lines) | `scripts/starter-eval/` |

## Open questions

- **Does this replace the external harnesses or sit beside them?** tau2 is a
  benchmark with its own task suite and reward model; reimplementing it is not
  the goal. The goal is that the invariants and metrics this repo's own guides
  cite are expressible here. Where the line falls needs deciding before level 2
  is built, or the tier grows into a benchmark reimplementation.
- **Is a model-graded judge in scope?** "Did it say the right thing" needs one,
  and it is also the noisiest possible assertion. Deterministic assertions first;
  a judge only once the variance work above exists to measure it with.
- **Does level 1 use host mode?** It is how the external harness connects today
  (see `6-dynamic-agent-definition.md`), and that plan may reshape it. If both
  land, level 1 should drive whatever replaces `buildHostAgent` rather than the
  `?host=1` path.
