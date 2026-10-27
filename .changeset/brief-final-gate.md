---
"@alexkroman1/aai-runtime": patch
---

A committed transcript that began over agent speech and whose words span less
than `interruptionMinDurationMs` is now an acknowledgement: it no longer cuts
the reply, and it is not committed as a turn. Finals used to skip that gate, so
with `minBargeInWords` at 1 every one-beat "uh-huh" cut the agent off (334 of
367 on six tau2 retail runs). The model then read it as the caller's answer:
"Shall I request the return?" / "Uh-huh." ran a write tool 11 times with no
consent given. AssemblyAI STT now reports the words' span as
`SttTurnMeta.spokenMs`. A provider without word timings keeps the old behaviour.
