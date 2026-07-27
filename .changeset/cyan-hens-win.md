---
"@alexkroman1/aai": patch
---

Load STT/TTS vendor SDKs lazily (cuts runtime import from 1266ms/137MB to 335ms/61MB), fix the OpenAI Realtime transport hanging when a socket closes before opening, and share the restartable-timer and registry-lookup helpers.
