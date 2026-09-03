# supabase/

The platform database: `config.toml` for the local stack, `migrations/` for the
schema every deployment runs against.

This file holds the DECISIONS about how the platform uses Supabase — the places
we knowingly diverge from their own recommendations, and the operational facts
the code depends on and cannot assert. It lives here rather than in
`packages/aai-server/CLAUDE.md` because its audience is whoever is editing this
directory, and because that guide is at its 120,000-char cap; the pointer there
names this file.

## Running a local dev server against this stack

`pnpm dev:aai-server` resolves the whole stack itself
(`scripts/dev-server.mjs`) — nothing needs exporting. What it supplies, and the
one thing it cannot:

```sh
supabase start          # once; keeps its data across supabase stop/start
pnpm dev:aai-server     # resolves DB_URL/API_URL/keys + AAI_LOCAL_DEV=1
```

**`SUPABASE_DB_URL` decides the tier, and there are exactly two.** With it,
every platform store is Supabase's — the agents table, deploy blobs, Vault
secrets, studio workspaces, per-app databases, Realtime. Without it, all of them
are in this process's heap and **a restart erases every deployed agent**, so a
published URL 404s and a browser session cannot resume onto it. The boot log says
which tier it is; there is no third state.

**A repo-root `.env` is read by BOTH**, which is the property that makes the
setup below one file: Node's `process.loadEnvFile` for the dev server, and the
Supabase CLI's own `env()` interpolation for `config.toml`. A variable exported
in the shell beats the file in both. It is gitignored.

### Browser sign-in needs a GitHub OAuth app

The studio signs in with GitHub and nothing else (`aai-studio-client/auth.tsx`),
and a platform database **refuses** the no-auth dev tokens
(`createStudioAuthFromEnv`) — if state is in Supabase, identity is too. So the
local stack needs the provider really enabled, or GoTrue answers:

```json
{ "code": 400, "error_code": "validation_failed",
  "msg": "Unsupported provider: provider is not enabled" }
```

That message means the RUNNING stack has no GitHub provider, which is two
separate causes and usually both:

1. **Create the OAuth app** — <https://github.com/settings/developers> → *New
   OAuth App*:
   - Homepage URL: `http://localhost:8080`
   - Authorization callback URL: `http://127.0.0.1:54321/auth/v1/callback`

   The callback is **GoTrue's, not the studio's**. GitHub redirects to Supabase,
   which then redirects to `redirect_to`; pointing it at `:8080` fails on
   GitHub's own opaque error page.
2. **Put the pair in `.env`** and **restart the stack**, because `config.toml` is
   applied at `supabase start` and interpolated from the environment as it starts
   — editing either one changes nothing about a stack already running:

   ```sh
   cat >> .env <<'EOF'
   AAI_LOCAL_GITHUB_CLIENT_ID=Ov23li…
   AAI_LOCAL_GITHUB_SECRET=…
   EOF
   supabase stop && supabase start     # data volumes survive; --no-backup deletes them
   ```

   `supabase status` WARNS by name (`environment variable is unset:
   AAI_LOCAL_GITHUB_CLIENT_ID`) when the pair is missing, which is the cheapest
   way to tell "I forgot the file" from "I forgot the restart".

`site_url` / `additional_redirect_urls` in `config.toml` are the allow-list
GoTrue validates `redirect_to` against, and `signInWithOAuth` sends
`window.location.href` — so a studio served on a port other than 8080 needs its
origin added there, or the round trip comes back rejected with nothing on the
page saying why.

### The `blobs` bucket is applied at stack INIT

`[storage.buckets.blobs]` is created by `supabase start` on a stack that has
never had it, so a stack first started before that stanza landed has no bucket
and boot is fatal (`assertBucketPrivate`: `bucket "blobs" does not exist`).
Either restart the stack or create it once:

```sh
set -a; eval "$(supabase status -o env)"; set +a
curl -X POST "$API_URL/storage/v1/bucket" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"blobs","name":"blobs","public":false}'
```

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

- **Migrations are hand-written, NOT generated from a declarative schema.**
  `supabase/schemas/*.sql` with migrations produced by `supabase db diff` (and
  now a `--use-pg-delta` export path) is Supabase's newer recommended
  *authoring* model, so it deserves a stated answer rather than silence. The
  answer is no, for this tree: it carries data migrations
  (`20260809120000_normalize_double_encoded_jsonb.sql`), pg_cron job bodies,
  extension installs, explicit per-role grants, deny-all RLS, and six
  deliberate destructive steps — the categories a schema differ handles worst,
  and the ones where a wrong generated diff is a production incident rather than
  a compile error. The hand-written files also carry the incident histories that
  make them reviewable, which a generated file cannot. Note this is orthogonal
  to how migrations are APPLIED: `db push` from CI is what Supabase recommends
  either way, and that is what `ship.yml` does.

- **There is no staging project, and no Supabase branch.** Every migration
  meets production first, which is a real divergence from the "deploy to
  staging, then production" shape their environments guide recommends.
  Deliberately deferred, not overlooked: it is the only item on this list whose
  cost is a second paid project plus the machinery to keep it seeded, and the
  two gates named below buy most of what it would catch at push time instead.
  Revisit it when a migration needs to be rehearsed against real data rather
  than merely ordered correctly — the FK-validating case below is the shape
  that will force it.

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
it.** This is no longer true: `.github/workflows/ship.yml` has a `migrate` job
that runs `supabase db push --db-url` ahead of the deploy, **on a RELEASE** —
i.e. a commit that moved a workspace `package.json` version line — and on a
`workflow_dispatch` that arms the deploy. It used to also arm off a
`HEAD^..HEAD` diff over `supabase/migrations/**`, and that arm was REMOVED
because at a release commit it finds nothing: the migration sits in an earlier
commit, so the diff that was supposed to catch it is empty exactly when it
matters (`ship-workflow-gate.test.ts`, "the branch that arms a release also
arms the migration"). The consequence is that **a merged migration waits for
the next release**, so a branch that adds one owes a changeset naming a deploy
carrier (`aai-server` or `aai-studio-server`) — and
**`check:deploy-changeset` now enforces that**, because until it did, nothing
could: that gate was scoped to `packages/<carried>/`, and `changeset status`
answers for workspace packages, which `supabase/` is not. So a migration-only
branch cleared every gate in the repository and armed nothing. The account
below is why that job exists, and it stands as the reason
not to remove it. It has
already happened once: `20260808120000_agents_config_default.sql` stopped
`agents.config` being written but was never pushed, so **every** `POST /deploy`
died on `null value in column "config" violates not-null constraint` — Publish
and auto-preview alike — while CI was green and the deploy reported success.
Push migrations before shipping a release that needs them:

```sh
supabase db push        # from the repo root, against the linked project
```

**A migration must be survivable by the code ALREADY in production, because it
applies before the deploy and the deploy can fail.** `migrate` declares only
`needs: changed`, so it runs beside the npm publish and the guest-image build
rather than behind them — and every check that could stop a bad rollout (the
GHCR preflight, `verify_modal_deploy.py`, `smoke-spawn.mjs`) lives in `deploy`,
downstream of a schema change that has already committed. A red `guest-image`
therefore leaves production on the old code against the new schema, and
`modal app rollback` does not undo DDL.

So the ordering rule is expand/contract, and it is a rule rather than a habit:
**a contraction ships at least one release after its expansion.** Both
contractions in this tree already do —
`20260808120000_agents_config_default.sql` stopped `agents.config` being
written and `20260810030000_drop_agents_config.sql` dropped it a release later
— and that spacing is load-bearing rather than incidental. The same applies to
anything that VALIDATES existing rows:
`20260810010000_workspace_child_foreign_keys.sql` adds two foreign keys and
clears the orphans first, in the same file, because `add constraint` validates
every row and CI would never have shown it (see the next paragraph but one).

**Two gates hold the ordering, and neither can see production.** They are
push-time approximations of facts about a database, and worth knowing the limits
of:

- **`check:migration-order`** — every migration a branch ADDS must sort after
  every migration on the merge base, and every filename must be
  `<14 digits>_<name>.sql`. `db push` refuses a pending file older than the last
  remote row, which is a MERGE hazard: each branch picks a plausible next
  timestamp against the main it can see, both apply in isolation, and the
  inversion exists only in the merge. It has already cost a manual re-dating of
  two files (`aai-server` changelog, f376585). Reach for `git mv` to a newer
  timestamp, never `--include-all` — that flag applies every pending file
  whatever its order, making the applied schema a function of merge order rather
  than filename order.
- **`platform-schema.test.ts`, "no two migrations share a version"** — the
  neighbouring hazard: two files claiming ONE version abort the whole
  `supabase start` with a duplicate-key error naming neither.

**And CI proves the migrations build a schema from NOTHING, which is not the
claim `db push` needs.** `check.yml`'s `platform-stack` job runs
`supabase start`, which applies all of `migrations/` on init — a real and useful
property, and a different one from "these apply to the database production has
right now, with its rows in it". A migration that is valid from empty and
invalid against real data (the FK above, a `set not null`, a unique index over
duplicates) passes every gate here and fails at release, after the npm publish.
Nothing static can close that; the `migration list` preflight in the `migrate`
job makes the failure diagnosable from the log, and a staging project is the
only thing that would actually rehearse it.

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
