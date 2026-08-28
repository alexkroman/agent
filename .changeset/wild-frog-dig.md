---
"@alexkroman1/aai-runtime": minor
---

Publish ensureSessionStateSchema and call it from the scaffold's server.mjs, so a self-hosted agent with a DATABASE_URL creates its own session-state tables instead of failing every session at start.
