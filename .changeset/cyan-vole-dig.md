---
"@alexkroman1/aai": patch
---

Fix barge-in not stopping TTS playback after synthesis completes: pipeline mode now tracks estimated client-side playback and emits cancelled (flushing the client audio buffer) when the user speaks while buffered audio is still playing, even after the server-side turn has finished.
