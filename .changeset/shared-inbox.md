---
"@alexkroman1/aai-runtime": minor
---

`WS /inbox` takes an optional `?holder=<id>`, so a speaker and a browser can both hold one client id. The same (client, holder) still replaces on reconnect, different holders coexist, and no `?holder=` is the default holder, so existing devices behave as before. A notice goes to every open holder: `stepNotifyClient` resolves when any holder acks, sees "busy" only when every holder answered busy, and keeps one notice in flight per client.

A holder that opens with `?events=1` is also sent the live conversation of every session bound to its client, as `{ "type": "session_event", "sessionId", "event" }` text frames — `session.configured`, `userTranscript.committed`, `agentTranscript.committed`, `tool.called` (name and args), `reply.completed`, `reply.cancelled`, `session.reset` — and `{ "type": "session_ended", "sessionId" }`. Never tool results or audio. The frames are fire-and-forget and dropped for a holder whose socket has more than 64 KiB unsent; holders without the flag receive nothing new.
