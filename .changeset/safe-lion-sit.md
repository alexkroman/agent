---
"@alexkroman1/aai-runtime": minor
---

Add the eval harness: `@alexkroman1/aai-runtime/eval` and `/eval/vitest`.

`openEvalSession` drives a real session from TEXT — this runtime, the pipeline
transport, the tool executor, `ctx` and the session event stream, with only the
two speech stages faked — and `say()` returns the turn it provoked.
`describeEval` gates a suite on a credential and, without one, runs it against a
SCRIPTED model rather than skipping: the same code below the model, so a keyless
run checks the wiring for free. `describeWorkflowEval` / `openEvalWorkflows` do
the same for a workflow app, over the real workflow client and key store (no
durability — the engine's doc says so at the seam). `run_code`, `fetch`,
`toolTimeoutMs` and `workflows` are all suppliable per case, and `saidIn` /
`toolCallsIn` / `toolResultIn` / `lastStateIn` / `customEventsIn` read the
answers out of the event stream.

`RuntimeOptions.toolTimeoutMs` is new and applies beyond evals: the tool
executor always accepted a per-call deadline and the session path passed none,
so a session's 30s voice-turn budget was unreachable from any caller.

New `aai eval` command runs a project's `agent.eval.test.ts`, and every shipped
template now has one.
