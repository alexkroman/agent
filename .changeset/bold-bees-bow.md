---
"@alexkroman1/aai": major
---

Key durable waits by NAME rather than by position. `ctx.sleep` now takes a label as its first argument — `ctx.sleep("review-window", 6 * 60 * 60 * 1000)` — and a wait is journaled as `sleep!<label>#<occurrence>` / `hook!<token>#<occurrence>`, exactly as a step is keyed `name#occurrence`.

Waits were keyed positionally off a counter that advances only when a wait is reached, so a body reaching a different NUMBER of waits read its predecessor's record. Measured: a week-long `ctx.sleep` behind an `if` was skipped in full with the clock unmoved and the run reported `completed`; the `ctx.waitFor` version hands the body another wait's payload. Both are unrepresentable now.

BREAKING: every `ctx.sleep(until)` call needs a label. `RecordedSleep` (`@alexkroman1/aai/testing`) and `EvalSleep` (`@alexkroman1/aai-runtime/eval`) each carry the label too, so a case can assert WHICH wait a body reached. Runs suspended when this ships resume against the new key space and fail with the replay engine's divergence message rather than silently reading the wrong record — drain in-flight runs before deploying.
