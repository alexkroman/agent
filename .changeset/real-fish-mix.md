---
"@alexkroman1/aai": patch
---

Reuse the shared errorMessage/toolError helpers across the session core,
server, ws-handler, S2S transport, and STT/TTS providers instead of
re-inlining error extraction, and simplify the vector query options build.
