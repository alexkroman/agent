---
"@alexkroman1/aai": minor
---

A page reload now resumes its voice session: the default client remembers the session id per tab, so the server's syncState push reconstitutes the UI instead of coming back empty. A resume that recovers no history and no slot state is treated as a new session and greets, rather than connecting silently — PipelineTransportOptions.skipGreeting accepts a thunk for that late decision.
