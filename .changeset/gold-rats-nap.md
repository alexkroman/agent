---
"@alexkroman1/aai-runtime": patch
---

AssemblyAI TTS: keep Flush/Cancel/KeepAlive frames under the service's
control-frame rate limit by merging sentence segments when a fast LLM bursts
them, and recover from a 3010 pacing close by reconnecting instead of ending the
session.
