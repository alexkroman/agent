---
"@alexkroman1/aai-runtime": patch
---

A pipeline LLM response that goes silent is abandoned after 15 s (before its
first chunk, or between chunks) instead of hanging until undici's 300 s body
timeout, and one that stalled before the model said or did anything (and before
any error reached the client) is re-sent once, silently. The between-chunks
clock times the model's own stream only, so a tool that runs longer than 15 s is
never aborted by it. A stall after output is never re-sent (a completed step may
have run a write tool) and fails the turn with the recovery phrase. Measured on
tau2-bench retail: a gateway `200` with a stalled body held one call for 5 min
while the filler looped over ~20 unanswered caller turns; no healthy turn in two
114-task runs came within 12.3 s of the deadline.
