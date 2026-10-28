---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

The default AssemblyAI `min_turn_silence` (`DEFAULT_MIN_TURN_SILENCE_MS`,
`turnTaking.minSilenceMs`) is now 250 ms instead of 800. On `universal-3-5-pro`
it is the end-of-turn completeness CHECK, not a force-end, so it is the latency
floor on every finished utterance. An unfinished sentence still stays open until
`maxTurnSilenceMs` (3500, unchanged). On Full-Duplex-Bench v1.5 (498 scenarios),
the median wait from the caller's last word to the commit fell 1.52 → 0.94 s
(800 → 250), and interruption response latency 2.71 → 2.04 s, with no rise in
split turns. Not yet re-measured on tau2-bench, where spelled names and dictated
IDs are what the earlier, higher values protected; continuation re-joins such a
split once the caller resumes. An agent that dictates identifiers, or that turns
continuation off, should set its own value.
