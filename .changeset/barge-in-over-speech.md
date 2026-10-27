---
"@alexkroman1/aai-runtime": minor
---

Speech that begins while the agent is speaking now goes through the barge-in
rules even when it falls inside the continuation window. Continuation is for the
rest of a sentence the caller started before the reply was audible. It used to
also take speech that began over the reply, and that path skipped every barge-in
safeguard: one interim word cut the reply at once. On Full-Duplex-Bench v1.5 it
decided 350 of 352 such overlaps. A backchannel cut the answer ~0.3s in, was
committed onto the question, and the answer restarted from the top.

The barge-in sustained-speech gate (`interruptionMinDurationMs`) now also
accepts the interim's own word span (`SttTurnMeta.spokenMs`). Before, it timed
only from the first interim's arrival. AssemblyAI's first interim can come ~1.3s
into an interruption already five words long, so the cut waited for a second
interim, ~1.8s after the caller started. It now lands ~0.4-0.6s in. A provider
without word timings keeps the old clock.
