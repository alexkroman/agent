---
"@alexkroman1/aai": minor
---

Simplify the client audio path: the push-to-talk recorder now uses the same capture worklet as the WebSocket mic (start/stop gating, stop-flush-ack instead of a fixed sleep, sample-rate assertion, dead-mic probe), PCM16 conversion and mic-open failure cleanup are shared helpers, the playback worklet's concealment ring uses bulk copies, and all client-audio timing constants (playback done wait, capture stop ack, playback buffer seconds) live in the shared constants module.
