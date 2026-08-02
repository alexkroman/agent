---
"@alexkroman1/aai-ui": minor
"aai-server": minor
---

The API URL shown in the studio preview (and every default client) is now the
long-living platform endpoint (`wss://host/:slug/websocket`) instead of the
ephemeral sandbox tunnel URL, which dies on idle eviction or redeploy. The
platform endpoint upgrades callers to the sandbox API itself: a plain
WebSocket upgrade on `/:slug/websocket` resolves the agent's live sandbox
(booting it on demand, like the client-config broker) and answers a 302
redirect to the sandbox's current session URL, query preserved so
`?sessionId=` resumes survive the hop.
