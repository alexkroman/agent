---
"@alexkroman1/aai": minor
---

Concurrency hardening in the agentic loop: tool calls now receive a history snapshot and a turn-scoped AbortSignal (exposed as ctx.signal) that cancels on barge-in, reset, or session stop; duplicate reply.done frames mid multi-hop turn no longer end the reply early; a failed S2S resume emits a single connection error and cannot loop into repeated resume attempts; host-mode relay refuses duplicate in-flight toolCallIds and honors turn aborts; ws-handler no longer marks a session ready (or drains buffered frames) after the socket closed mid-start.
