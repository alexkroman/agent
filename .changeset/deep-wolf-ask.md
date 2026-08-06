---
"@alexkroman1/aai": patch
---

Set the pipeline STT defaults to min_turn_silence 800 ms and max_turn_silence 1600 ms (were 1600 / 3500). Both are UNVERIFIED and were set against the recorded measurements, which argue for 1600 min: intra-utterance pauses inside failing utterances measured 856-1455 ms, so 800 is expected to end turns mid-spelled-identifier and truncate authentication arguments. max 1600 also falls below DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS (2000), inverting the recovery-window coupling. Validate on tau2 reward or tool-argument accuracy; revert to 1600 / 3500 if it does not hold.
