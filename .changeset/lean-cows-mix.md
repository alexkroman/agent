---
"@alexkroman1/aai-runtime": patch
---

Answer 503 with a short `Retry-After` when a workflow request cannot get an app-database connection, instead of a generic 500 — a caller can back off on the first and not the second. A workflow app whose durable-run world cannot start now fails its boot rather than serving a guest that reports healthy and 500s forever; a voice agent keeps today's behaviour, since a broken world does not stop it answering the phone.
