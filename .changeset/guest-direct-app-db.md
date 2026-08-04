---
"@alexkroman1/aai": patch
---

ctx.db on the platform now connects directly from the guest sandbox: the
app's own scoped Postgres credentials (role with pinned search_path,
statement_timeout, and connection limit) are delivered as `DATABASE_URL` in
the bundle/load env, and the bundle's runtime opens its own connection —
exactly as `aai dev` does with a project `.env`. The host-proxied `db/query`
RPC is removed, taking the last bundle-facing RPC out of the versioned
harness↔bundle contract.
