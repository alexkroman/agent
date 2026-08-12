---
"@alexkroman1/aai": patch
---

Fix the session store binding its snapshot as a jsonb string rather than an object. Bound to a bare `$n::jsonb`, postgres.js re-encoded the already-encoded JSON, so `load` read back a string and answered 'no snapshot' — durable resume restored nothing at all in production while every unit test stayed green. Verified against a real Postgres.
