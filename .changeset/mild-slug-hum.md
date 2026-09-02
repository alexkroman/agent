---
"@alexkroman1/aai-runtime": minor
---

Persist durable workflow runs to Postgres when a `DATABASE_URL` is configured, so a run survives a restart instead of living in the process that started it.
