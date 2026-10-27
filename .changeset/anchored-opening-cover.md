---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": minor
---

The pipeline's opening dead-air filler is now timed from the caller's last word
instead of from the commit. AssemblyAI STT reports how long ago the last word
ended (`SttTurnMeta.trailingSilenceMs`), and the turn's first filler window is
`DEAD_AIR_OPENING_TARGET_MS` (4.6 s) minus that wait, floored at 0. The target
is derived: it is the latest point a filler is still heard before tau2's
simulated caller re-prompts at 5.0 s, given the measured playout latency. On 62
tau2 retail turns, replaying the fixed 2.4 s window against the anchored one
gave fillers fired 25 → 22, fillers made redundant by the answer 11 → 9, and
caller re-prompts first 7 → 3. Without word timings, or on a typed or chained
turn, the fixed window applies as before.
