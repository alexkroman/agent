---
"@alexkroman1/aai-runtime": patch
---

The pipeline's write confirmation gate now refuses a declared write only when
the caller turn behind it was a backchannel: begun over agent audio AND shorter
than `interruptionMinDurationMs` of speech. Overlap alone refused real answers:
on tau2 retail a caller twice began "Yeah, cancel that charger order" over the
last ~1.4 s of the question and the task failed. The refusal now tells the model
to ask once more and wait, rather than reading as a failed action. Without word
timings, overlap still refuses.
