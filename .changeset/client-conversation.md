---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

A client named with `?client=` has one conversation across its sessions.

- Every connect that names a client — fresh, `?resume=1` or `?sessionId=` — is seeded with that client's recent prior sessions, in the model's history and in the client's `history.restored`. Newest sessions first until a budget of about 8,000 tokens (chars/4) is spent, and the existing 200-message cap still applies. A resume of the same session never doubles its own turns.
- A session bound to a client keeps its EVENTS after it ends (its slots are still reclaimed). The binding is a new `aai_client_sessions` table, created at boot by `aai dev` / `aai start` with the other session-state tables. Self-hosted (`DATABASE_URL`) and memory backends only; a deployed agent on the platform backend keeps today's behaviour.
- `agent({ sessionContext })`: an async hook run once per connect, before the first model call, bounded at 1.5 s. Its `instructions` are appended to the system prompt for the whole session as one stable block; its `historySince` narrows what prior history is loaded verbatim. A throw or timeout is logged and the session starts without it.
- `agent({ onSessionEnd })`: called each time a session stops, after its events are written, with `workflows` to start a keyed run (`sessionId` + `lastEventIndex`).
- `stepClientTranscript(clientId, { since?, afterEventIndex? })` on `@alexkroman1/aai/step` reads a client's sessions back as messages and tool calls; `stubClientTranscript` on `/testing` answers it in a spec.
- A resumed or reloaded conversation no longer loses its tool calls from the model's view: each prior call is folded into the assistant side as a short `[tool name(args) → result]` digest.

The client id is not authenticated. On a server reachable from a network, knowing a client's id is enough to read its history.
