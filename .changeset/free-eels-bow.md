---
"aai-server": minor
---

The orphan-preview reap moves out of pg_cron into the server: a leader-elected in-process pass that reaps through deleteAgentResources, the same delete path DELETE /:slug uses. Deleting its SQL body removes the last second implementation of deprovisioning, along with dblink's whole support cast (platformDbDsn, PLATFORM_DB_DSN_SECRET, AAI_DBLINK_HOST) — and fixes the reap on sharded fleets, where the SQL version silently reclaimed nothing.
