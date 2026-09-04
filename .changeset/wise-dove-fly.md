---
"aai-server": minor
"@alexkroman1/aai-runtime": minor
---

Carry every guest→platform call down one multiplexed WebSocket, with the five HTTP routes kept as the fallback. A deployed guest opens `WS /:slug/platform-socket` once per process and frames session state, upload records, the workflow journal, its key index and enqueues onto it; the platform turns each frame back into a real request through the same Hono app, so every route's status, body cap and bearer check are unchanged. A call the socket refuses before writing falls back to HTTP; one already written does not, so nothing is applied twice.
