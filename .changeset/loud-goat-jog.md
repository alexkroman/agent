---
"@alexkroman1/aai": minor
---

Split AssemblyAI endpointing into min/max_turn_silence and stop the dead-air cover firing on ordinary tool turns. min_turn_silence had been raised 1500 -> 2000 -> 3000 to stop utterances splitting, but max_turn_silence was never set and sat at the service default 1536 — so from 2000 on the minimum exceeded the maximum, the completeness check could never fire, and every turn ended on the content-blind acoustic force-end that splits utterances in the first place. Both halves are now always sent (1000 / 3500), assemblyAIStt takes maxTurnSilenceMs, and a test pins min < max. Separately, DEFAULT_DEAD_AIR_COVER_MS moves 2000 -> 5000 (it sat under the 6.24s mean tool turn and fired on 93% of them) and the cover phrases are reworded to be purely declarative, because 'Still working on that.' reads as a request for patience and callers answer it.
