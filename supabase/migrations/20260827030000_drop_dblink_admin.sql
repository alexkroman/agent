-- Undo `20260817000000_dblink_admin.sql`. Its whole purpose is gone.
--
-- `dblink` was enabled for ONE statement: `DROP DATABASE`, which pg_cron cannot
-- run because it wraps every job body in a transaction (`25001`). dblink opened a
-- second connection so the drop landed outside the caller's transaction. That was
-- for reclaiming a per-app database, and there are no per-app databases now — the
-- platform provisions no database for a tenant at all, and an author who wants one
-- points a `DATABASE_URL` secret at their own provider.
--
-- ── WHY DROP IT RATHER THAN LEAVE IT ────────────────────────────────────────────
--
-- dblink can open a connection to ANY reachable Postgres as any role whose
-- credentials it is given, from inside a SQL statement. That is a legitimate tool
-- with a caller and a liability without one: it is the sharpest primitive on this
-- database, it defeats the "a pg_cron job can only touch this database" reasoning
-- several sweep docs lean on, and nothing in the tree calls it. An unused
-- capability is not neutral — it is a capability nobody is watching.
--
-- No sweep is affected. `aai-sweep-app-db-runaways` was the only job that used it
-- and it is no longer declared, so boot's diffing (`schedulePlatformSweeps`
-- unschedules every `aai-sweep-*` job `platformCronJobs()` does not declare) has
-- already removed it. The orphan-preview reap moved out of pg_cron entirely and
-- goes through the delete route — see `orphan-previews.ts`.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────
--
-- It does not touch the app DATABASES themselves, or the `app-db:<slug>` Vault
-- secrets that hold their only credentials. Both may still exist on a deployed
-- fleet, and dropping a tenant's data — or, worse, its credential while the data
-- survives — is an operator's decision with a backup behind it, not a migration's.
-- `bundle-store.ts` carries the same reasoning for why an agent delete no longer
-- sweeps that secret either.

drop extension if exists dblink;

-- The schema goes too, but only if dblink was the sole thing in it: `restrict` (the
-- default) refuses to drop a schema that still contains an object, which is exactly
-- the check wanted here. A future admin-only object placed in `aai_admin` should
-- keep the schema, and this statement will then fail loudly rather than take it.
drop schema if exists aai_admin restrict;
