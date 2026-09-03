---
"aai-server": patch
---

Re-date the two workflow-journal migrations that merged behind an already-applied one, so `supabase db push` accepts them: #1360's `20260902000000_workflow_step_started_at.sql` and `20260902010000_workflow_run_code_version.sql` sorted BEFORE #1358's `20260902120000_workflow_run_abandonment.sql`, which production had already applied, and the push refuses a pending file older than the last remote row. Renamed to `20260902130000`/`20260902140000` rather than passing --include-all, which would leave the applied schema a function of merge order instead of filename order. Both are `add column if not exists` and independent of the migration they now follow, so the resulting schema is unchanged. The bump is what arms the deploy: the path diff arms `migrate` on its own, but the columns' READERS shipped in #1360 and have been sitting behind a blocked release.
