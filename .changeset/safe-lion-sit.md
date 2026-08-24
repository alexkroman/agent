---
"@alexkroman1/aai-runtime": minor
---

Add `@alexkroman1/aai-runtime/eval` — the text-driven eval harness (`openEvalSession`, the event readers, the fake speech stages) plus `describeEval` on `/eval/vitest`, which gates a suite on a credential and falls back to a scripted model. New `aai eval` CLI command runs a project's `agent.eval.test.ts`, and the simple template ships one.
