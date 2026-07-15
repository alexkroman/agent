---
"@alexkroman1/aai": patch
---

Fix pipeline turns stalling ~10s ("TTS flush timeout") on turns that produce no speech. A tool-call-only turn sent no text to the TTS context, but the transport still called `flush()` and waited for a `done` event the provider never emits for an empty context — burning the full `PIPELINE_FLUSH_TIMEOUT_MS` every silent turn. The flush/await now runs only when the turn actually produced agent text.
