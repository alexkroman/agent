---
"@alexkroman1/aai-runtime": patch
---

Drop stale provider frames found by new concurrency property tests. OpenAI
Realtime no longer delivers a cancelled or barged-in reply's trailing audio,
transcript or tool call, no longer commits a transcript fragment to history
after a barge-in, and reports nothing after `stop()`. Cartesia TTS no longer
emits `done` or sends a wire cancel when barge-in fires before any text.
