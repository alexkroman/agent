---
"@alexkroman1/aai": patch
---

Fix pipeline mode: play greeting, emit a single agent_transcript per turn, open TTS at the client's playback sample rate, and stop the Cartesia adapter from eagerly rotating its context (which was silently dropping in-flight audio chunks).
