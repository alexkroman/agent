---
"@alexkroman1/aai": patch
---

Cancel the readable `streamTail` builds to ask for a run's chunk index. `getReadable()` is not lazy — a background pump opens a world-local stream reader immediately — so every tail read leaked a `chunk:`/`close:` listener pair, once per `GET /workflows/runs/:id/stream` and once per progress tool call.
