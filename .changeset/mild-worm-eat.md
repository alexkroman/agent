---
"aai-server": minor
---

Per-app database create/drop now go through the Supabase Management API (supabase-management-js) instead of DDL on the platform admin connection. There is no SQL fallback: SUPABASE_ACCESS_TOKEN (plus a project ref, derived from SUPABASE_DB_URL or set via SUPABASE_PROJECT_REF) is required alongside SUPABASE_DB_URL outside local dev, and a local run without it has no per-app databases at all.
