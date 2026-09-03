---
"@alexkroman1/aai-runtime": minor
---

eval: publish the four affordances every template eval was hand-rolling — `toolNames`/`describeToolCalls` and `describeTurn` (the turn diagnostic behind ten `expect(value, message)` sites across five templates), `EvalSession.sayAll` with `callsIn`/`turnCalling` (so a case asserts about the turn a mechanism fired in rather than pinning a turn index, which is a flake with a misleading name), and `EvalWorkflows.settleAll` — plus `close()` now warning about a run it abandons instead of letting a mid-flight body call out on the next case's fakes or a real key.
