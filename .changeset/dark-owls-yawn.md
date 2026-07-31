---
"aai-server": minor
---

Cross-replica session resume: a session's resumable state (guest ctx.state via the new session/export RPC, remember notes) is persisted to aai_platform.session_state on disconnect and hydrated on a ?sessionId resume, so a reconnect landing on a different replica keeps the agent's working memory. Restore is set-if-absent on both sides so same-replica resume state always wins.
