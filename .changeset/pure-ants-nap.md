---
"@alexkroman1/aai": minor
---

Classify manifest mode (s2s | pipeline) at parse time. Adds optional stt/llm/tts fields with all-or-nothing validation; parseManifest now returns mode so downstream routers can dispatch session implementations.
