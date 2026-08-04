---
"aai-server": patch
---

Fix two Supabase-era gaps: the agents change-event handler no longer drops invalidations that land mid-rebuild (the pre-filter now checks slot existence and rebuilds claim the slot before a fresh record read), and the pg_cron orphan-preview sweep deprovisions the app database schema/role before deleting its Vault credentials.
