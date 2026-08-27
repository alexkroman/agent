---
"@alexkroman1/aai": patch
---

Move the orphan-preview reap back into pg_cron and delete the connection-pressure sweep. With no per-app database to drop, a reap is a Vault row and an agents row — both plain SQL — so the two reasons it left pg_cron are gone. It takes the same advisory lock a deploy takes, verified against a real Postgres from a second connection, and a parity test fails if deleteAgent grows a step the SQL body lacks. platform-db-pressure.ts is deleted: its whole argument was the tenant-scaled budget term, which no longer exists.
