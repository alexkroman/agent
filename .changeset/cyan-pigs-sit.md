---
"aai-evals": patch
---

Collapse the eval tier's duplicated seams, and make the starter grader reachable by a unit test.

The "blank counts as unset" env rule was spelled five times in three different semantics — including inside `envValue`, whose own doc warns that "a rule spelled out twice is one that can come to be spelled differently". It is one `_env.ts` now (`envValue` / `envFlag` / `envInt`), and `_gate.ts` keeps only the policy. `AAI_STEP_CAP_HINT` moved there too: it was `Number(process.env.X ?? 80)` in an eval file, so a blank value yielded `NaN` and every step-cap comparison answered false, reporting the agent as having run away.

`gradeStarter` — which decides which checks exist, under what label, and holds the failure taxonomy — sat in `starter.eval.test.ts`, a file `vitest.config.ts` excludes, so every function it calls was unit-tested while the thing calling them was not. That matters because the labels are the keys `EvalReport.unstable` reports and `AAI_EVAL_ONLY` matches. It is `starter-grade.ts` with its own tests. The move also proved a rule worth writing down: `_gate.ts` resolves a key and announces at import time, so nothing the unit tier loads may import it.

Also: `condense` was two identical bodies with different caps and `report.ts` owns it now; `failedScope`'s fourteen arms were a second copy of the vocabulary's label spellings and had already drifted, so they come from the real scope over zero events; `toolNames` / `describeToolCalls` / `responseErrorMessage` / `safeJsonParse` replace hand-rolled equivalents, and the first two render a tool call that never completed as such; `formatSpread` takes a spread rather than a report, so latency prints its range instead of a bare mean; `checkMode`'s `source` half produced two notes a passing check discards; `ContractRun`'s two booleans became a three-state `outcome`; `StudioTurn.ms` was written and never read; a contract run's child output was retained unbounded to report 800 characters of it; and the workspace materialization writes in parallel.
