---
"@alexkroman1/aai-ui": minor
---

Add `session.end()`: hang up the call, clear the conversation, and return to the not-started state (`started` flips back to false). Unlike `reset()`, the next `start()` mints a brand-new session — new session id, fresh per-session tool state, greeting included. The retail template's End button now uses it, so clicking End properly toggles back to the Start screen (it previously only cleared the conversation while the call stayed live).
