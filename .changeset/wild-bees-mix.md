---
"@alexkroman1/aai-runtime": patch
---

Pipeline: bound a stalled or rate-limited LLM. Retries of a failed call now wait
at most 4 s in total (a 429 asking for 60 s fails the turn at once instead of
waiting it out, and a fallback primary still moves on immediately); the stall
clock also covers opening the request; the dead-air cover gives up after four
unanswered fillers and the turn speaks errorPhrase instead of looping; and
caller turns queued behind a turn that has not started are answered once, as one
message.
