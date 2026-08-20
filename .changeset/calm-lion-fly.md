---
"@alexkroman1/aai": minor
---

Workflow uploads no longer need a database: with no `DATABASE_URL` the store now follows the local workflow world into its own data directory, so a databaseless agent's uploads are exactly as durable as the runs that read them. A database with no bucket is the one configuration that still refuses.
