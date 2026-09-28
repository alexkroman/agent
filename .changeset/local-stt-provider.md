---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Experimental `localStt()` on `@alexkroman1/aai/experimental`: point a pipeline agent's STT stage at a speech model served on your own machine over a small WebSocket protocol (config frame, PCM16 audio, `partial`/`final` back). The server owns endpointing, so end-of-turn-token ASR models decide when the turn is over; `updateEndpointing` and `forceEndOfTurn` are forwarded. No credential is required.
