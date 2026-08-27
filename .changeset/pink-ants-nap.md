---
"@alexkroman1/aai-runtime": minor
---

Compose the platform-owned queue into the DevKit's Postgres world: a deployed guest now enqueues through the platform and never subscribes graphile-worker. Storage and the streamer stay in the tenant's own database, so this gives back graphile's held LISTEN connection and its worker concurrency rather than the whole workflow surcharge.
