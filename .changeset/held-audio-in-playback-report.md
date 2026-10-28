---
"@alexkroman1/aai-runtime": patch
---

A client's `playback_progress` report now has the audio the session's pacer is
still holding added before it reaches the heard cursor. A client can only report
what it has received, so a client playing slower than real time left the held
audio uncounted — and a barge-in then discarded it unsent — putting the heard
cursor ahead of the caller's ear and making resumes skip words they never heard
("one thousand four hundred ninety-seven dollars" resumed as "four hundred
ninety-seven dollars"). Instrumented on tau2-bench retail, the cursor went from
a median 3 (max 11) words past the audio actually played to 0 (max 1).
