---
"@alexkroman1/aai-runtime": patch
---

A barge-in no longer erases a tool call that already ran. When the caller
interrupted after a tool had executed but before its LLM step finished, the
pipeline kept only COMPLETED steps, so the call and its result vanished from the
model's history and the next turn re-sent it — including writes, which then
failed because the first one had succeeded (tau2 retail: 22 aborted turns had
already run a write, and 3 re-sent it). The pipeline now records every call the
interrupted step ran and persists it as a well-formed call/result pair, after
the heard text: a call that finished keeps its real result, a call still running
at the cut is recorded as interrupted with an "outcome unknown, check before
repeating" result, and a call that never ran is not recorded.
