---
"@alexkroman1/aai-runtime": minor
---

`SessionStateBackend.discard` now reclaims a session's EVENT LOG as well as its slots on every backend. `createPostgresStateBackend` dropped slots only and left the log to the retention sweep, so "discarded" meant two different things depending on whether a session ran self-hosted or on the platform; the append-only grant that justified the asymmetry no longer exists. One CTE, so the pair is atomic against a concurrent append, and the retention sweep stays as the backstop for a session whose guest died before it discarded.
