---
"@alexkroman1/aai-runtime": patch
---

Fix `GET /workflows/runs/:id/events` holding a silent stream for five minutes on an empty run id, and bound the stream's retry so a persistently failing read hands the client back to its poll instead of looking idle.
