---
"@alexkroman1/aai-runtime": minor
"aai-templates": minor
"aai-docs": patch
---

Fix every live template eval failure, and the instrument that hid them.

`pnpm test:eval:templates` failed 15 of 110 cases; it now fails none. The
instrument came first, because it is why finding them took eight passes:
`AAI_EVAL_REPEAT` and `AAI_EVAL_ONLY` were declared in `check:eval`'s `env`,
forwarded by `run-evals.mjs` and documented in its header, but read only by
`aai-evals` — for all 28 template suites both were silent no-ops. `eval/_env.ts`
reads them now and `SuiteSpread` reports the spread, so a case that failed only
SOME repeats prints as `UNSTABLE (n/m)` with the failure it saw and does not
fail, while one that failed every repeat does. Opt-in: an unset environment is
byte-identical to before. `describeWorkflowEval` is wired in too, which would
otherwise have left the five workflow suites silently running once.

The spread report is what caught the one caller-facing defect. `roadside-assistance-agent`'s
`acknowledge_disclosure` carried "after you have read it to them in full" in its
DESCRIPTION and nowhere else, so a live desk called `lookup_coverage`,
`acknowledge_disclosure` and `dispatch_truck` while never calling
`service_disclosure` — a truck went out on a fee nobody read the caller, in the
one template whose stated purpose is a price they were told about before it
moved. `service_disclosure` records the handover now and `acknowledge_disclosure`
refuses without it.

Eight template prompts had real defects, most of them one shape: an instruction
to ANNOUNCE a lookup with no instruction to then perform it (topic-briefing,
executive-inbox in three places), a tool the prompt never mentioned at all
(entertainment-picks' `recommend`), an escape hatch that literally permitted
answering uncited (web-research), reading a score conflated with awarding points
(text-adventure), a clarifying question asked over an already-complete objective
(research-planner), no positive counterpart to "never invent a value"
(hotel-reception), and every fee figure handed to the model behind a rule
forbidding it to summarise them (roadside `lookup_coverage`).

Several evals were wrong rather than the agents: three asserted values a SCRIPT
determined against a live model, two forbade a documented-valid outcome, one
demanded three distinct scores from three separate `ctx.generate` calls that
never see each other, and several read a multi-tool chain out of a single turn.
`EvalTestContext.mode` now carries the rule that would have prevented the first
three — a value a script determined may only be asserted under `mode === "stub"`.

Three new exports on `@alexkroman1/aai-runtime/eval`, moving that capability to
epoch 2 with epoch 1 retained: `expectCalled` names the tier's commonest finding
(the agent announced and stopped) in one assertion message that quotes the
sentence said in place of the tool; `lastToolResultIn` is `toolResultIn` without
the exactly-once refusal, which is right within a turn and wrong across turns;
and `EvalWorkflowEngineOptions.stepAttempt` lets a case reach a body's PRIMARY
branch — the engine only ever answered a first-and-only attempt, so
`isLastAttempt` was always true and `link-digest`'s degraded prompt was the only
one any eval had measured.
