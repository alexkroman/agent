---
"@alexkroman1/aai-cli": patch
---

Derive the transcription template's segment concurrency from an audio-seconds budget, and raise it from 8 to 32. The sync endpoint's capacity tracks audio in flight rather than open requests: 320 concurrent 5-second clips (1,600 audio-seconds) drew zero 429s and zero 503s — it queues rather than rejecting — while 64 concurrent 92-second segments (5,888) drew 20 503s and 48 of them drew 0-4. So the declared quantity is the budget, and lowering SEGMENT_SECONDS can no longer triple the audio in flight silently. 32 is the measured knee for wall clock (27.5s against 43.3s at 8 over 1h37m of audio); 48 is within noise of it while paying retries and 64 is slower. Overshooting stays safe, since a 503 carries retry-after and toStepError honours it — but it is not free in latency, because mapInBatches is a barrier and one straggler stalls its whole batch.
