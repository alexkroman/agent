---
"@alexkroman1/aai-runtime": minor
---

`describeEval`'s `workflows` option accepts a factory, `() => client`, called afresh for every case and every `AAI_EVAL_REPEAT` repeat as `network`'s is, and every case context carries the live client as `ctx.workflowClient` — the suite's own, or the eval engine's — typed by what the suite passed, so a recording client's log needs no manual reset.
