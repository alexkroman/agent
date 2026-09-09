---
"aai-docs": minor
---

Add an Evals page to the guide, after Testing.

The site taught `aai test` and stopped there, so the second command a scaffolded project ships — `aai eval`, and the whole published harness behind it — was documented only in the SDK reference and in template comments. A reader following the guide had no page telling them the difference between asserting what their code does and measuring what the agent did.

`/build/evals/` covers `describeEval`, what a turn hands back, the event readers on `@alexkroman1/aai-runtime/eval`, multi-turn cases with `sayAll`/`turnCalling`, and `describeWorkflowEval` — plus the three things a green run is easiest to misread over: which model a run got (live vs scripted, and the `live`/`scripted` markers that decide which cases are honest in which mode), that no eval sees anything below the audio boundary, and that one run of a probabilistic system is not a verdict.

Every fence compiles. The examples import `virtual:aai/agent` — declared by `scaffold/global.d.ts`, and the right import for an eval besides, since that is the agent with `tools/` discovered — so the page adds no `no-check` debt. Testing links to it in both directions.
