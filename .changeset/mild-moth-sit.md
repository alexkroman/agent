---
"@alexkroman1/aai": patch
---

Fix the user-facing copy that still told people to run 'aai storage enable' or click Settings → Database. Neither exists: the platform provisions no tenant database, so ctx.db is a DATABASE_URL an author points at their own Postgres. Two messages were wrong about more than the command — the workflows-unavailable error blamed missing storage when the only cause is an app declaring no workflows, and the local-uploads notice claimed runs were ephemeral without a database when a deployed app's runs are the platform's.
