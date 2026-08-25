---
"@alexkroman1/aai": minor
---

Validate a dialog's graph at declaration — a state nothing can reach, or a non-final leaf nothing can leave, is now refused rather than silently accepted. Model the OpenAI Realtime connection and one client socket's session lifecycle as XState statecharts, and refuse a dev-server adopt after teardown instead of orphaning the built server.
