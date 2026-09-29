---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`sessionContext` may answer `greeting`: the opening line for that one session, spoken instead of `agent({ greeting })` — for an outbound call that names who it is calling for ("Hi, this is an AI assistant calling on behalf of Sam. Do you have a moment?"), known only per call.

- It replaces the text, never the decision: a resume (`?sessionId=` that restored a conversation, `?resume=1`) still does not greet. Otherwise it is spoken exactly as the agent's greeting is — synthesized as written with no model call, recorded as the agent's opening line, and spoken again after a client `reset`.
- An empty string means no greeting this session. Control characters become spaces, and the text is trimmed and cut at `MAX_SESSION_GREETING_CHARS` (500). No field, a non-string, a throw, or an answer past `SESSION_CONTEXT_TIMEOUT_MS` keeps the agent's greeting.
- No extra wait: the hook is already answered inside `session.start()`, before any transport speaks or sends its greeting, so a session whose `sessionContext` gives no greeting starts exactly as before. Phone sessions included.
- All three transports: the pipeline and OpenAI Realtime read it when the greeting fires, AssemblyAI S2S when it sends `session.update`.
