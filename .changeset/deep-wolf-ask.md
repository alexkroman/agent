---
"@alexkroman1/aai": patch
---

Trim the pipeline STT `max_turn_silence` default 3500 -> 3000 ms; `min_turn_silence` stays 1600 ms.

This branch briefly set the pair to 800 / 1600 and reverted it on measurement, so the net change against the last release is the ceiling alone. The reverted arm is recorded because it is the strongest evidence this pair has: on tau2-bench retail (same 25 tasks, same seed, differing only in these two values) 1600 / 3500 scored reward 0.68 and 800 / 1600 scored 0.12, with splits up ~30% per utterance, merges down ~37%, and the share of mis-hearings that corrupted a tool argument nearly doubled (5.1% -> 9.8% of utterances) — the agent authenticating against truncated spelled names, exactly the failure the recorded pause measurements predicted.

3000 keeps `max_turn_silence` below the speaking edge's idle deadline (`DEFAULT_SPEECH_IDLE_TIMEOUT_MS`, 3500) less final-emission latency, so an utterance force-ended by the ceiling still delivers its final before the edge goes idle — and the idle edge is what fires a false-interruption resume, so crossing that line lets the agent resume a reply the caller really did interrupt. It costs ~0.5s of pause tolerance for hesitant speech against 3500 and is the one value in the pair with no measurement of its own — if splits reappear on hesitant, non-spelling utterances while spelled identifiers stay intact, put it back to 3500 (and raise the idle deadline with it).
