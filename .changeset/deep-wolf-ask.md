---
"@alexkroman1/aai": patch
---

Trim the pipeline STT `max_turn_silence` default 3500 -> 2500 ms; `min_turn_silence` stays 1600 ms.

This branch briefly set the pair to 800 / 1600 and reverted it on measurement, so the net change against the last release is the ceiling alone. The reverted arm is recorded because it is the strongest evidence this pair has: on tau2-bench retail (same 25 tasks, same seed, differing only in these two values) 1600 / 3500 scored reward 0.68 and 800 / 1600 scored 0.12, with splits up ~30% per utterance, merges down ~37%, and the share of mis-hearings that corrupted a tool argument nearly doubled (5.1% -> 9.8% of utterances) — the agent authenticating against truncated spelled names, exactly the failure the recorded pause measurements predicted.

2500 keeps `max_turn_silence` above `DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS` (2000), so a barge-in on an utterance that never reads complete still finds it open and the false-interruption deferral is reached; at 1600 the force-end landed first and that path was unreachable. It costs ~1s of pause tolerance for hesitant speech against 3500 and is the one value in the pair with no measurement of its own — if splits reappear on hesitant, non-spelling utterances while spelled identifiers stay intact, put it back to 3500.
