---
"aai-server": patch
"aai-studio-server": patch
---

Supabase audit fixes: deprovision an app database on the cluster its stored locator names (a change to APP_DB_URLS otherwise dropped on the wrong one and stranded tenant data); publish only row-identity columns to Realtime so a workspace document no longer crosses the WAL for a signal nobody reads; cascade chat and session rows from their workspace; make the Vault put idempotent under a lost create race; cap the token verify cache at the token exp; report a never-joining Realtime channel; refuse boot on a missing or public Storage bucket; and add sweeps for unreferenced blobs, runaway tenant queries and pg_cron run history.
