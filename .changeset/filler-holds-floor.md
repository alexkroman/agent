---
"@alexkroman1/aai-runtime": patch
---

Pipeline mode: fix two barge-in edges that discarded agent audio. Dead-air filler now holds the `speech_started` edge like any other agent audio, so a caller talking over a holding phrase no longer makes clients flush it with no `cancelled` behind (the filler still never counts as a barge-in against the reply). And an utterance the caller began into silence no longer barges in on a reply that started speaking after it — a "hello, are you still there?" spoken during a tool chain now chains behind the answer instead of replacing it.
