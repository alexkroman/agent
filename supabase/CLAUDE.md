# supabase/ — database guide

The platform's Supabase project: migrations, and the settings the code depends on
but cannot assert. The services that read this database are documented in
`packages/aai-server/CLAUDE.md` (platform core) and
`packages/aai-studio-server/CLAUDE.md`.

Migrations in `supabase/migrations` are applied with `supabase db push`, MANUALLY,
before the deploy that needs them — see "The schema is DECLARED" in the
aai-server guide for what that ordering costs when it is forgotten.

## Where we differ from Supabase's own recommendations

Audited 2026-08 against their docs. Most of the surface is exactly what they
recommend — direct session-mode connection, Vault's `create_secret` /
`update_secret`, private-bucket `download()` + `createSignedUrl`, a custom
schema with explicit grants, migrations applied ahead of deploy. Three places
differ, and each is a decision rather than an oversight:

- **`postgres_changes` instead of Broadcast.** Supabase now steers to
  `realtime.broadcast_changes` triggers, because `postgres_changes`
  authorizes every event against every subscriber (100 subscribers = 100
  authorization checks per change) on a single ordering thread. Their stated
  threshold is ~3,000 concurrent subscribers on the same changes; ours are
  REPLICAS, not users, so we are orders of magnitude below it. The documented
  direction if this ever moves, and worth knowing before adding a fourth
  watched table.

  **Staying on `postgres_changes` is not cheap, and a publication COLUMN LIST
  cannot make it cheaper.** These are signal streams — handlers re-read — so
  every settled edit hands walrus the WHOLE workspace document, detoasted and
  serialized, for a payload the handler discards. Narrowing the publication to
  the identity columns is the obvious fix and it is a NO-OP: column lists are a
  `pgoutput` feature, and Supabase Realtime does not decode with pgoutput.
  `realtime.list_changes` reads the publication for its TABLE list alone and
  decodes with **wal2json** (`pg_logical_slot_get_changes(…, 'add-tables', …)`),
  which has no notion of publications and emits every column regardless —
  measured on realtime v2.112.6 / PG 17.6, where a publication with
  `attnames = {id,small}` still emitted the excluded column in full. The lists
  were written, measured, and reverted; `platform-schema.test.ts` now guards
  AGAINST them, because the cost of the attempt is not the migration, it is the
  comment explaining a mechanism that isn't there.

  If the decode cost ever has to come down, it takes a different mechanism, not
  a narrower publication: Broadcast from Database (a trigger calling
  `realtime.broadcast_changes` with a payload you choose), or moving the signal
  onto a skinny table that does not carry `doc`.
- **RLS is enabled and DENY-ALL, which is not what RLS is usually for.**
  Access is really controlled by the grant: `anon`/`authenticated` hold no
  privilege on `aai_platform`, and it is not a PostgREST-exposed schema.
  Policies would add nothing on top — the platform connects as the tables'
  OWNER (owners bypass RLS) and Realtime subscribes as `service_role`
  (BYPASSRLS), so every real reader is exempt anyway. What
  `20260807000000_platform_rls.sql` buys is the failure mode of a mistake:
  add a grant to `authenticated`, or expose the schema, and the result is zero
  rows rather than every tenant's workspace. **ENABLE, never FORCE** — forcing
  applies policies to the owner too, i.e. to every query the platform makes.
  Three guards in `platform-schema.test.ts` hold all of this, and they exist
  because NOTHING EXTERNAL WILL: splinter's `rls_disabled_in_public` (0013)
  and the RLS-disabled email alerts both key on `public`, so a table added
  here without RLS is invisible to every check Supabase runs on the project.
- **Per-app Postgres roles instead of RLS.** "Generally you wouldn't use
  these roles for your own application… use Row Level Security" does not
  apply: RLS presumes a trusted client presenting a user JWT, and ours is
  untrusted tenant code holding the credential itself in a sandbox. Their
  other rule — "create a new user for every service you want to give access
  to" — is the one that fits, and `APP_DB_CONNECTION_LIMIT` answers the
  connection-cost objection they raise against many roles.

Two operational facts the code depends on and cannot assert:

- **A direct connection is IPv6-only without the IPv4 add-on**, so production
  depends on one of the two. The shape is right on the merits ("direct
  connections remain the best choice for long-lived sessions"), and if IPv4
  ever becomes necessary the sanctioned fallback is **Supavisor SESSION mode
  on port 5432**, which still holds advisory locks — `assertSessionModeUrl`
  already permits it, since it refuses only port 6543 and `pgbouncer=true`.
- **Legacy `anon`/`service_role` keys are deprecated (end of 2026) and can no
  longer be rotated.** Boot already requires the new secret form, so we are
  ahead — but `SUPABASE_SERVICE_ROLE_KEY` now holds an `sb_secret_…` key,
  which is a naming wart, and the sanctioned placement for a non-JWT secret
  key is the `apikey` header (the Realtime client does this; the Storage
  client sends both `apikey` and `Authorization`).
