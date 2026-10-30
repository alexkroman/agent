---
"@alexkroman1/aai-runtime": patch
---

A barge-in or a failed turn no longer erases a tool call that already ran. When
a turn ended after a tool had executed but before its LLM step finished, the
pipeline kept only COMPLETED steps, so the call and its result vanished from the
model's history and the next turn re-sent it — including writes, which then
failed because the first one had succeeded (tau2 retail: 22 aborted turns had
already run a write, and 3 re-sent it). The pipeline now records every call the
unfinished step ran and persists it as a well-formed call/result pair: a call
that finished keeps its real result, a call still running at the cut is recorded
as interrupted with an "outcome unknown, check before repeating" result, and a
call that never ran is not recorded. This covers a barge-in and a turn that
fails mid-step (a fatal sibling tool, a stream error, a stall). `ctx.messages`
now reads the same verdict, so a tool never sees a cancellation for a write that
may have happened, and a call cut mid-run is no longer remembered as a failed
call that refuses its own re-check.
