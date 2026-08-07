---
"@alexkroman1/aai": minor
---

Collapse false-interruption recovery onto the utterance-idle signal: `falseInterruptionTimeoutMs` (a number that never governed the wait) becomes `resumeFalseInterruption` (boolean, default true), and the resume fires when the transcript stream goes quiet with no committed final.
