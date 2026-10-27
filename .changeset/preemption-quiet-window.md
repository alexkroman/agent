---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`turnTaking.preemptiveGeneration` now starts its speculative reply once an
interim transcript's text has held still for `PREEMPTIVE_QUIET_MS` (300 ms). It
used to wait for an interim at 0.9 end-of-turn confidence, but the default
pipeline STT (`universal-3-5-pro`) reports 0 on every interim and 1 only on the
final. So the flag did nothing: 0 adoptions in 1370 LLM turns of a
Full-Duplex-Bench v1.5 run with it on. With the quiet window, adopted
speculations started 0.8-2.1s before the final. The window restarts only when
the normalized text changes. The adoption checks (exact final match, history,
system prompt, no tool call) are unchanged, and the flag stays off by default.
`PREEMPTIVE_CONFIDENCE_THRESHOLD` is removed from `host-internal`.
