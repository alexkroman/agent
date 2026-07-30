---
"@alexkroman1/aai": patch
"aai-server": patch
---

Fix session resume losing the agent's context (ctx.state): the browser client now reconnects with the server-issued sessionId instead of a bare resume=1 (so the server resumes the same session rather than minting a new id), and per-session tool state survives a disconnect for a resume grace window (SESSION_RESUME_GRACE_MS) on both the self-hosted runtime and the platform sandbox (deferred guest session/end) instead of being wiped the moment the old session stopped.
