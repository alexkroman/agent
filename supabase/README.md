# supabase/

The platform database: `config.toml` for the local stack, `migrations/` for the
schema every deployment runs against.

This file holds the DECISIONS about how the platform uses Supabase — the places
we knowingly diverge from their own recommendations, and the operational facts
the code depends on and cannot assert. It lives here rather than in
`packages/aai-server/CLAUDE.md` because its audience is whoever is editing this
directory, and because that guide is at its 120,000-char cap; the pointer there
names this file.

## Where we differ from Supabase's own recommendations

Audited 2026-08 against their docs, and most of the surface is exactly what they
recommend (session-mode connection, Vault's `create_secret`/`update_secret`,
private-bucket `download()` + `createSignedUrl`, a custom schema with explicit
grants). Three places differ, each a decision rather than an oversight:

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
  every settled edit hands walrus the WHOLE workspace document for a payload the
  handler discards. Narrowing the publication is the obvious fix and is a NO-OP:
  column lists are a `pgoutput` feature, and `realtime.list_changes` reads the
  publication for its TABLE list alone and decodes with **wal2json**, which has
  no notion of publications and emits every column regardless (measured on
  realtime v2.112.6 / PG 17.6). The lists were written, measured and reverted;
  `platform-schema.test.ts` guards AGAINST them, because the cost of the attempt
  is the comment explaining a mechanism that isn't there. Bringing the decode cost
  down takes a different mechanism — Broadcast from Database, or a skinny signal
  table that does not carry `doc`.
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

**The schema is DECLARED, in `supabase/migrations`** — not created lazily by
the store that reads it. Every `aai_platform` store used to call a memoized
`create schema/table if not exists` on first use (`pg-ensure.ts`), which is
why pg_cron sweep bodies were wrapped in `to_regclass` guards: on a fresh
database a job could fire before its table existed. Migrations delete both,
plus the boot-time publication/grant setup. The trade is deploy ORDERING —
`supabase db push` before the deploy — and a missed migration now fails
loudly with "relation does not exist" instead of being papered over by a lazy
create that runs on whichever connection first noticed.
`platform-schema.test.ts` guards two things statically: every
`aai_platform.<table>` the source queries must be declared in a migration, and
the store suites assert that no store issues DDL.

**`supabase db push` is MANUAL, and nothing tells you when you have forgotten
it.** No workflow runs it — `.github/workflows/deploy.yml` is checkout →
`modal deploy`, and there is no migration script in `package.json`. So "the
trade is deploy ORDERING" is a trade a human has to make on every release that
adds a migration, and the failure lands in production rather than in CI. It has
already happened once: `20260808120000_agents_config_default.sql` stopped
`agents.config` being written but was never pushed, so **every** `POST /deploy`
died on `null value in column "config" violates not-null constraint` — Publish
and auto-preview alike — while CI was green and the deploy reported success.
Push migrations before shipping a release that needs them:

```sh
supabase db push        # from the repo root, against the linked project
```

**Jsonb columns must be bound `::text::jsonb`, never a bare `::jsonb`.** The
stores bind documents as JSON text; with the parameter's type resolved from a
bare cast, postgres.js JSON-encodes the string we already encoded and the
column ends up holding a jsonb **string**. See the long note in
`workspace-store.ts` for the two failures that came out of it (every metadata
stamp raising `cannot delete from scalar`, and the orphan-preview sweep
deleting live previews because `doc->>'previewSlug'` reads NULL out of a
string), and `jsonb-encoding.scenario.test.ts` for the guard. The reason it
survived so long is worth keeping: **the in-memory stores cannot represent the
bug.** They hold JS objects, so the encoding has no analogue in them, and every
unit test passed against a shape production never had. Anything that reaches
into a jsonb column from inside Postgres — an arrow operator, `-`, `jsonb_set`,
a predicate in a pg_cron body — needs a test against a real database.

**Those are both the FORWARD direction, and the reverse one cost us three
tables.** A table queried nowhere *and* declared nowhere satisfies every check
above trivially, and production held exactly that: `sandbox_registry`,
`slug_epochs` and `slug_locks`, created at runtime by `pg-ensure.ts` before the
schema was declared, replaced by #950, and never dropped — because a declared
schema has no `drop` for a table it never declared. They were not inert: they
would have been the only tables in the schema without RLS, which nothing reports
(splinter's `rls_disabled_in_public` and the RLS-disabled alerts both key on
`public`). `20260807120000_drop_orphan_platform_tables.sql` drops them, and its
header carries the full account including the 21 stale `slug_epochs` counters.

**Drift detection cannot be static** — it is a fact about a database, not the
repo — so the guard is `schema-drift.scenario.test.ts`, gated on
`AAI_TEST_PG_URL` and read-only, asserting every table in `aai_platform` is
declared by a migration. Point it at whatever database you want the claim to
hold for; `supabase db diff --linked --schema aai_platform` is the ad-hoc
equivalent and also reports column-level drift.
