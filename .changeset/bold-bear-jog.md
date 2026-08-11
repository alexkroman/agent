---
"@alexkroman1/aai": minor
---

Add an optional session store so a resume can survive the process, not just the socket. A runtime given `sessionStore` mirrors each session's `ctx.state` and its S2S provider session id to durable storage, and a `?sessionId=` reconnect served by a different process restores both — a restarted sandbox rejoins the conversation instead of answering with an amnesiac session. Ships `createDbSessionStore` (Postgres, over the same handle as `ctx.db`) and `createMemorySessionStore`. Omitted, the runtime behaves exactly as before.
