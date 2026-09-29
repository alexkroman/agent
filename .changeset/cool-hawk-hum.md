---
"@alexkroman1/aai-runtime": minor
---

New `evalNetwork({ routes, passthrough, refuse })` on `@alexkroman1/aai-runtime/eval`: a fake network that fails closed. Routes (by host, `*.wildcard` or URL prefix) answer; anything else is refused and logged; `requests()`, `calls(host)`, `refused()`, `expectNoOutbound()` and `expectNothingRefused()` read the log. Pass it (or a factory) as `describeEval`'s `network` — per suite or per case — and it becomes the global `fetch`, the builtins' `fetch` and the step fetch, reset per case and per `AAI_EVAL_REPEAT` repeat, with the live model's own provider hosts passed through automatically. Cases read it as `ctx.network`.
