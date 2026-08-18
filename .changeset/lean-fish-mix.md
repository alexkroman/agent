---
"@alexkroman1/aai": minor
---

Give every app its own Postgres database instead of a schema, so durable workflows work at all: the Workflow DevKit's `workflow` and `graphile_worker` are database-level schema names it cannot create inside a shared database, and its migration was failing with a permission error. Session state and the wake hint move to the app's own `public`; per-app maintenance runs as a cron job inside that database.
