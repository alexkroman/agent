---
"aai-server": major
"@alexkroman1/aai": major
"aai-templates": minor
---

Move the platform to Supabase and replace KV with an opt-in per-app database.

- **Blob storage**: agent bundles now live in Supabase Storage via its
  S3-compatible endpoint (`SUPABASE_S3_ENDPOINT` / `SUPABASE_S3_ACCESS_KEY_ID`
  / `SUPABASE_S3_SECRET_ACCESS_KEY` / `SUPABASE_STORAGE_BUCKET`), replacing
  Tigris.
- **Secrets**: agent env vars are stored in Supabase Vault over
  `SUPABASE_DB_URL` (service-role Postgres). The master-key envelope
  encryption and `KV_SCOPE_SECRET` are removed.
- **KV support is removed** — `ctx.kv`, the `@alexkroman1/aai/kv` providers
  (`memoryKv`, `fsKv`, `s3Kv`, `redisKv`), the `kv:` agent config field, the
  `/:slug/kv` HTTP API, and the guest `kv/*` RPC are all gone. The
  `remember`/`recall` builtins keep working, now backed by in-memory
  per-session notes.
- **New: opt-in app storage (`ctx.db`)** — enabling storage gives an app its
  own Postgres schema + role in the platform's Supabase database, exposed to
  tool code as `ctx.db.query(sql, params)` (proxied over the `db/query` guest
  RPC). Enable it with the new `aai storage enable|disable|status` CLI
  command or the studio's Storage toggle; under `aai dev`, set `DATABASE_URL`
  in the project `.env`. Templates needing persistence (solo-rpg saves,
  debrief-workflow records) now use `ctx.db`; session-scoped template state
  moved to `ctx.state`.
