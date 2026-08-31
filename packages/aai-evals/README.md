# aai-evals

The repo's **behaviour eval tier**: the runner, its assertion vocabulary over the
session event stream, and its two targets. Private — it ships nowhere.

An eval is not a test. A test asserts a deterministic fact and gates a merge; an
eval measures a probabilistic system and **reports**. Identical code has scored
0.56 and 0.60 on the same task set with 9 of 25 tasks flipping outcome, so a
green run here is weaker evidence than a green test run and a red one is not
automatically a regression. Nothing in this package gates `main`.

## Running it

The tier needs a live AssemblyAI key and spends real tokens on it.

```sh
pnpm dev:aai-server            # in another shell — the starter eval drives a real studio
pnpm test:eval                 # every eval, live
pnpm test:eval:templates       # just the 25 template evals, live
```

Both resolve the key the way every developer tool here does — exported
`ASSEMBLYAI_API_KEY` wins, else what `aai login` saved — and set
`AAI_REQUIRE_EVAL=1` so a case that would skip or quietly fall back to the
scripted model fails instead. That default exists because it was not always
there: before it, `pnpm test:eval` on a machine with a saved key ran all 25
template evals against a SCRIPTED model and printed `25 passed (25)`.

| Flag / variable | Effect |
| --- | --- |
| `AAI_EVAL_ONLY=pizza` | one case, substring match on its name |
| `AAI_EVAL_REPEAT=3` | repeat and report the spread — see below |
| `AAI_EVAL_MIN_SCORE=0.8` | opt into gating, against the spread's LOWER bound |
| `AAI_EVAL_CONTRACTS=1` | also run each starter's template behaviour contract |
| `AAI_EVAL_ORIGIN=…` | a studio somewhere other than `127.0.0.1:8080` |
| `--stub` | scripted model — the wiring check CI gates on |
| `--allow-scripted` | let a template missing its provider key degrade rather than fail |

`templates/pipeline-simple` names an Anthropic LLM stage, so a live run of it
also wants `ANTHROPIC_API_KEY`; without it, use `--allow-scripted`.

## What is in here

| File | Role |
| --- | --- |
| `runner.ts` | one case, N times, every assertion RECORDED rather than thrown |
| `report.ts` | the spread, the flip list, failure grouping |
| `assertions.ts` | the vocabulary over a session's event stream |
| `behaviour.eval.test.ts` | **level 1** — four cases against a small fixture agent |
| `starter.eval.test.ts` | the **studio codegen** eval, one case per starter |
| `studio-target.ts` | drives the studio's real HTTP/SSE surface |
| `starter-expectations.ts` | what each starter prompt asked for, as checkable facts |
| `template-contract.ts` | runs a template's own eval against the generated agent |

## Three things worth knowing before reading the code

**Assertions record, they do not throw.** An `expect()` that throws turns a
behaviour run into a bisect — the first failing turn ends the case and everything
after it is unmeasured. What a behaviour eval wants is a PROFILE: "it called the
right tools in the wrong order and never said the confirmation", not "turn 3
failed". `check(ok, label, detail)` is the only primitive.

**One number is not a result.** A run reports `min`/`max`/`mean` over repeats
and, more usefully, the assertion labels that were **not unanimous** across them.
That list is the instrument measuring itself: an assertion in it cannot
adjudicate a change until it is out of it.

**The coding agent writes its own tests**, so "the tests passed" is a measure it
can satisfy by weakening an assertion. Everything the starter eval grades is
therefore something the agent does not control: the capabilities its PROMPT
enumerated, checked against the loaded config and `agent.ts`, and — with
`AAI_EVAL_CONTRACTS=1` — the template's own `agent.eval.test.ts`, read from
`packages/aai-templates/` and written over whatever the workspace carried.

## Two levels, and only one is built

- **Level 1 — text-driven. BUILT.** Everything above the audio boundary: tool
  choice, tool arguments, tool ORDER, step count, what the agent said.
- **Level 2 — paced audio replay. NOT BUILT.** The only level that can measure
  endpointing, splits and merges, barge-in, and the `speech.started` /
  `reply.cancelled` ratio.

Neither substitutes for the other, and **nothing here may be named, documented or
reported in a way that implies level 2 coverage.** Level 1 cannot see an
endpointing bug; level 2 without tools cannot see the bug an endpointing change
caused.

## More

`CLAUDE.md` in this directory carries the arguments — why the tier does not gate,
how the gate announces its skip, the two harness bugs that would have made a
report lie, and how to add a case.
