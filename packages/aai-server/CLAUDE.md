# packages/aai-server — platform guide

The agent service plus the shared platform core (private package). Repo-wide
conventions live in the root `CLAUDE.md`; the guest side of every sandbox is
in `packages/aai-guest/CLAUDE.md`, and the studio service in
`packages/aai-studio-server/CLAUDE.md`.

## Key files

- `orchestrator.ts` — HTTP + WebSocket routing
- `sandbox.ts` — agent sandbox lifecycle: `sessionUrl()` (the public tunnel
  endpoint the broker hands to clients), `drain(deadlineMs?)` (retirement's
  one request), `shutdown()`. DEPLOYED AGENTS RUN AS SERVERS — the host
  holds NO channel to them (see `packages/aai-guest/CLAUDE.md`, "Agent guests
  are servers")
- `sandbox-vm.ts` — `spawnAgentServer` (the agent-server dispatch over the
  two backends) and the studio-side `spawnWarmHarness` control-channel
  machinery
- `sandbox-backend.ts` — backend selection policy (`SANDBOX_BACKEND` override,
  production → `modal`, local dev → `subprocess`) plus the reason string
  the boot log prints, so "which backend am I on, and why" is one log line
- `warm-harness.ts` — backend-independent guest wiring shared by both backends:
  dial-with-retry, stdio draining, free-port allocation, `WarmHarness` exit and
  cleanup semantics
- `sandbox-slots.ts` — the per-slug slot cache: `{ slug, version?, sandbox? }`
  plus the slug lock. NO idle machinery — idleness is the guest's own job
  (agent-mode self-exit), and its exit drops the whole SLOT via
  `onSandboxLost` — not just its sandbox, which grew the map by one shell per
  slug for the container's life; a rebuild needs nothing from an empty slot
- `modal-context.ts` — the shared Modal context every spawn path needs
  first: the client, the App, the harness-baked snapshot image (built once
  per harness version, published under a content-addressed tag), and the
  harness bytes that tag is keyed on. All memoized, so a spawn racing the
  boot-time prewarm joins it
- `modal-sandbox.ts` — Modal Sandbox backend, CONTROL-CHANNEL guest (studio):
  creates the sandbox, execs the Node harness with a per-sandbox
  bearer token, and dials its WebSocket through the sandbox's Modal tunnel.
  The deployed-agent spawn is `modal-agent-sandbox.ts`
- `packages/aai-guest/` — the guest the two backends spawn; its own private
  workspace package, resolved here only as a built artifact
  (`aai-guest/harness` → `dist/harness.mjs`). See
  `packages/aai-guest/CLAUDE.md`
- `modal_deploy.py` — Modal deployment of the agent service
  (`@modal.web_server` wrapping the node process);
  `pnpm --filter aai-server deploy:modal`. The image recipe itself is
  `scripts/modal_image.py` — see "The image is layered dependencies-first"
  below
- `platform-lock.ts` — cross-replica per-slug mutation lock (see "Stateless
  server" below): a Postgres ADVISORY lock on a reserved connection in
  production, the in-process keyed lock in dev/tests
- `agent-store.ts` — the agents table (`aai_platform.agents`; memory in
  dev/tests): one row per agent — slug, credential hashes, content hashes of
  the worker/client blobs, and a deploy `version` that doubles as the
  cross-replica invalidation signal (see "Two packages, ONE deployment"
  below). NO description of the agent — see "The platform stores no agent
  config"
- `sandbox-resolve.ts` — slot-based slug→sandbox resolution +
  `watchAgentInvalidation`, the event-driven sandbox invalidation (split
  from sandbox.ts, which owns one sandbox's lifecycle)
- `sandbox-broker.ts` — `brokerSessionUrl`: slug → the public session URL a
  client dials, with the one failure taxonomy `GET /:slug/client-config` and
  the `/:slug/websocket` upgrade share. The platform's ONLY routing point
- `phone-handler.ts` / `phone-signature.ts` — `GET/POST /:slug/phone`: the
  carrier call-answering webhook (see "Telephony" below) and its webhook
  authenticity checks
- `sandbox-directory.ts` / `sandbox-peers.ts` — the fleet-wide answer to "is
  some replica already serving this deploy?", which is a Modal sandbox NAME
  (`agent-<hash(slug)>-v<version>`) rather than a lease table — see "No
  horizontal sandbox scaling" below
- `platform-events.ts` — `PlatformEvents`: cross-replica change
  notifications (`watchAgents`, `watchWorkspace`, `watchChat`,
  `watchScopeProjects`) as SIGNALS (handlers re-read rows, never trust
  payloads); memory emitter + store decorators for dev/tests.
  **A store decorator must wrap EVERY mutator, and a missed one is silent in
  both directions.** Production wraps nothing — the row's own UPDATE is what
  Realtime streams — so a gap here is invisible in production and, in dev, is
  a write that lands and bumps the version with no watcher ever hearing it;
  there is no polling loop behind these streams to cover for it.
  `withWorkspaceEvents` missed `patch`, which is the METADATA STAMP
  (`stampWorkspaceMeta`, the only writer of `previewSlug`/`previewHash`/
  `previewError`, `deployedSlug`/`deployedHash`, `databaseEnabled`), so under
  `pnpm dev:aai-server` a finished preview deploy pushed no `project` frame at
  all and the studio's Preview pane sat on its placeholder until a reload —
  Publish and the database switch equally quiet. It survived because the
  studio SSE test modelled the stamp as a read-modify-write (a `put`) instead
  of calling `stampWorkspaceMeta`; a test standing in for a real writer has to
  BE that writer.
  **Wait out an emit with `memory.settled()`, never a microtask spin** — an
  emit is fire-and-forget in both directions, and the spin's iteration count is
  unknowable and silent when wrong. The full account is on `settled()`'s own
  doc comment in `platform-events.ts`; the two consequences to carry into new
  code are that a watcher whose work must be waitable has to RETURN its promise
  (which is why `watchAgentInvalidation` returns its `withSlugLock` promise
  rather than `void`-ing it), and that because `settled()` really waits it can
  DEADLOCK — a test holding the slug lock must commit, release, then settle
- `realtime-events.ts` — the production `PlatformEvents`: Supabase Realtime
  `postgres_changes` on `aai_platform.agents` / `studio_workspaces` /
  `studio_chats` over `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, plus
  the boot-time `supabase_realtime` publication setup.

  **A channel that never joins is COUNTED, not narrated.** realtime-js rejoins
  forever, so a subscribe that can never succeed (a wrong-authority key, a
  missing grant) differs from a healthy channel only in the rate of a
  `console.warn` — which is how it twice reached production and merely stopped
  invalidating sandboxes and pushing SSE. The monitor records the last join
  per topic: an ordinary failure warns, a channel past `JOIN_BUDGET_MS` that
  has never joined escalates ONCE to `console.error`, and
  `PlatformEvents.health()` reports it in `/health`'s BODY — never as a 503,
  since the causes are project-wide and every replica would leave rotation at
  once, turning a feature outage into a total one.
- `pg-cron.ts` — janitorial sweeps as pg_cron jobs (dead rate-limit windows,
  orphaned `-preview` agents + their app database schema/role and Vault
  secrets, unreferenced deploy blobs, runaway tenant queries, pg_cron's own
  run log), installed idempotently at boot. `cron.schedule` upserts by name,
  so a job DELETED from `platformCronJobs()` keeps firing on any database that
  already has it — and `guarded()` makes that silent. Boot therefore DIFFS:
  every `aai-sweep-*` job in `cron.job` that the code no longer declares is
  unscheduled, so `platformCronJobs()` is the whole truth about what the
  platform runs and retiring one cannot be forgotten (the hand-maintained
  retired list this replaced had exactly one failure mode — omission).

  It is a FUNCTION because the blob GC needs deployment config: it deletes
  through the Storage API (a Storage object's bytes cannot be removed in SQL —
  deleting the `storage.objects` row orphans the object AND destroys the only
  record of it), so it needs `pg_net`, a project URL, a bucket, and a
  credential — read from Vault at run time, never interpolated into the job
  command where it would be plaintext in every `select * from cron.job`.
  **Two guards there are load-bearing**: it refuses to run when
  `aai_platform.agents` is EMPTY (one bad read otherwise concludes every blob
  is garbage), and its grace window is a day — far past the retirement drain
  and the signed worker URL's TTL, so it cannot delete what a spawn is still
  reaching for.
- `studio-paths.ts` — `isStudioPath`, the studio/agent surface boundary the
  combined entry dispatches on. Must agree with `RESERVED_SLUGS`
- `app-middleware.ts` — the two apps' shared base middleware, so they can't
  drift on CORS/framing policy
- `rpc-transport.ts` — WebSocket JSON-RPC transport for host↔guest RPC.
  Connections are typed by a per-direction method map (`RpcSchema`); the
  sandbox link's concrete map is `GuestRpcSchema` in `rpc-schemas.ts`, so
  method names and outgoing request params are compile-checked at every
  call site while results/incoming params stay `unknown` (untrusted wire
  data — Zod at the receiving site is the contract)
- `transport-websocket.ts` — WebSocket transport layer, plus the agent's own
  client surface (`GET /:slug/`, `/:slug/assets/*`, `/:slug/favicon.ico`).

  **The agent shell is `no-store`; its hashed assets are `immutable`.** Same
  pairing as the studio shell (`aai-studio-server/CLAUDE.md`), reached by a
  different route: `getClientFile` resolves a path through the agents row's
  `client_files` map, and a redeploy REPLACES that map — so the previous
  build's asset names stop resolving and 404, even though their blobs survive
  (content-addressed, orphans kept). A browser holding a cached shell is
  pinned to a build whose entry script is gone, and unlike the studio there is
  no `stale-build.ts` on this surface to force the recovering reload. It
  carried NO cache headers for a long time, which is weaker than it sounds:
  absent a directive and a validator, a heuristically caching intermediary may
  reuse the response.
- `api-key-verify.ts` — raw API-key verification against AssemblyAI (see
  "Auth" below). The one absolute authentication check on the platform
- `rate-limit.ts` — the shared fixed-window limiter (in-memory + Postgres).
  It lived in `aai-studio-server` while the studio was its only caller, which
  is why `POST /deploy` had none: this package cannot import from that one.
  Policy stays with each consumer; only the mechanism is here
- `client-ip.ts` — the rate-limit key. Reads the **last** `X-Forwarded-For`
  entry (the hop our own proxy appended), not the first — the leftmost is
  client-supplied, and keying on it hands an attacker an unlimited supply of
  rate-limit buckets. Note `public-origin.ts` reads the FIRST entry from the
  same header and is right to: it wants what the browser saw, which is the
  opposite end of the same list
- `_semaphore.ts` — counting semaphore with a bounded wait. Caps how many
  deploy bodies buffer at once (`DEPLOY_BODY_CONCURRENCY`): the size caps
  bound ONE request, and peak memory was arrival rate times ~164 MB against a
  2048 MiB container — a number the caller picks. Measured: 28 KB on the wire
  inflates to ~164 MB of RSS, so 24 concurrent cost ~812 MB ungated and
  ~333 MB gated, the gated figure being flat in N rather than smaller
- `auth.ts` — authentication/authorization
- `credentials.ts` — credential derivation
- `bundle-store.ts` — deploy persistence (blob reads AND writes retry
  transients — the write path moves far more bytes, and a content-hash key
  plus `upsert` makes a retry byte-identical): content-addressed, immutable
  blobs (`blobs/<sha256>` — worker + client files) committed
  by the agents-row upsert, which is the deploy's ATOMIC publish point.

  **Its caches are read-through, and read-through has a hole a TTL cannot
  close: the burst that arrives while the FIRST read is in flight.** Every
  cache here serves a read that already happened, so a cold replica — the
  normal state after a scale-out, since Modal load-balances every request
  independently — answered N concurrent requests for one deploy with N
  identical Postgres reads and N identical Storage downloads. Measured
  against the real orchestrator with 40 ms of injected backend latency, 20
  browsers each fetching the shell plus one asset: **61 backend round trips,
  against 3** with the row/version/blob reads behind `createSingleFlight`
  (`_memo.ts`). It is deliberately NOT a memo — it retains nothing, because
  the caches above already own the settled value; it only collapses the
  window.

  Two properties are load-bearing. `invalidate` **drops the row and version
  flights**, so a caller arriving after a mutation cannot be served a read
  that started before it — the same hazard the read epoch guards one step
  later (the epoch fences the cache WRITE; the drop fences the JOIN), and the
  mutation lock's whole premise is that the handler reads its merge base
  after invalidating. Blobs need neither, being content-addressed. And the
  release runs **out of band** (`then(release, release)`, never a `.finally`
  chain the caller awaits): wrapping the returned promise costs a microtask
  turn per read, and settling one turn later is observable — it pushed the
  change stream's blue-green handover past the fixed 20-microtask drain
  `sandbox-resolve.test.ts` settles events with.
- `blob-storage.ts` — where those blobs live: Supabase Storage through
  `@supabase/storage-js` in production (authenticated with the SAME
  `SUPABASE_SERVICE_ROLE_KEY` as Realtime — Storage has no credential of its
  own), memory in dev/tests. The surface is `getItem`/`setItem`/`signedUrl`
  and nothing else (see "The guest fetches its own bundle" for the third).
  It replaced unstorage's generic S3 driver plus a local
  override of that driver's `getKeys` (which lists the whole bucket and reads
  only the first 1000-key page): once workspaces moved to Postgres NOTHING
  lists keys, so the override guarded a call no longer made, and the
  `SUPABASE_S3_*` endpoint/region/key set was a third credential for a
  project already reachable two other ways. A miss (404) MUST resolve `null`
  while any other failure throws — the bundle store caches misses under a
  sentinel and retries failures, so conflating them makes a live deploy read
  as absent.

  **Uploads carry a one-year `cacheControl`, and it is inert on purpose.**
  Nothing reads a blob through a cache today — every read is either an
  authenticated `download()` (which Supabase's CDN will not cache) or a
  per-call signed URL (fresh token, fresh cache key). It is set anyway because
  Storage stamps the directive at UPLOAD time and never revisits it: left at
  storage-js's 3600 default, every blob already written would carry the wrong
  one on the day anything IS served through the CDN, and fixing it then means
  re-uploading the bucket. A year is correct by construction rather than as a
  guess — the key is the content hash, the same reasoning that lets the asset
  routes serve `immutable`.

  **`SUPABASE_SERVICE_ROLE_KEY` must be a SECRET key (`sb_secret_…`), and boot
  refuses a publishable one** (`assertServiceRoleKey` in `_boot.ts`, called
  once from `buildServiceConfig` — the only caller of both consumers, so the
  guard cannot be half-applied). A publishable key authenticates fine and then
  carries `anon` authority, which breaks both things that share the variable,
  neither of them legibly. **Storage**: a `blobs/<sha256>` write dies on
  `storage.objects` RLS with `new row violates row-level security policy`,
  reading as a broken bucket policy rather than a wrong key — and the
  `SUPABASE_S3_*` path this replaced went through Supabase's S3 gateway, which
  bypasses RLS entirely, so the same wrong key was INERT until deploys stopped
  using it. **Realtime** is worse: nothing surfaces at all. Filter columns are
  validated against the subscriber's role and the platform schema grants
  `select` to `service_role` only, so every filtered subscribe fails
  server-side with `invalid column for filter` and realtime-js retries the
  join forever — the service boots healthy and merely stops invalidating
  resident sandboxes on redeploy and stops pushing studio SSE. Only the two
  definitely-wrong forms throw (the `sb_publishable_` prefix, and a legacy JWT
  whose `role` claim is `anon`); anything unrecognizable is left to Supabase,
  which rejects it with a better message than a shape check can. Note
  `SUPABASE_PUBLISHABLE_KEY` (browser sign-in, `supabase-auth.ts`) is a
  separate setting and stays publishable.

  Agent env lives in Supabase Vault through the injected `SecretStore`.

  **No referrer may delete a blob, but the SET of referrers may.** Content
  dedupes, so a superseded deploy's blob can be another agent's live file —
  which for a long time meant nothing deleted one, ever, and the bucket grew
  by a worker bundle (~8 MB) per changed deploy. `aai-sweep-blob-gc`
  (pg-cron.ts) closes it by mark-and-sweep, safe only BECAUSE the keys are
  hashes: the live set is every `worker_hash` plus every value of
  `client_files`, so a blob outside it is unreferenced by construction.

  **`assertBucketPrivate` refuses boot on a MISCONFIGURED bucket and only
  warns on an unreachable one.** The bucket is the one piece of Supabase state
  living in the dashboard rather than in `supabase/migrations`, so nothing
  else would notice it going missing or turning public. But this guard is a
  network call, unlike `assertServiceRoleKey`/`assertSessionModeUrl` — failing
  boot on a Storage blip would stop every container at once, a worse outage
  than the one guarded against.
- `deploy.ts` / `delete.ts` — deployment lifecycle
- `secret-handler.ts` — secret management
- `secret-store.ts` — `SecretStore` interface: Supabase Vault
  (`createVaultSecretStore`, over the `SUPABASE_DB_URL` Postgres
  connection) in production, in-memory for local dev/tests. Holds agent
  env (`agent-env:<slug>`), app-database credentials (`app-db:<slug>`), and
  the platform's own Storage key for the blob GC sweep
  (`PLATFORM_STORAGE_KEY_SECRET`).

  **`put` absorbs a lost create race.** Read-id-then-create-or-update has a
  window, and while every per-SLUG write is serialized by the advisory lock,
  the ACCOUNT paths are not — `PUT /studio/account/key` and
  `POST /studio/cli-link/approve` can write the same name at once. A `23505`
  is retried as an update exactly once, which is sufficient by construction:
  after it the name exists. Read the SQLSTATE, never the message.
- `app-database.ts` — per-app Postgres schema/role provisioning in the
  platform Supabase database (`provisionAppDatabase`,
  `deprovisionAppDatabase`, `openAppDb`).

  **Deprovision follows the app's stored LOCATOR, never a recomputed
  placement.** Placement is `hash(slug) % targets.length`, so changing
  `APP_DB_URLS` re-shuffles every existing app and the `url` in its
  `app-db:<slug>` meta is the only record that survives it. Recomputing —
  which this used to do, reasoned as "same deterministic placement" — issues
  both `if exists` drops against a cluster that never hosted the app (silent
  no-ops) while the caller deletes the secret holding the real schema's only
  credential: tenant data left unreachable, nothing raised. Both call sites
  read the meta BEFORE it is swept; with no meta every target is swept, since
  a slug-derived drop where the app never lived is a real no-op.

  **The per-tenant caps differ in strength, and only two are controls.**
  `connection limit` is superuser-only to raise and `temp_file_limit` is
  `SUSET` (lowerable, never raisable), but `statement_timeout` is `USERSET` —
  tenant code holding the credential can `set statement_timeout = 0`. The 10s
  setting is what a well-behaved app sees; the enforceable half is
  `aai-sweep-app-db-runaways`, which terminates `app\_%` backends active past
  a much higher ceiling. Never treat the role setting as isolation.
- `storage-handler.ts` — `GET/POST/DELETE /:slug/storage` (owner-auth'd)
  toggling the app's database, plus `storageUsage`/`appDatabaseUsage` (how
  much is IN it — see `packages/aai-studio-client/CLAUDE.md`)

## Stateless server

The platform server holds no cross-request durable or coordination state in
process — any replica can serve any request, and a replica restart loses
nothing but live control-channel connections (voice sessions don't pass
through it at all). Everything durable lives in Supabase (bundles and
client files in Storage, agent env + app-db credentials in Vault, studio
workspaces/chats and per-app data in Postgres), and cross-replica
coordination lives in the same Postgres over `SUPABASE_DB_URL`.

**Being stateless does not mean everything has to flow THROUGH the replica.**
Two of the largest byte paths deliberately don't: `ctx.db` connects from the
guest directly on the app's own scoped role, and a guest fetches its own worker
bundle from a signed Storage URL (see "The guest fetches its own bundle"). The
pattern both follow is the same — hand out a narrowly scoped capability and
verify the result (a per-app Postgres role; a content hash) rather than proxy
the bytes to keep the platform's credential out of reach.

### Where we differ from Supabase's own recommendations

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
string), and `jsonb-encoding.integration.test.ts` for the guard. The reason it
survived so long is worth keeping: **the in-memory stores cannot represent the
bug.** They hold JS objects, so the encoding has no analogue in them, and every
unit test passed against a shape production never had. Anything that reaches
into a jsonb column from inside Postgres — an arrow operator, `-`, `jsonb_set`,
a predicate in a pg_cron body — needs a test against a real database.

**Those are both the FORWARD direction, and the reverse one cost us three
tables.** A table that is queried nowhere *and* declared nowhere satisfies
every check above trivially, and production held exactly that:
`sandbox_registry`, `slug_epochs`, and `slug_locks`, created at runtime by
`pg-ensure.ts` before the schema was declared and never dropped — because a
declared schema has no `drop` for a table it never declared. #950 replaced each
one (a Modal sandbox NAME, `agents.version`, and `pg_advisory_lock`
respectively) and correctly declared only what the code still needed, which is
how they became invisible rather than wrong.

They were not inert. `20260807000000_platform_rls.sql` enables RLS on the five
tables it names, so leftovers would have been the only tables in the schema
without it — and nothing reports that, since splinter's
`rls_disabled_in_public` and the RLS-disabled alerts both key on `public`.
`20260807120000_drop_orphan_platform_tables.sql` drops them (`slug_epochs` was
not empty: 21 stale counters superseded by `agents.version`, recorded in that
migration's header rather than discovered afterwards).

**Drift detection cannot be static** — it is a fact about a database, not the
repo — so the guard is `schema-drift.integration.test.ts`, gated on
`AAI_TEST_PG_URL` and read-only, asserting every table in `aai_platform` is
declared by a migration. Point it at whatever database you want the claim to
hold for; `supabase db diff --linked --schema aai_platform` is the ad-hoc
equivalent and also reports column-level drift.

The cross-replica coordination that lives in this same Postgres:

- **Per-slug mutation lock** (`platform-lock.ts`): deploy/delete/secret/
  storage mutations for a slug run under a **Postgres advisory lock**
  (`createPgSlugLock`), injected as the `slugLock` binding. This was a lease
  table, on the reasoning that "advisory locks are connection-scoped and
  `SqlExec` runs over a pool, so acquire and release could land on different
  connections" — true, and the answer is to stop using the pool:
  `AdminDb.reserve()` (postgres.js `sql.reserve()`) holds ONE connection for
  the critical section. That deleted the table, the 250ms poll loop
  (`pg_advisory_lock` queues the waiter inside Postgres), the lease sweep,
  and the "not renewed while held" caveat — an operation now holds the lock
  until it finishes, however long that takes, and a dropped connection
  releases it, so a crashed replica frees its slug immediately. The acquire
  deadline is `lock_timeout` on that connection; Postgres raises `55P03`,
  which becomes `SlugLockTimeoutError` → 409. The key is
  `pg_advisory_lock(SLUG_LOCK_NAMESPACE, hashtext(slug))` — two ints so the
  namespace can never collide with another advisory-lock user in the
  database. It still takes the in-process `withSlugLock` first, now so a
  local waiter doesn't hold a reserved connection open while blocked.
  `sandbox-resolve.ts` stays on the in-process lock deliberately: it guards
  this replica's slot cache, a legitimately process-local resource.

  **The acquire deadline applies to BOTH halves, because the mutex is taken
  first.** `lock_timeout` → `55P03` → 409 only ever saw CROSS-replica
  contention; two mutations of one slug on one replica queued on the mutex
  unbounded — reachable in practice, since `watchAgentInvalidation` holds it
  across `handoverSlot`'s 120s boot. The mutex now carries the same deadline
  (`KeyedLockTimeoutError` → `SlugLockTimeoutError`), and a waiter that gives up
  must RESOLVE ITS PLACE IN THE CHAIN or everyone behind it blocks forever.

  **The connection budget is fleet-wide** (`MAX_PLATFORM_DB_CONNECTIONS`,
  pinned by `platform-db-budget.test.ts`): these are DIRECT session-mode
  connections, so `MAX_CONTAINERS` × the per-replica pools consumes
  `max_connections` outright — a product spanning two files that never referred
  to each other, whose ceiling is an outage rather than degradation.

  **`SUPABASE_DB_URL` must be the direct, SESSION-mode connection string.** A
  transaction-mode pooler (Supavisor's port 6543, `pgbouncer=true`) returns
  the server connection between statements, so an advisory lock taken through
  one is not held by whoever thinks it holds it — silent loss of mutual
  exclusion. `assertSessionModeUrl` refuses such a URL at boot rather than
  letting that be discovered later. Per-app databases are unaffected: they are
  fronted by the pooler on purpose and take no advisory locks.

  **The binding is wrapped in `createMutationLock`, and must stay wrapped:
  taking the lock also drops this replica's cached view of the slug.**
  Exclusion alone is not enough, because every mutation is a read-modify-write
  over a read-through row cache — `handleSecretSet` merges onto `getEnv`,
  `deployLocked` merges the stored env *and* `credential_hashes` off
  `getAgent`. A row that replica A wrote moments ago can be invisible to
  replica B's cache, so B computes its merge from a pre-lock snapshot and
  writes the older value back. The two writes were serialized perfectly and
  one of them still vanished, silently: a secret reverts, or a deploy drops
  a co-owner's credential hash. Invalidation belongs at lock acquisition
  (one place, in `platform-lock.ts`) rather than per route — a route that
  forgets produces no error at all. Only the row caches are dropped: blob
  caches are content-addressed and cannot go stale. The broker path
  deliberately does NOT go through this wrapper — it mutates nothing.
- **Rate limits** (`rate-limit.ts`; the studio's windows in
  `aai-studio-server/studio-rate-limit.ts`): the chat, project-create, and
  deploy windows are rows in `aai_platform.studio_rate_limits`
  (`createPgRateLimiter`, one atomic upsert per check), so a limit holds
  platform-wide instead of multiplying by the replica count — which for an
  ABUSE limit is the whole point, since `MAX_CONTAINERS = 10` makes a
  per-replica cap a cap of ten times the number written down. Fail-closed: a
  database error propagates rather than silently unmetering the route.
  Expired rows are swept by pg_cron (`pg-cron.ts`), not in-process. The
  `studio_` table name is now a misnomer; `name` namespaces each limiter's
  rows, which is what lets a second consumer share it without a migration.

  **Every limited route is keyed TWICE — by scope and by client IP.** The
  scope key is derived from the caller's bearer, so for a raw-key caller it
  was a value they chose: one character's difference minted a fresh window,
  which made both studio limits decorative against exactly the traffic they
  exist to stop. Key verification above is what makes a scope cost an
  account; the IP key is what bounds the damage before one is spent.
- **Session resume needs no cross-replica store**: sessions live in the
  guest sandbox, not on a replica — a `?sessionId=<id>` reconnect
  re-brokers via `GET /:slug/client-config` and lands on the SAME sandbox,
  whose in-guest runtime holds the state through the resume grace window.
  (The old host-side session-state persistence died with the host relay.)

What deliberately stays in-process, and why it doesn't break statelessness:

- **The slot cache and sandboxes** — a resident sandbox is a
  per-replica accelerator; the agents row's change stream (below) keeps
  residents correct across replicas, and losing them costs a rebuild,
  never correctness. WHICH sandbox a slug runs is not per-replica state,
  though: that lives in `aai_platform.sandbox_registry`, so a cold broker
  routes to a live peer's guest rather than spawning the fleet's Nth copy
  (see "No horizontal sandbox scaling" below).
- **Caches** (bundle-store row/version caches, hash-keyed immutable blob
  caches, the auth hash cache, the studio build cache) — TTL-bounded or
  content-hash-keyed read-through caches whose staleness windows are
  documented at each site.
- **The in-process workspace/slug mutexes** — kept *under* the distributed
  mechanisms so local writer fan-out doesn't burn the cross-replica
  retry/lease on itself.

## Two packages, ONE deployment (aai-server / aai-studio-server)

Two packages, one surface each, composed into a single process.

`aai-server` is the agent surface plus the shared platform core (stores,
locks, epochs, sandbox machinery); `platform-barrel.ts` is the sanctioned path
to its `_`-internal utilities. **It ships no entry point** — it is a library,
consumed through its `exports` map, and has no `build` (its subpaths resolve to
`.ts` source, which its consumer bundles).

`aai-studio-server` is the studio surface AND the composition root: its entry
is the only one any deployment runs, dispatching studio paths (`isStudioPath`,
`aai-server/studio-paths.ts`) to the studio app and everything else — including
`/health` and the WebSocket upgrades — to the agent orchestrator. Both apps
share one `ServiceConfig`, so they share the slot cache and stores. That entry
is what `pnpm dev:aai-server` runs too, so local dev and production are the
same composition.

There is ONE Modal app: `aai-server-web`, from `packages/aai-server/
modal_deploy.py`. Note the asymmetry — the deploy script lives in the package
that does NOT provide the entry; it is the platform's deploy policy, and it
launches `packages/aai-studio-server/dist/index.mjs`.

**A SPLIT deployment used to live here** — a second Modal app
(`aai-studio-web`) with the agent app reverse-proxying to a
`STUDIO_UPSTREAM_URL`. Removed rather than left dormant: the upstream was never
wired, so the combined branch was the only one that ever ran while the split
half still constrained the design. `modal_deploy.py`'s own "One app, both
surfaces" block carries the motivation and what reviving it would cost; two
constraints survive any revival — **one public origin** (agent pages set
`X-Frame-Options: SAMEORIGIN`, so a studio on a second hostname breaks the
preview iframe), and the studio service would need the event streams' timeout
raised (see "A long-lived connection is ONE Modal input").

**aai-server is COMPILED IN to that entry, and the bundler pattern must match
its SUBPATHS.** `aai-studio-server/tsdown.config.ts` lists it under
`deps.alwaysBundle`; `alwaysBundle` matches the SPECIFIER, not the package, and
every import here is a subpath (`aai-server/orchestrator`, …), so the
`/^aai-server$/` this replaced matched nothing and the whole package stayed
external. Nothing said so — the build succeeds and the entry runs; `dist/
index.mjs` is merely 150 KB of import statements rather than a 3.7 MB bundle.
The cost is paid at every container COLD START, because this package's exports
resolve to `.ts` SOURCE (it has no build): an externalized entry made every
boot resolve, read, type-strip and compile ~72 TypeScript modules before
serving a request, and left the image's compile cache (below) keyed on 72 files
instead of one. `bundled-deps.test.ts` holds the pattern to the specifiers the
entry really imports — the built file cannot be the guard, since `test` depends
on `^build`, not on this package's own build.

One consequence to keep in mind when adding code to aai-server: **the module's
own location is no longer where its source lives.** `createRequire(import.meta
.url)` resolves from `packages/aai-studio-server/dist/`, whose pnpm
`node_modules` has no `aai-guest` above it — which is why `guestPackageDir`
(modal-harness-image.ts) falls back to deriving that package root from the
harness path. Anything else that resolves a workspace sibling by module
location owes the same fallback.

**The shared core is the `exports` map, and nothing else.** It is an
explicit list of 31 subpaths, grouped by role (stores, coordination, sandbox
machinery, schemas, app composition, the routes the studio reuses), and
`platform-surface.test.ts` holds it to the imports that actually exist in
both directions — an entry nobody imports fails, and so does an import with
no entry. It was `"./*": "./*.ts"` for a long time, which meant every one of
the package's ~70 modules was published to the sibling: the prose above
described a "shared core" that no code distinguished from the agent
service's own internals, so `aai-studio-server` reached into 31 of them and
none of those reaches could be called a violation. Widening the surface is
now an edit to package.json rather than a side effect of typing an import
path. When a coupling goes away, delete the entry — this list only ratchets
down, like the file-length allowlist.

- **One public origin**, now structurally rather than by proxying: both
  surfaces are served by one process on one hostname. This is what keeps the
  preview iframe working — agent pages are served `X-Frame-Options:
  SAMEORIGIN`, so the studio must share their origin. Shared base middleware
  lives in `app-middleware.ts` so the two apps can't drift on CORS/framing
  policy.
- **Never derive the public scheme from the request URL** — use
  `resolvePublicOrigin` (`aai-server/public-origin.ts`). Modal terminates TLS
  at its edge and forwards plain HTTP to the container (its ASGI proxy adds
  only `X-Forwarded-For`, never `X-Forwarded-Proto`), so `new URL(c.req.url)`
  is **always** `http:` in a handler, whatever the browser used. Resolution
  order: `AAI_PUBLIC_ORIGIN` → `x-forwarded-host`/`-proto` (a real proxy in
  front) → infer, loopback being the only `http`.

  Both places that had rolled their own cost real outages. Studio **Publish
  died on `401 Missing Authorization header` from its own platform**: the
  guest was handed `http://<public host>`, its `aai deploy` POST was
  308-redirected to `https://`, and `fetch` strips `Authorization` across a
  scheme change (different origin per the Fetch spec). The request arrived
  unauthenticated, so the CLI reported an invalid API key it had in fact sent
  correctly. (The since-removed studio proxy propagated the same wrong answer a
  second way, forwarding its own `x-forwarded-proto: http`.) The bare-slug
  redirect
  (`/:slug` → `/:slug/`) separately echoed the cleartext URL back as an
  absolute `Location`, bouncing https browsers through `http://`; it is now
  relative, which no scheme can taint.
- **Cross-service invalidation is the agents row's CHANGE STREAM**
  (`agent-store.ts` for the row; `platform-events.ts` /
  `realtime-events.ts` for the stream; `watchAgentInvalidation` in
  `sandbox-resolve.ts` for the handler). Mutation handlers ONLY write the
  row — deploy upserts it (bumping `version`), delete removes it — and
  every replica, the writer included, reacts to the resulting Supabase
  Realtime `postgres_changes` event: the handler drops the bundle-store
  row caches, re-reads the version fresh (events are signals, never
  payloads), and retires a resident at a different version (terminates on
  a deleted row — a deleted agent must stop answering, not drain). This is
  how a studio-service Publish reaches the agent service's resident
  sandboxes within seconds. There is no separate signal to send — the row
  write IS the notification, so no bump can be missed — and no duplicate
  detection paths: the per-broker lazy version check and the idle sweep's
  `SupersededCheck` were both removed when the change stream replaced
  them, so `resolveSandbox` serves any LIVE resident as-is and the idle
  sweep is purely about idleness. (Worker/client blob caches are
  hash-keyed and immutable — a stale row is a consistent OLD deploy, never
  a torn mix, and a wrong blob is structurally impossible.) The handler's
  version comparison under the slug lock is what makes duplicated or
  reordered events harmless; an unreadable version logs and leaves the
  resident alone rather than killing a healthy sandbox.

  **The stream's REJOIN is itself a signal, and on THIS stream it has to be.**
  `subscribe()` only sends the join — the binding is not live until the ack,
  and realtime-js rejoins after any socket drop — so changes in either window
  reach nobody, ever. The pooled channels always fired their watchers on the
  ack; the AGENTS channel did not, and it is where the gap is unrecoverable,
  being the single mover of residents with no later check behind it (see the
  deleted duplicate paths above). A deploy during a drop left the replica
  serving superseded code and a delete left it answering for a deleted agent,
  until the guest happened to self-exit on idle — for a busy agent, never,
  since traffic is what keeps it non-idle. The deploy reported success.

  So `watchAgents` takes a second, slug-less `onResync`, which
  `watchAgentInvalidation` answers by re-running the same per-slug reconcile
  over every resident. Three properties: it is a **separate callback, not a
  nullable slug**, so a consumer that ignores resync says so by omission
  rather than mishandling a sentinel silently; **the residents are the query,
  not the agents table** — one version read per sandbox actually served
  (single-flighted, 1s-cached) and none at all on a replica holding none,
  because every reconnect fires this and the common case must stay a cheap
  re-read; and **registration precedes `ensureAgentsChannel()`**, so a join
  cannot fire ahead of the watcher that triggered it.

  The subscription MONITOR (`createSubscriptionMonitor`, via `/health`) is the
  complement, not the same thing: it makes a channel that never joins visible,
  and cannot repair one that dropped and recovered on its own — the common
  case, and the silent one.

  **Deploy and delete are the ONLY mutations that move sandboxes.** Secret
  and storage changes write Vault and bump nothing — they take effect on
  the agent's next deploy (or whenever its sandbox is next rebuilt). That
  trade deleted the whole secret-invalidation mechanism (the old
  `aai_platform.slug_epochs` table); the documented way to apply a secret
  now is to redeploy.

  **Supabase setup this depends on lives in `supabase/migrations`**, applied
  with `supabase db push` BEFORE the code that queries it: the `aai_platform`
  schema and its tables, the watched tables' membership in the
  `supabase_realtime` publication, the
  `service_role` SELECT grants, the workspace-child foreign keys, the
  orphan-sweep's `studio_workspaces.preview_slug` generated column + index,
  and the
  `pg_cron`/`pgmq`/`pg_net` extensions. Realtime validates channel filter
  columns (and gates row visibility) against what the subscriber's claimed
  role can SELECT, and the app-created `aai_platform` schema gets none of
  Supabase's default `public` grants, so without those grants every filtered
  subscribe fails with `invalid column for filter <col>`. Only the pg_cron
  SCHEDULING stays at boot (`schedulePlatformSweeps` via
  `bootstrapPlatformDb`), because the sweep bodies are defined in TypeScript
  and change with the code that owns them.
  The env carries `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for the
  Realtime socket, required in production alongside `SUPABASE_DB_URL`.
- **A superseded sandbox is RETIRED, not terminated** (`sandbox-retire.ts`).
  A mutation replaces the code a slug runs; it says nothing about the calls
  already in flight on the old sandbox, and closing their sockets inline —
  which every mutation path used to do — meant shipping during the day
  dropped live conversations. `retireSlot` splits the two things
  "terminate" conflated: it detaches the sandbox from the slot
  **synchronously, with no await in between** — the broker is the only
  routing point, so from that instant no NEW session can reach it and the
  slug is free to rebuild — then FIRE-AND-FORGETS one deadline-carrying
  `POST /manage/drain` to the guest. The GUEST owns the drain from there
  (`harness-agent-mode.ts`): it refuses new direct-dial sessions, exits the
  instant its last session ends, and exits at the deadline
  (`SANDBOX_RETIRE_DRAIN_MS`, 10 min, env overridable; 0 terminates
  immediately) regardless — a retired sandbox is a billed guest running
  superseded code. The host keeps NO drain state and runs no poll loop; an
  unreachable guest (the drain request rejects) is terminated on the spot.
  - **Retirement is for superseded, not gone.** A failed VM, an exited
    guest, and a deleted agent stay on `terminateSlot`: there is nothing to
    drain, and a deleted agent must stop answering rather than keep taking
    calls for ten more minutes.
  - **Process teardown deliberately does NOT chase retired guests** — they
    are off the slot map and self-governing; their drain deadline is
    minutes past the container grace period, and Modal's sandbox `timeoutMs`
    is the backstop behind everything.
- **The studio service holds an always-empty slot cache** — the shared
  mutation cores' local sandbox teardowns are deliberate no-ops there,
  while the deploy's row-version bump does the real work. It shares
  everything else through Supabase and spawns its own Modal sandboxes for
  `test_agent` and Publish.
- **The web service autoscales** (constants block in `modal_deploy.py`),
  bounded by `MIN_CONTAINERS`/`MAX_CONTAINERS`. Scale-in is FREE for voice
  sessions: a replica going down RETIRES its agent guests instead of
  waiting on or terminating them (`teardownSandboxes` — one awaited,
  deadline-carrying drain per guest, then exit).

  **Shutdown has to stop BOOTING sandboxes before it stops serving.**
  Flipping `draining` only makes `/health` fail; the proxy stops routing here
  when it notices, up to a health-check interval later. A request landing in
  that window used to take the cold broker path, find an emptied slot, and
  spawn a guest seconds before the process exited — ORPHANED, since no slot
  referenced it and nothing held it, billing until Modal's idle timeout. Two
  guards, in order of importance: `brokerSessionUrl` refuses to boot a new
  sandbox when `isDraining` (503, so the client re-brokers onto a live
  replica) while still serving a LIVE resident, which orphans nothing; and
  `teardownSandboxes` waits `SHUTDOWN_GRACE_MS` (3s, env-overridable) before
  emptying the slots, so requests that would have been served still are. The
  wait is deliberately short — it spends the same SIGTERM allowance the
  drains need, and an undelivered drain is the worse failure. The studio-only
  service passes 0: its slot cache is always empty, so it has no such window.
  Sessions dial the sandbox
  tunnel directly and the guest has no dependency on the replica, so live
  calls finish in the guests on their own clock after the replica is gone;
  the next replica's broker spawns fresh sandboxes on demand. The old
  count-guest-sessions-and-wait shutdown drain (`liveGuestSessions`,
  `drainActiveSessions`, `SHUTDOWN_DRAIN_MS`) was deleted — it could only
  ever delay the exit, and past its 120s budget it cut the very calls it
  existed to protect. Studio guests DO go down with the replica (the
  broker's `dispose()`): their coding-agent sessions live on the host's
  control channel, so a dead host makes them useless.

  **Shutdown is BOUNDED at two levels**, because `createShutdownHandler` arms
  its `SHUTDOWN_CLOSE_FALLBACK_MS` timer only AFTER `onShutdown()` settles — so
  the sole deadline used to cover the fast half (waiting for connections to
  close) and leave the slow half unbounded, and the slow half is the one that
  hangs. `SANDBOX_TEARDOWN_READY_MS` caps the readiness wait `Sandbox.drain` /
  `shutdown` inherit from the spawn (the 120s BOOT budget, spent on guests with
  nothing to drain); `SHUTDOWN_TEARDOWN_TIMEOUT_MS` is the general net over it,
  since the Modal calls underneath carry no timeout at all. Both constants
  carry the budget arithmetic and the why-giving-up-is-safe argument in
  `constants.ts`; read them before changing `SHUTDOWN_GRACE_MS`, which they are
  sized against. Pinned by tests that FAIL FAST rather than hang — "this
  settles within a budget" times out to the suite limit once the budget is
  gone, so the teardown promises are never awaited; settlement is recorded on
  a `vi.fn()`.
- **Shutdown ENDS long-lived responses; it must never let the process exit
  destroy them** (`live-streams.ts`, wired into `serve-lifecycle.ts`). SSE
  streams never end on their own, so `server.close()` waited out
  `SHUTDOWN_CLOSE_FALLBACK_MS` and `process.exit(0)` then destroyed the
  sockets — cutting each chunked body before its terminating `0\r\n\r\n`.
  That is a protocol error to whatever is reading, and in production the
  reader is Modal's in-container ASGI proxy, which surfaced it as a recurring
  unretrieved-task `ClientPayloadError: Response payload is not completed:
  <TransferEncodingError: 400, 'Not enough data to satisfy transfer length
  header.'>` on `GET /studio/projects/<x>/events`, with nothing tying it to a
  replica scale-in. The studio's SSE pusher (`studio-sse.ts`) registers; with
  both surfaces in one process that is the only place a stream is owned. (The
  split deployment additionally relayed proxied streams through one it owned —
  `gracefulEventStream`, `text/event-stream` only so assets and JSON stayed
  zero-copy — because the browser's connection terminated at the agent replica;
  reviving the split owes that back.) Ending them is also what lets
  `server.close()` complete, so shutdown stops hitting the fallback timer at
  all. The client sees a clean stream end and resubscribes on its existing
  backoff (`useEventStream`). Any future long-lived response owes the same
  registration — the wire-level guard is `live-streams.test.ts`, which reads
  raw socket bytes because a handler-level assertion passes with the bug
  present.

  Three properties of the ending itself, each of which was a hole that put the
  truncation back while the registry looked correct:
  - **It runs FIRST, before the service teardown.** Ending a stream is
    synchronous and depends on nothing, while `onShutdown` sleeps
    `SHUTDOWN_GRACE_MS` and then awaits one drain request per resident guest —
    seconds at best, and up to `SHUTDOWN_TEARDOWN_TIMEOUT_MS` when a guest is
    unreachable or still booting (it was genuinely unbounded before that
    deadline existed). Modal SIGKILLs the container when its stop grace lapses,
    so ending them *after* the teardown made the graceful end contingent on
    sandbox teardown finishing in time — which is a bound now, but still not a
    dependency worth having.
  - **The registry LATCHES closed.** Nothing drains it twice, so a stream
    registered after shutdown began would be held open until the exit destroyed
    it; `registerLiveStream` therefore ends a late arrival on the spot instead.
    That is not the rare case — the client's first reconnect backoff is 3s and
    shutdown deliberately keeps serving for `SHUTDOWN_GRACE_MS`, so a
    resubscribe landing mid-shutdown is the MODAL case. (`resetLiveStreams` is
    a test-only seam for the latch.)
  - **The crash path ends them too** (`installProcessSafetyNets` in
    `service-config.ts`): `uncaughtException` → `process.exit(1)` destroys
    sockets exactly as a scale-in does.
- **A long-lived connection is ONE Modal input, so the function `timeout`
  bounds CALL DURATION** — not request latency. The app therefore sets it
  explicitly (`FUNCTION_TIMEOUT_SECS` = 4h, matching
  `DEFAULT_SANDBOX_TIMEOUT_MS`). Left unset, Modal's default is **300s**, and it
  severed every in-process session (the old `?host=1` host mode, since
  removed) at exactly five minutes, mid-word — the client saw a bare "not
  connected" and the server logged nothing, because nothing in our code did
  it. No session runs in the server process anymore — browser voice sessions
  dial the guest sandbox's tunnel directly, and `/:slug/websocket` upgrades
  are handshake redirects — but the studio's SSE streams sit under the same
  cap, so it stays pinned rather than inherited. The sandbox layer hit the same
  trap first and documents it in `modal-sandbox-env.ts`.

  **The 4h ceiling is load-bearing for the studio's event streams, which is a
  trap for anyone re-splitting the deployment.** The removed studio app set 30
  min, reasoned as headroom for a cold-sandbox Publish on the premise that
  "nothing here is long-lived by design" — true of WebSockets (chat streams
  browser→guest directly) and false of `GET /studio/events` and
  `GET /studio/projects/:project/events`, which a browser holds open for as long
  as a project is on screen and which did not exist when that value was set. It
  never bit, because combined mode serves those routes under the 4h. A revived
  studio service would start reaping them at 30 minutes.

  **Most `TransferEncodingError`s in the log are NOT truncation we caused.**
  Measured over 6h of production `aai-server-web` logs (2026-08-05): 38 SSE
  stream completions, 40 of these errors, pairing 1:1 by timestamp — at every
  duration from 25s to 1375s, and continuing across a redeploy that shipped the
  registry above. Modal's `_proxy_http_request.send_response()` is still
  iterating the upstream body when the client goes away, and Modal never awaits
  that task ("Task exception was never retrieved"), so ONE lands in the log per
  abandoned stream. The browser is already gone when it fires. Two corollaries
  before treating a spike as a regression: **join it to Modal's request log
  first** — the `duration` on the completion line at the same second is the
  stream's whole lifetime, which is what separates a client abort (any
  duration, all of them multiples of `SSE_HEARTBEAT_MS`, because nothing in the
  chain notices a departed client until data flows) from a real deadline (a
  tight cluster at one value); and a rise in the count usually means a client is
  churning subscriptions, not that a stream was cut.

  **So the container COLLAPSES each one to a single line**
  (`install_proxy_noise_filter` in `scripts/modal_image.py`, installed at the
  top of `server()` in `modal_deploy.py`). Left whole they are the log's
  dominant content and they crowd out the thing you opened it for: across one
  60-minute production window they were ~600 of ~3,200 lines while the service
  served **zero 5xx** — and the window in question also held 13 failed
  container starts and a `crash-looping` line that took a targeted grep to
  find. The twenty-odd frames are Modal and aiohttp internals, identical every
  time and actionable never.

  **Collapsed, NOT dropped**, because the count and the timing are the entire
  diagnostic — the rule above is to join a RISE to the request log, and a
  deleted record makes that impossible. It stays a record on the `asyncio`
  logger, at the same level, carrying its exception type; only the traceback
  goes. It is also matched on TWO discriminators (the exception name **and**
  `_proxy_http_request` in the record), so it can never decay into swallowing
  asyncio errors: one of our own tasks dying the same way, or Modal's proxy
  task dying of anything else, still prints in full. `modal-image-inputs.test.ts`
  pins all three properties, which is worth the ceremony because every way this
  rots is silent and in the same direction — toward eating a traceback you
  needed, in a log nobody reads until an incident.

  **Capping the streams' own lifetime was considered and rejected.** It cannot
  reduce the above — a tab close still aborts whatever stream is open — while
  `projectPayload` carries `files: workspace.files`, so every forced recycle
  re-sends the whole workspace file map to every open tab. If a split studio
  service ever ships, raise its function timeout rather than adding a cap under
  it.

## Modal sandbox notes

- **Two backends, selected by `sandbox-backend.ts`.** Guest sandboxes are
  **remote Modal Sandboxes** (`modal-sandbox.ts`) in production and a plain
  **child process** (`subprocess-sandbox.ts`) in local dev. The policy is
  three rules: an explicit `SANDBOX_BACKEND` (`modal` | `subprocess`) always
  wins (unknown values throw — a silent fallback would look like the override
  not working); otherwise not-local-dev → `modal`, unconditionally; otherwise
  → `subprocess`. `isLocalDev` is false whenever `SUPABASE_STORAGE_BUCKET` is
  set, so **production can never resolve the host-local backend**, and fails
  loudly without `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (or a `~/.modal.toml`
  profile) rather than degrading. There is **no fallback between backends at
  spawn time**: a failed spawn is a failed spawn.
- **Every spawn failure is a `SandboxUnavailableError`** (`sandbox-errors.ts`)
  — both Modal spawners, both subprocess spawners. It is a marker class, not a
  message: the message stays the backend's technical one (`Modal sandbox spawn
  failed: Sandbox operation timed out`), and `createErrorHandler` turns the
  class into a **retryable 503** carrying one authored sentence
  (`SANDBOX_UNAVAILABLE_MESSAGE`), logged at `warn` with the full `cause`
  chain. Keeping the two apart is what lets the log stay specific while the
  wire body leaks nothing.

  The agent path always had this taxonomy — `brokerSessionUrl` answers 503 for
  any spawn failure — but the STUDIO path had none, so a Modal capacity
  timeout reached the shared handler as a bare `Error`: logged
  `Unhandled error on /studio/projects/<x>/session`, answered
  `500 Internal server error`. Both halves were wrong. The platform was not
  broken, and the studio client (which retries 5xx) left the user staring at
  "Internal server error" once its retries ran out, with no way to tell
  "try again in a minute" from "this project is broken". `SandboxNameTakenError`
  is deliberately NOT one of these — it is a routing signal the broker
  catches, never an answer to a client.
- **Two tiers, and deliberately no middle one.** A local-container backend
  (Apple's `container` CLI) sat between these and was removed. The reasoning
  is worth keeping, because "run a real container locally" keeps sounding
  like the obvious answer: it could never give production confidence — only
  `SANDBOX_BACKEND=modal` can, since that IS production — while it cost a
  second delivery mechanism for the in-guest build toolchain (Modal bakes one
  into its snapshot image; a local container needs an equivalent built and
  mounted) and invented failure modes that exist in no other environment. Two
  of those cost real debugging time: a linux guest cannot load the host's
  darwin-installed native binaries (vite/rolldown, lightningcss — everything
  *resolves*, then fails to *load*), and a loopback platform origin points at
  the guest's own harness rather than the dev server, so Publish 404s against
  itself. So: `subprocess` for fast iteration, `modal` when the question is
  "does this really work". A stale `SANDBOX_BACKEND=apple-container` throws
  at boot.
- **Subprocess backend (the local-dev default)** — `subprocess-sandbox.ts`
  runs the harness as a child process of the server on a loopback port. It
  has **no isolation at all**: tenant agent code, and the studio coding
  agent's `bash`/`run_code` tools, run with the server's uid, filesystem, and
  network. That is only acceptable because selection can never reach it in
  production, and boot says so unconditionally
  (`assertSandboxBackendOrWarn` logs the backend plus an isolation warning).
  It keeps the *shape* that catches integration bugs — a real OS process, the
  real `/ws` JSON-RPC control channel, real agent-mode file boots, real
  `/websocket` sessions, real dial-retry and orphan-timeout behavior — and it
  has no prerequisites, which is the whole point of it being the default.
  The harness binds **loopback** via `AAI_GUEST_HOST` (see
  `aai-guest/harness.ts`): with no network namespace around it, the auth-free
  `/websocket` would otherwise be exposed to the dev machine's network.
  In-guest builds resolve the toolchain through aai-guest's own
  `node_modules` — the same walk-up shape as `/opt/aai` in the baked image,
  with no cache to build. The shared harness lifecycle (exit fan-out,
  memoized cleanup, guest dial retry, stdio draining, loopback port
  allocation) lives in `warm-harness.ts`, used by both backends.
- The guest base image defaults to `node:26-slim`; pin via
  `MODAL_SANDBOX_IMAGE` for reproducible guests. `MODAL_APP_NAME` selects the
  Modal App sandboxes are created under (default `aai-server`).

  **Its major tracks the SERVICE image's** (`node:26-slim` in
  `scripts/modal_image.py`) **and `.node-version`.** The guest is the dev
  server (see `packages/aai-guest/CLAUDE.md`, "Dev/prod parity"), so a split
  major would mean the harness runs
  one runtime in production and another under `aai dev` — the asymmetry that
  section exists to enumerate, and one that no test can see because each side
  is internally consistent. The three move together; `@types/node` is the
  fourth, since it is what `tsc` checks every package and every studio
  workspace against — pinned two majors ahead of the runtime, it accepts APIs
  the deployed container does not have.

  Note the ceiling is a RANGE, not a pin: published `engines.node` stays
  `>=24` so SDK consumers on the previous LTS are not broken by a platform
  deploy, which is why bumping this image is not a package-visible change.
  **That split floor is what decides which Node 26 features may be used
  where, and `tsc` cannot enforce it.** The root tsconfig sets
  `lib: ["ESNext"]`, so every V8 14.6 addition — `Map.prototype.getOrInsert`
  / `getOrInsertComputed`, `Iterator.concat`, `Temporal` — type-checks in
  every package. In `aai-server` / `aai-guest` / `aai-studio-*` (`>=26`) that
  is accurate; in `aai`, `aai-ui`, `aai-cli` (`>=24`) it ships a
  `TypeError: … is not a function` to the consumer, having passed lint,
  typecheck, and a CI whose own Node is 26. `runtime-tools.ts` carries the
  worked example: `getOrInsertComputed` fits its state map exactly and is
  deliberately not used. Anything reachable from a published package needs a
  Node-24 floor check, not a type check. (`Iterator.concat` is doubly
  unavailable — TS 7.0.2's lib does not declare it yet.)

  Safe in every package, because they predate the 24 floor: `crypto.hash()`
  (21.7), `module.enableCompileCache()` (22.1, stable in 25.4),
  `await using` + `Symbol.asyncDispose` (20.4). `DisposableStack` /
  `AsyncDisposableStack` are NOT in that set — they are V8 globals Node does
  not document, so their availability on the floor is unverified; see the
  note in `studio-session-broker.ts`.

- **The harness, the build toolchain, and the V8 compile cache are baked into
  a snapshot image**, not written per spawn — with the toolchain LOCKED by a
  committed lockfile so one `harness_image_tag` can only ever mean one tree.
  That artifact is the guest's, so its construction, its two cache layers, and
  the split install (`npm ci` for third-party, `npm install` for
  `@alexkroman1/*`) are documented where it is owned: see "The snapshot image"
  in `packages/aai-guest/CLAUDE.md`. The host half — `modal-harness-image.ts`,
  the content-addressed tag, and per-deploy pinning via `harness_image_tag` —
  stays here.
- Sandboxes are created with open egress and a bounded lifetime
  (`SANDBOX_TIMEOUT_SECS`, default 4h).
- **Guest resources are a BURST RANGE: reserve the idle shape, cap the build
  shape.** `SANDBOX_MEMORY_MB` / `SANDBOX_CPU` reserve; `SANDBOX_MEMORY_LIMIT_MB`
  / `SANDBOX_CPU_LIMIT` cap. Modal constrains the pair from both sides — a bare
  cap fails sandbox creation ("must also specify cpu when cpuLimit is
  specified") and a reservation above its cap is rejected — so
  `parseSandboxLimitsFromEnv` reconciles them in one place and **throws on a
  cap with no reservation**, naming the env var, rather than letting the spawn
  die inside Modal on parameters the operator never set.

  They must stay two numbers, because a guest's load is bimodal: it idles as a
  voice session (~250 MB, a few % of a core) and spikes to ~1.7 GB across
  several cores for the seconds a `test_agent` or Publish build spends in the
  bundler. While the reservation was pinned equal to the cap, the two had to be
  ONE number and the affordable one won: 1 GiB / 1 core. That does not fit a
  build, and the failure is not an OOM — the guest wedges at its cgroup ceiling
  in permanent direct-reclaim, burning its core on back-to-back full GCs that
  can never free rolldown's **native Rust** allocations. Measured on a wedged
  production sandbox: RSS pinned flat at 1.29 GB, ~1 core split seven ways
  across 4 V8 GC workers + the main thread + 2 rolldown workers, **zero** I/O,
  453 CPU-seconds and no progress, versus 253 MB / 0.97 CPU-seconds on an idle
  sibling. It reads as a hung build.

  Two corollaries. **The cap is on the CGROUP, not the process** — so it takes
  out `test_agent` and Publish alike, and moving the bundler into a child
  process (as #845 did, reverted in #863) cannot escape it; the child's peak is
  charged to the same sandbox budget. And **`--max-old-space-size` cannot help**,
  because the memory is native, not V8's. The reservation is the idle
  voice-session shape; the cap only has to clear the bundler's peak.

  **The burst range is set in ONE place** — the guest-sandbox resources block
  in `aai-server/modal_deploy.py`, the only Modal app there is. Studio
  sandboxes (coding-agent sessions, Publish) are spawned by that same process
  and inherit it, which matters because their `test_agent`/Publish builds are
  the workload the cap exists for. (This said "BOTH Modal apps … keep the two
  blocks in lockstep" until the second one went with the split deployment.)
- **Every sandbox is tagged with a `role`** (`sandbox-role.ts`: `agent`,
  `preview`, `studio`, `studio-publish`) plus the `slug`
  (studio sandboxes carry the project name), so the Modal dashboard can tell
  a production voice agent from a preview deploy or a studio coding-agent
  session. Every spawn knows its identity at creation. Observability only: nothing
  may gate on these tags, and the `preview` role is inferred from the
  `-preview` slug suffix (`PREVIEW_SLUG_SUFFIX`, defined once in the SDK's
  slug contract — `aai/sdk/slug.ts`, reachable as `@alexkroman1/aai/utils` —
  because three independent things key off it and a disagreement is silent
  data loss: the deploy boundary rejects the suffix, the reaper deletes
  agents carrying it, and the CLI refuses to derive a project name ending in
  it. It lives in the SDK rather than aai-server because the CLI needs it and
  cannot import a private package).
- **The `-preview` opt-in is DECLARED by the caller, never inferred from the
  slug.** `deployAgentBundle` rejects a requested `*-preview` slug unless
  `allowPreviewSlug` is set, and only the studio's auto-preview deployer sets
  it — it targets `<project>-preview` on purpose. Publish shares the very same
  in-guest `aai deploy` invocation and must leave it unset. It used to ride on
  that shared invocation unconditionally, reasoned as "harmless for a
  production Publish, whose slug has no such suffix" — true only for
  server-minted project names. A CLI push derives the project name from the
  DIRECTORY, so a directory named `demo-preview` published straight through
  the guard and got an agent the hourly sweep would delete. Inferring the
  opt-in from the slug's shape would NOT have fixed it: a production Publish
  of such a project passes exactly that slug.
- **The guest snapshot image is resolved AT BOOT, not on the first spawn**
  (`prewarmModal(harnessPath)` in modal-context.ts, called from
  `assertSandboxBackendOrWarn`). Two memoized stages otherwise charged to
  whoever spawns first: the Modal app lookup (a gRPC round trip), and the
  harness image — reading the ~13 MB harness, the synchronous SHA-256 that
  forms its content-addressed tag, and resolving that tag. On a harness
  version nobody has published yet — i.e. right after EVERY deploy —
  "resolving" means BUILDING: toolchain layer, builder sandbox, 13 MB write,
  `snapshotFilesystem`, publish. That landed on one unlucky user's first
  voice session or studio chat. `createGuestSandbox` awaits the same memoized
  promise, so a spawn racing the prewarm joins it rather than starting a
  second build, and replicas racing each other are no worse than the
  concurrent cold spawns that raced before (the resolver tries
  `images.fromName(tag)` first). Fire-and-forget: a failure only warns and
  the memo resets, exactly as when the first spawn was the first caller.
- **Readiness is Modal's readiness PROBE**, not host-side polling
  (`GUEST_READINESS_PROBE` in modal-context.ts): every guest sandbox is
  created with `readinessProbe: Probe.withTcp(8080)` and the spawn awaits
  `sandbox.waitUntilReady()`. A TCP probe is exactly equivalent to the
  `/health` 200 it replaced, and that equivalence is a property of the
  harness's boot order rather than a guess: agent mode reads its boot files,
  hash-verifies and LOADS the bundle, and only then calls `server.listen` — so
  the port opening means "sessions can be served". A harness that listened
  first would report ready before it could serve anything. The wait is always
  raced against guest-process EXIT (`raceGuestExit` in warm-harness.ts): every
  boot failure exits the process with its reason on stderr, and without the
  race a readiness wait burns its whole budget and then blames the network.
  The host-side `pollGuestHealth` remains for the subprocess backend, which
  has no probes.

  **The probe INTERVAL is dead time on every spawn**, which is why it is 100ms
  and not Modal's more conversational default: the harness binds its port
  somewhere between two evaluations, so a spawn waits half an interval on
  average after the guest can already serve. The probe is a TCP connect to a
  listening localhost port inside an otherwise-idle container, so the interval
  buys nothing to offset that. It stops at 100ms rather than going lower
  because the probe's RESULT still crosses Modal's control plane to reach the
  host, and below ~100ms that propagation is what dominates. Was 250ms
  (~125ms average waste).
- **An agent spawn's steps are ordered by what they actually depend on**, not
  by the order they read in. Two of them are only incidentally sequential and
  must not be re-serialized (`modal-agent-sandbox.ts`):
  - The bundle write and the env write target different paths and neither
    reads the other, so they go together. Serialized, the tiny env write paid
    a full Modal round trip queued behind the ~8 MB bundle's.
  - `sb.tunnels()` needs nothing but the sandbox to exist, so it is issued
    BEFORE the writes rather than beside the exec that follows them — its
    round trip then runs inside the bundle write's window instead of after it.
    It is `.catch`-contained at the point it is issued, because the await is
    several statements away: a write that throws skips the await entirely, and
    a tunnel lookup rejecting afterwards would be an unhandled rejection —
    a failed spawn turning into a dead server process.

  Both are pinned by tests that fail against the serialized shape, which they
  have to be: the calls are ISSUED in the same order either way, so a
  `write, write, exec` transcript reads identically whether or not anything
  waited. The concurrency test asserts on writes in flight, not on sequence.
- **Transport**: STUDIO guests get a WebSocket control channel the
  host dials through the sandbox's Modal tunnel (`encryptedPorts: [8080]`;
  JSON-RPC on `/ws`) once the probe reports ready — the dial's retry
  (`GUEST_DIAL_TIMEOUT_MS`) stays as a backstop rather than the discovery
  mechanism. AGENT guests get NO channel — readiness is the probe, and the
  host probes `/manage/*` over plain HTTPS. Both are authenticated by a
  per-sandbox bearer token minted at
  spawn and delivered via the EXEC's env (never the sandbox's). The tunnel
  URL is public; the token is what keeps the managed surfaces from being an
  open door.
- **Nothing is region-pinned — not guest sandboxes, and not the services
  themselves. Capacity beats locality.** `MODAL_SANDBOX_REGION`
  (comma-separated for multiple) still pins SANDBOX placement via Modal's
  `regions` create param, but it is an operator override that production
  leaves unset; `build_image` (scripts/modal_image.py) deliberately bakes no
  value, and neither app's `@app.function` passes `region=`.

  The WEB service's pin (once `us-east-2`) was removed after it took
  production down, and it is worth knowing the shape because no symptom names
  a region: the app sits at `deployed` with **zero tasks** despite
  `MIN_CONTAINERS=1`, requests hang until the client times out having received
  **zero bytes**, and there are **no container logs at all** — not a crash,
  because no container is ever created, so `modal app logs` replays the last
  image build and then streams silence. Everything that normally localizes a
  fault says healthy: the image builds, the secrets resolve, and booting the
  entry by hand inside the function's own spec (`modal shell <file>::server
  -c 'node …'`) serves fine. Neither a redeploy nor `modal app rollover`
  helps — both only re-ask for a container that still cannot be placed. A
  warm floor is what makes a pin dangerous, so if a measurement ever justifies
  re-pinning, prefer Modal's region LIST (a fallback order) over one value.

  It used to be exported as `MODAL_SANDBOX_REGION` too, so every guest was
  confined to one region's spare capacity. The failure that buys is a spawn
  Modal cannot schedule inside the ~50s `sandbox.tunnels()` waits, surfacing
  as `SandboxTimeoutError: Sandbox operation timed out` — the whole session
  fails, and the more regions are available the less often it happens.

  The locality it bought was narrower than the original note claimed
  ("every host↔guest exchange paid a transatlantic RTT inside voice turns",
  after an unpinned server in us-east-1/AWS met guests in uk-london-1/OCI).
  AGENT guests have no host channel at all — voice clients dial the sandbox
  tunnel directly, so a voice turn crosses that hop **zero** times. Only the
  studio's control-channel RPCs pay it, outside any latency budget. Re-pin
  per environment if that ever stops being true; don't re-bake it into the
  shared image.
- **Orphan cleanup differs per mode.** STUDIO guests: the host's
  WebSocket IS the liveness signal — a host that dies without teardown
  drops its sockets, and the harness self-exits after
  `HARNESS_ORPHAN_TIMEOUT_MS` with no host connected (constants in
  `aai-guest/limits.ts`; the window also covers the boot gap before the
  first dial). AGENT guests have no host socket, so they own their own
  lifecycle instead: self-exit after `AGENT_IDLE_EXIT_MS` with zero
  sessions (see `packages/aai-guest/CLAUDE.md`). Either way, once the exec has
  exited, Modal's `idleTimeoutMs` (`SANDBOX_IDLE_TIMEOUT_SECS`, default
  15 min) terminates the sandbox. These are backstops, not the normal
  path: Modal delivers stop signals to the container's **Python** runtime,
  never to a bare `subprocess.Popen` child, so `run_node`
  (scripts/modal_image.py) forwards SIGTERM/SIGINT to the node process and
  waits — that is the only reason `teardownSandboxes` (retire agent guests,
  dispose the studio broker) runs on scale-in/redeploy at all.
  There is NO host-side idle eviction: the guest owns idleness (agent-mode
  self-exit; the studio broker keeps its own per-project idle sweep), and a
  guest exit detaches its slot via `onSandboxLost`.
- The server itself deploys to Modal too (`modal_deploy.py`,
  `pnpm --filter aai-server deploy:modal`) — there is no Docker image or
  Fly.io deployment anymore.

## The platform stores no agent config

**The deploy boundary learns NOTHING about a bundle.** No config is
extracted, validated, or stored, and no name is taken either: `POST /deploy`
takes artifacts (worker, client files, env) and ownership (the caller's key),
and that is the whole of it. A slugless deploy is named `human-id` words plus
a random suffix; a caller who wants a readable URL requests the slug. The
bundle describes itself to its own SDK inside its own sandbox, and nowhere
else.

**What this replaced, and why it went.** A deploy used to spawn a THROWAWAY
guest sandbox per call (`describeBundle`, the guest's one-shot describe mode)
to load the bundle and read its `__aaiConfig` self-description, defended by a
per-exec nonce so a bundle's own `process.on("exit")` handler could not forge
the answer. That was load-bearing when the host interpreted a stored config:
platform host mode ran sessions through the server's own `createRuntime`, and
the broker read name/greeting off the row. Both went away — host mode is
deleted, `/client-config` is proxied from the guest — and the extraction
outlived its consumers, because the changes that removed them had no reason to
revisit it. By the end the stored `config` column was write-only and the
extracted value decided exactly two things: a default slug and a warning.
Both are better served elsewhere — the warning by the CLI, the slug by the
word generator that already backed every unusable base.

So the sandbox spawn, the describe mode, the nonce protocol, the `inspect`
role, `IsolateConfigSchema` and — since
`20260810030000_drop_agents_config.sql` — the COLUMN are all gone.

**The `RETIRED_COLUMNS` ledger in `platform-schema.test.ts` is what carried
that last step, and it is EMPTY now — which is the goal state, not a reason
to delete the mechanism.** A contract migration cannot ride the same release
as its expand (`supabase db push` runs before the deploy and old containers
keep serving through the rollout, so a drop beside its own expand fails every
deploy that reaches one), so the drop is owed to a LATER release and an owed
thing recorded only in prose is an owed thing forgotten. Each entry asserts
two things: that no platform source writes the column, and that the column is
STILL declared — so the entry has to be deleted in the same commit as the
drop, which is exactly how this one cleared. Put the next such column there.
Three consequences worth knowing:

- **The credential preflight moved to the CLI** (`aai-cli/_preflight.ts`).
  It is the same derivation — `requiredProviderEnvVars` over the provider
  descriptors, plus the agent's declared `requiredEnv` — run where the config
  is authored. It WARNS rather than rejecting, and that is not a softening
  for its own sake: the CLI sees the env it is uploading but not what is
  already stored against the slug from an earlier `aai secret put`, so a
  rejection could block a deploy that would have worked. Studio Publish runs
  the same CLI in-guest, so it inherits the check.
- **The import smoke test moved with it.** `aai deploy` imports the worker it
  just built, so a bundle whose top level throws fails in the project
  directory rather than as a sandbox that never becomes ready. This is why
  the deploy path now evaluates the built bundle locally — see the note in
  `packages/aai-cli/CLAUDE.md`.
- **A client-sent config is still ignored, and now there is nothing to
  poison.** `DeployBodySchema` has no field for one, and none for a name
  either — a client cannot influence a generated slug at all, so there is no
  advisory-input surface to reason about.

**Re-adding a host-side view of what an agent is means re-adding trusted
extraction.** Nothing in the platform can answer "which providers does this
agent use" any more, so a future quota, provider block, or agents list needs
that decided first. If it is only a NAME that is wanted, note the asymmetry:
adding a column is easy, backfilling one is not — existing agents would carry
nothing until redeployed.

## Security architecture

### Modal sandbox isolation

Each agent runs in its own **Modal Sandbox** — a remote, isolated container
on Modal's infrastructure (`modal-sandbox.ts`). The guest runs a Node
process executing the bundled agent code (`aai-guest/harness.ts`) — the
COMPLETE agent: the runtime ships INSIDE the worker bundle (see
`packages/aai-guest/CLAUDE.md`, "User-shipped runtime" — the harness embeds
none), and client sessions
connect directly to the sandbox's public `/session` tunnel endpoint.
Host↔guest control traffic is JSON-RPC over a WebSocket the host dials
through the same tunnel (`/ws`), authenticated by a per-sandbox bearer
token.

**In production.** Local dev defaults to the `subprocess` backend, which has
**none** of the properties described below — the harness is a child process
of the server, sharing its uid, filesystem, and network — see "Modal sandbox
notes". Selection (`sandbox-backend.ts`) makes it unreachable outside local
dev: any environment with `SUPABASE_STORAGE_BUCKET` set resolves `modal`
unconditionally. When reasoning about the security model, the backend is the
first thing to establish, and the boot log names it (with a warning when
there is no boundary at all).

Key properties:

- **Remote isolation**: each sandbox is its own container on Modal — no
  shared kernel surface with the platform host, no shared state between
  agents. The container is the security boundary; the guest runs plain Node
  (no language-runtime permission model).
- **Open egress**: the container is the isolation boundary — a tenant can
  reach the internet, not the platform. Tool code, `ctx.generate`, and
  provider streams dial out from the guest directly (identical to
  `aai dev`); `ctx.db` connects directly on the app's OWN scoped role
  (`DATABASE_URL` in the agent's boot env) — platform ADMIN database
  credentials never enter the guest.
- **Minimal filesystem**: the guest sees the baked harness image — never
  the host filesystem.
- **Resource limits**: Modal per-sandbox memory/CPU caps
  (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) and a bounded lifetime
  (`SANDBOX_TIMEOUT_SECS`, default 4h).
- **Sessions live in the guest**: the embedded runtime owns per-session
  state (`ctx.state`, history, the resume grace window) exactly as the
  self-hosted runtime does. The host holds no session state.

Key files: `sandbox.ts`, `sandbox-vm.ts`, `modal-sandbox.ts`,
`aai-guest/harness.ts`, `rpc-transport.ts`. A deployed agent's env is
delivered as a boot FILE written into its own sandbox (scrubbed after
reading); per-sandbox tokens ride the exec env, and platform secrets stay
host-side.

**Credential separation:**

Each agent provides its own `ASSEMBLYAI_API_KEY` via `.env` (local dev) or
`aai secret put` (production). There is no central/platform-owned key.
`SandboxOptions` has separate `apiKey` (host-only, for S2S connections) and
`agentEnv` (forwarded to guest) fields. The key is extracted from the agent's
stored env at sandbox creation time and kept host-side only.

- **App database**: per-app Postgres role/schema credentials are
  platform-provisioned and held in Supabase Vault. When storage is enabled
  they reach the guest as `DATABASE_URL` in the boot-delivered agent env —
  the app's
  OWN scoped role (search_path pinned, statement_timeout, connection
  limit), never a platform admin credential; it reaches only data the
  tenant's code could read anyway, and matches what `aai dev` puts in
  `ctx.env` via the project `.env`.
- **Agent secrets**: stored in Supabase Vault (`agent-env:<slug>`), not
  encrypted blobs — the old master-key envelope encryption
  (`KV_SCOPE_SECRET`) is gone.
- **Credential resolution reads the agent env only — never `process.env`.**
  The platform host process holds its own credentials under exactly the names a
  tenant descriptor could resolve (`AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` for Supabase storage), so a fallback would let an
  agent that supplied no credential of its own silently borrow the
  platform's.

  There are **two** such helpers and both must stay sealed — closing only one
  leaves the leak open, since between them they cover every provider:
  - `resolveApiKey` (`providers/resolve.ts`) — descriptor-declared env keys.
  - `requireApiKey` (`providers/_utils.ts`) — every STT/TTS opener and every
    LLM (via `resolve.ts`'s `requireKey`).

  Self-hosted runs opt into shell-exported keys via
  `withHostCredentialFallback` (`providers/host-env.ts`), which copies only
  `PROVIDER_CREDENTIAL_ENVS` (derived from the provider registries). It feeds
  `RuntimeOptions.providerEnv`, **not** `env` — credentials must not land in
  `ctx.env`, both so agent code can't read them and so dev keeps parity with
  production in what `ctx.env` contains.

  The providerEnv-not-env rule is **type-enforced** via the branded env
  records in `sdk/env-types.ts`: `withHostCredentialFallback` is the only
  minter of `HostCredentialEnv`, which satisfies
  `RuntimeOptions.providerEnv` (`ProviderEnv`) but is a compile error for
  `RuntimeOptions.env` (`AgentEnv`) and everything else that becomes
  `ctx.env`. Plain records stay assignable to both, so only the dangerous
  flow needs ceremony; `env-types.test-d.ts` locks the assignability matrix.
  The brand is advisory against *deliberate* re-annotation — the point is
  that leaking host credentials into `ctx.env` can no longer be silent.

**Cross-agent isolation:**

- App databases are separate Postgres schemas with per-app login roles —
  agents cannot access each other's data.
- Each sandbox communicates over its own authenticated WebSocket.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

**`run_code`**: executes only inside the guest sandbox — see "The
`run_code` executor" in `packages/aai-guest/CLAUDE.md` for its authority
and why there is no in-process capability stripping.

**SSRF protection**: `aai/host/ssrf.ts` — the SDK owns it, and so does its
guide. The screening policy (why a CONTAINED guest is not screened), the
bypass classes covered, and the two undici-version traps in the pinned
dispatcher are in `packages/aai/CLAUDE.md`, "Guest network access".

**Auth:**

- **A raw bearer is VERIFIED against AssemblyAI before it means anything**
  (`api-key-verify.ts`, called from `resolveBearer`). This is the platform's
  only ABSOLUTE authentication check; everything else is relative.
  `verifySlugOwner` asks whether a bearer matches a hash on one agent's row —
  a real authorization check that says nothing about whether the bearer is a
  credential at all — and the routes IN FRONT of ownership have no row to
  check against: `POST /deploy` claims an unclaimed slug for whoever asks,
  and the studio's project-create and session-broker key their scope off the
  bearer itself and spawn a Modal sandbox per call. All three were reachable
  with `Authorization: Bearer <anything>`; an audit deployed 25 agents under
  25 junk strings.

  Four properties, each of which is a way to write this so it looks correct
  and is not:
  - **Ambiguity is never "valid".** Only 401/403 means "not a key". A 5xx,
    timeout, DNS failure or proxy error THROWS, and the caller answers 503.
    Fail-open ("don't let an AssemblyAI outage take us down") reopens the
    whole hole for the duration of any outage an attacker can provoke or
    wait for. `supabase-auth.ts` draws the same line for sessions.
  - **Negatives are cached**, or one unauthenticated request becomes one
    upstream request — a traffic amplifier pointed at AssemblyAI.
  - **The verifier is ABSENT in local dev and tests** (`isLocalDev`, plus an
    explicit `AAI_VERIFY_API_KEYS=0`), and present otherwise — so a
    production boot that merely forgot a variable gets verification, not a
    hole. The endpoint is `AAI_KEY_VERIFY_URL`-overridable.
  - **The browser path is verified at STORAGE, not per request**
    (`PUT /studio/account/key`): a session never presents a key, so the
    stored string would otherwise skip the check and then BE the credential
    for every deploy and ownership hash the account makes.
- **Two bearer forms, one resolution point** (`resolveBearer` in
  `middleware.ts`). Raw API keys (the `aai` CLI, and the in-guest
  `aai deploy` Publish runs) pass through unchanged. JWT-shaped bearers —
  browser studio sessions — are verified against the auth backend and
  mapped to the user's stored AssemblyAI key (`user-key:<uid>` in the
  SecretStore), so every downstream consumer (ownership hashes, the
  gateway LLM, deploy env seeding) sees the real key either way. A key
  never contains dots, so the shape test (`isJwtShaped`) cleanly splits
  the two; the verification boundary is the backend's answer, never the
  shape. Raw keys additionally resolve a `userId` when some account owns
  the key — the `key-user:<sha256(key)>` reverse mapping, TTL-cached
  (negatives included) beside the user→key cache — which lands a linked CLI
  in the same studio scope as the browser session; an unmapped key keeps the
  key-derived scope.

  **TWO routes write that mapping, and the second one is the reason a login
  can be trusted.** `PUT /studio/account/key` writes it on key onboarding and
  rotation, and `POST /studio/cli-link/approve` BACKFILLS it. The onboarding
  write only covers keys stored since it existed, and there is no other way
  for an account to acquire a mapping than to re-save the same key — so an
  account onboarded earlier linked SUCCESSFULLY (`aai login` printed
  `Linked <email>`) and then landed in the key-derived scope, where
  `aai list` is empty and `aai pull <project>` reports "No studio project
  named …" for a project the browser is showing. Nothing on either side named
  the cause: both scopes are internally consistent, so every request
  succeeded. The approval is the one point holding the account and the key a
  CLI is about to authenticate with at once, which is what makes it the place
  to heal it; it writes before storing the grant, so the CLI cannot exchange
  and get a request in ahead of the mapping.

  **Neither route may REBIND a key another account holds.** This mapping
  decides which studio scope a raw-key caller lands in, so whoever writes it
  decides where that CLI pushes. Last-writer-wins was documented as benign
  for a shared team key, and it is — right up until the second writer is not
  a teammate: someone who learns Alice's key signs in as themselves, binds
  it, and from then on Alice's CLI resolves into THEIR scope, so `aai push`
  writes Alice's source into their workspace. It is silent by construction —
  both scopes stay internally consistent, so every request on both sides
  succeeds, the same failure shape as the bug the backfill above exists to
  cure. The onboarding PUT now 409s on a foreign owner; the approval
  backfill leaves a foreign mapping alone and links anyway (refusing would
  strand exactly the legacy accounts it exists to heal). Same-uid re-saves
  stay idempotent, so rotation is unaffected.
- **Browser sessions are Supabase Auth** (`supabase-auth.ts`): GitHub
  OAuth sign-in via supabase-js (`signInWithOAuth`) in the studio client.
  The server verifies access tokens **two ways, and which one a route gets is
  a security decision**:
  - `verifyAccessToken` — the request path. `getClaims` (`@supabase/auth-js`),
    which on a project using ASYMMETRIC JWT signing keys verifies the
    signature locally against a process-cached JWKS and touches the network
    not at all. Supabase's own guidance is to "prefer `getClaims` over
    `getUser`, which always sends a request to the Auth server for each JWT",
    and `GET /auth/v1/user` per token is what this replaced.
  - `verifyAccessTokenFresh` — `GET /auth/v1/user`, uncached, used ONLY by
    `requireStudioUser` (the three account routes). A signature check is
    authoritative about who issued a token and when it expires and blind to
    REVOCATION: a signed-out session stays cryptographically valid until
    `exp`. Those routes read and rotate the account's AssemblyAI key and grant
    a CLI one exchange for it, so they pay a round trip to see a sign-out at
    once.

  Two properties worth keeping. `getClaims` is safe on either kind of project
  — on a symmetric (HS256) one it falls back to a server call by itself — and
  that is also why the request path KEEPS its short TTL cache: on such a
  project the cache is what stops a per-request round trip. **That cache entry
  is capped at the token's own `exp`**, because `getClaims` validates expiry
  only on a MISS — a flat TTL kept serving a token that expired 59 seconds
  ago, making the bound the SUM of the two rather than the minimum. A
  rejection keeps the flat TTL; there is no `exp` to read from a token that
  did not verify. And a rejected
  token and an unreachable Supabase are opposite answers, so only
  `isAuthRetryableFetchError` throws (a 5xx to the caller); everything else
  caches as a rejection. `storageKey` is set explicitly because auth-js caches
  the JWKS in a PROCESS-GLOBAL map keyed by it rather than by URL — two
  clients pointed at different projects would otherwise verify one project's
  tokens against the other's keys.

  Configured by
  `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`. Local dev (same `isLocalDev`
  policy as the in-memory stores — production can never resolve it) falls
  back to `createDevAuth`: the login screen mints self-describing
  `dev.<base64url({id,email})>.dev` tokens, so `pnpm dev:aai-server`
  needs no Supabase project while exercising the same middleware. The
  studio's account surface (`GET /studio/auth`, `GET /studio/account`,
  `PUT /studio/account/key`) authenticates the session WITHOUT requiring
  a stored key — it is how the key gets set, as the mandatory onboarding
  screen after sign-in.
- **`aai login` never signs in and can never create an account** — it
  LINKS an account that is already signed in to the browser studio
  (device-link flow): the CLI mints an unguessable one-shot code, opens
  `<server>/?cli-link=<code>`, and polls
  `POST /studio/cli-link/exchange`; the signed-in (and key-onboarded)
  browser session approves via `POST /studio/cli-link/approve`, which
  grants that code ONE exchange for the account's stored API key. Grants
  live in the SecretStore under the code's hash
  (`cliLinkSecretName`), expire in 10 minutes, and are deleted on first
  read. There is no `GET /studio/account/key` route anymore — the exchange
  is the only way a raw key leaves the platform, and only to the terminal
  that minted the code.
- **Every AssemblyAI key on the platform is user-provided** — there is no
  platform-owned key, and with browser sessions the browser never holds
  one either: the key lives server-side against the account (Vault) and
  the browser holds only a revocable ~1h session token.
- API key ownership hashes are plain SHA-256 digests (`sha256:<hex>` in
  `secrets.ts`) — slug ownership is verified against stored credential
  digests, constant-time compared. NOT a password hash on purpose: platform
  keys are high-entropy machine secrets, so the argon2id stack this
  replaced (native dependency, TTL verify cache, lazy-hash choreography to
  dodge ~100ms derivations) was cost without a threat model. There are no
  legacy hash/decrypt fallbacks (nothing predating the current scheme was
  ever deployed).
- Stored credentials (agent env vars / secrets) live in Supabase Vault,
  which encrypts at rest — there is deliberately no app-layer encryption
  on top.
- Deploys go through the single `POST /deploy` route (slug in the body);
  the legacy `POST /:slug/deploy` route was removed.
- Deploys check slug ownership whether the slug was requested or generated —
  a generated-slug collision returns 409 rather than overwriting an existing
  agent and appending the caller's credential hash to it.
- **Server-generated names come from one generator**
  (`aai-server/slug-generate.ts`): a readable base plus a random lowercase
  base36 suffix, v0-style (`contact-form-x7k2mq`). Only STUDIO project
  creation supplies a base, from the creating chat prompt
  (`projectBaseFromPrompt`); a slugless CLI deploy supplies none and gets
  `human-id` words, because the platform holds no description of the bundle
  to name one after (see "The platform stores no agent config"). A CLI caller
  who wants their agent's name in the URL requests the slug. Clients never
  generate names — creation always hits the server.

  **How a human name is REDUCED to the grammar is a separate, shared thing**
  (`slugifyName`, `@alexkroman1/aai/slugify`) and does not live here. This
  file used to own it as `slugifyBase`, which put it out of the CLI's reach —
  the CLI must not import a private package — so `projectNameFromDir` grew a
  hand-rolled `[^a-z0-9-_]` strip instead, and the two disagreed on the names
  people actually give agents: a `Café Ordering` directory pushed as
  `caf-ordering` while the studio's own field made `cafe-ordering`. Generation
  stays here (it needs `human-id` and the suffix format); normalization is in
  the SDK because all three sides need it.

### The image is layered dependencies-first (`scripts/modal_image.py`)

The service image installs, then builds, and the two halves have deliberately
different cache keys:

1. **Install inputs only** — the lockfile, `pnpm-workspace.yaml`, `.npmrc`,
   and every workspace manifest, staged into a temp dir by
   `_stage_install_inputs`.
2. `pnpm install --frozen-lockfile`.
3. **The source tree** (`add_local_dir(REPO_ROOT, …)`), which merges into the
   installed `/app` rather than replacing it — `BUILD_IGNORE` keeps
   `node_modules` out of the copy. `ASSERT_INSTALL_SURVIVED` runs before the
   build so that assumption fails as one sentence at image build, not as a
   missing module twelve steps later.
4. `BUILD_COMMAND`.

It used to be one `add_local_dir` for the whole repo followed by install and
build in a single step, so **any** file change — a test, a doc — invalidated
the install and refetched the entire dependency tree. The win is not deploy
latency (`modal deploy` builds before any traffic moves, and under Modal's
rolling strategy the old containers serve throughout); it is the **cold
start**, where a container on a worker that already holds the install layer
pulls only what changed.

**Everything in the recipe must be IMPORTABLE without the repo present, and
that is not a style rule — it is the difference between a deploy and a
crash-loop.** Modal re-imports the deploy script inside every container to
hydrate the function, so `build_image` runs a second time where the repo does
not exist and `REPO_ROOT` (derived from `__file__`, mounted at `/root/`)
resolves to `/`. Modal's own `Image` builder calls are LAZY, so naming
`REPO_ROOT` in one is fine; computing an argument to one by reading the
filesystem is not. `_stage_install_inputs` did, and the container died at
import with `FileNotFoundError: '/pnpm-lock.yaml'` — it is guarded on
`modal.is_local()` now, returning an empty staging dir off-host.

**Every signal a deploy has is blind to that failure**, which is why it ran for
hours: `modal deploy` exits 0, the image builds, CI goes green, the app reads
`deployed`, and — because the rolling strategy keeps the PREVIOUS deploy's
containers serving — the health endpoint answers 200 and the request log stays
clean. What actually shipped was a service that could not scale out or replace
a container, one container-death away from an outage with no recovery path.
Observed 2026-08-09: 13 failed container starts over four minutes, production
served for the next two hours by a container that predated the deploy, and the
only trace was a `Function modal_deploy.server is crash-looping` line in an app
log nobody was reading. Hence two guards, at different distances:
`modal-image-inputs.test.ts` pins the `is_local` short-circuit statically (a
gate that fails in the ordinary test run), and **`deploy.yml`'s verify step**
(`scripts/verify_modal_deploy.py`) asserts after every deploy that a container
started AFTER the deploy began and that the service answers — the general net,
since it catches any startup failure rather than this one. Checking health
alone would not have caught it; the stale container was answering fine.

**The manifests are NORMALIZED, and without that the split would be pure
ceremony.** A layer's cache key is the bytes that go into it, and a
package.json's `version` moves on every changeset release — which is exactly
and only when a deploy happens (`deploy.yml` fires on a version bump). Copied
verbatim, the install layer would therefore miss on every production deploy.
`INSTALL_MANIFEST_FIELDS` is a whitelist of the fields install actually reads;
`version` and `scripts` are dropped, so the layer survives a release and
misses only on a real dependency change. The full manifests still land in the
source layer, so the built image carries each package's true version.

**The image also bakes the SERVER's V8 compile cache**, the same trick the
guest snapshot bakes for the harness. After `BUILD_COMMAND`, a build step runs
the built entry once in warm-up mode (`AAI_SERVER_WARMUP=1`, honored at the top
of `aai-studio-server/index.ts` — it evaluates the module graph and exits 0,
opening no port, socket, or database connection) under `NODE_COMPILE_CACHE`,
and the resulting `/app/.compile-cache` ships in the layer; `.env()` points the
container's node at the same directory, which is the half that is silent when
it drifts — a warmed cache nothing consults costs exactly what no cache costs.
Measured on the built bundle: **~600ms → ~395ms**, i.e. ~200ms off every cold
start, for ~3.6 MB in the image. Unlike the harness's warm-up this one is
deliberately FATAL to the build: it runs the real entry, so a non-zero exit
means the artifact production is about to run cannot be evaluated at all.
`modal-image-inputs.test.ts` pins the three things that must agree (entry path,
flag name, cache directory) across the recipe and the entry.

Dropping `version` is safe **because every workspace dependency here is
`workspace:*`**, which matches any version. A `workspace:^` anywhere would
silently break that, so `modal-image-inputs.test.ts` asserts it — along with
the two other ways this drifts: a workspace glob added to
`pnpm-workspace.yaml` but not to `WORKSPACE_MANIFEST_GLOBS`, and a manifest
that grows a dependency-declaring field (`overrides`, `resolutions`,
`optionalDependencies`) the whitelist does not carry. The first fails loudly
at image build as a lockfile mismatch; the second does **not** — the install
succeeds and merely resolves a different tree than the source layer expects,
which is why it needs a test rather than a comment.

### The guest fetches its own bundle (signed Storage URL)

A cold agent spawn no longer moves the worker bundle through this process at
all: the guest fetches it from a time-boxed signed Storage URL
(`BlobStorage.signedUrl` → `BundleStore.getWorkerUrl` → `WorkerSource` in
`sandbox-vm.ts` → `AAI_BUNDLE_URL` in the exec env), and hash-verifies what it
gets against the agents row's `worker_hash`.

The host-side pieces above live here. The BOOT contract — why the hash is the
whole security argument, why `signedUrl` resolving `null` means "this backend
cannot sign" rather than "signing failed", and why a pinned older guest is
checked with `guestUnderstandsBundleUrl` before being handed a URL it cannot
read — is documented with the guest: see "Fetching its own bundle" in
`packages/aai-guest/CLAUDE.md`.

### The workflow API is brokered too — `/:slug/workflows/*`

The SECOND routing point (`workflow-handler.ts`, shaped like
`client-config-handler.ts`: broker the sandbox, then forward). It exists because
a STATIC agent's page is served HERE at `GET /:slug/` and reaches the durable
workflow API through `createWorkflowApi()`, which builds every URL from
`location` — no broker step of the kind a voice session gets from
`/client-config`. So they land on the platform, which had no route and answered
`{"error":"Not found"}` to every upload from a deployed `transcription-desk`
(`GUEST_ROUTES.workflows` claimed the opposite; its comment now records why).
The handler's doc comment has the rest; two things to know here: bodies
**stream** rather than buffer (`DEPLOY_BODY_CONCURRENCY` exists because the
deploy path does not, and a blob upload is this API's whole point), and the
guest's error body passes through unchanged, since that text is what the page
renders.

### Telephony — `GET/POST /:slug/phone`

A carrier points a phone number at this route; it brokers the agent's sandbox
and answers with the markup that tells the carrier to open a media stream
against that sandbox's own `/phone` endpoint. From there the carrier talks to
the guest directly and the platform is out of the path, exactly as it is for
browser sessions. The guest half — the bridge, the codecs, the resampling — is
the SDK's: see "Telephony" in `packages/aai/CLAUDE.md`.

**Why this route exists rather than pointing the carrier at
`/:slug/websocket`.** That endpoint answers a plain upgrade with a 302 to the
live sandbox (`orchestrator-ws.ts`), and carriers do not follow WebSocket
handshake redirects — the call would connect to nothing. TwiML is an
indirection the carrier DOES follow, so the redirect problem does not need
solving: the markup carries the resolved sandbox URL, and the sandbox a call
lands on is always the current one. Telnyx's TeXML accepts the same verbs, so
one document shape serves both.

**Cold start is answered with MARKUP, not with a held request.** A carrier
times out a webhook in ~15s, which is under a cold sandbox's boot budget, so
waiting for the boot inside the request is not available — the per-attempt
readiness budget is `PHONE_READY_TIMEOUT_MS` (8s), well inside it. A
still-booting agent gets `<Pause>` + `<Redirect>` back here instead; the boot
continues server-side and the next attempt joins the same readiness promise
(see `BROKER_READY_TIMEOUT_MS`). A browser client gets this for free by
re-brokering, and a phone call has no such loop — so the loop is written into
the response, bounded so a permanently broken agent hangs up instead of
looping until the caller does.

**Webhook verification is enabled by the AGENT'S OWN SECRET, not by a flag.**
An agent whose stored env holds `TWILIO_AUTH_TOKEN` (HMAC-SHA1 over the URL
plus sorted params) or `TELNYX_PUBLIC_KEY` (Ed25519 over `timestamp|body`,
with a freshness bound — without one a captured request is valid forever) has
every request checked; an agent that has set neither is left exactly as open
as `/client-config` and `/websocket` beside it, which is the posture every
public agent route already has. Two defaults were available and the
alternatives are worse: refusing unsigned requests unconditionally means a
phone number that 403s until the operator finds a doc page, and demanding the
secret up front puts a credential in the way of trying the feature. What
setting it buys is real — without it, anyone who learns a slug can drive
sandbox boots and provider spend by POSTing here.

**The signed URL is the PUBLIC one.** Twilio signs the URL it built the
request from, which behind Modal's TLS termination is never `c.req.url` — the
handler composes it from `resolvePublicOrigin`, for the same reason everything
else on this platform does (see "Never derive the public scheme from the
request URL").

### No warm pool — every spawn boots from the snapshot image

There is NO warm sandbox pool (`sandbox-pool.ts`, `SANDBOX_POOL_SIZE`, the
`pool` role, and the `setTags` retag plumbing were all deleted). Production
always ran with the pool disabled, so it was pure complexity: every spawn —
agent, studio — now boots directly from the published
content-addressed harness snapshot image, one code path per backend, and
every sandbox knows its identity (role/slug tags) at creation. When Modal's
JS SDK exposes sandbox MEMORY snapshots (today it exposes only
`snapshotFilesystem`; memory snapshots are Python-SDK experimental),
restore-from-snapshot slots into this single spawn path — do NOT
reintroduce a host-managed pool to approximate it.

### No horizontal sandbox scaling — one sandbox per slug, FLEET-WIDE

Per-slug horizontal scaling (`sandbox-scale.ts`: session caps, overflow
replicas, least-connections routing over guest-reported counts) stays
DELETED: a slug has ONE resident sandbox, and the broker
(`GET /:slug/client-config` → `resolveSandbox`) either serves it or
rebuilds it. A single guest handles many concurrent voice sessions before
that matters. Git history has the full design if per-slug scaling ever
needs to come back — the one constraint that survives any reintroduction:
sessions dial the sandbox directly, so the guest-reported session count is
the only honest load signal, and the broker is the only routing point.

**"One" means fleet-wide, not per replica — and MODAL enforces it**
(`sandbox-directory.ts`). The slot cache is per-replica and the web service
autoscales, so for a while each replica spawned its own guest for the same
slug. That is not an edge case — Modal load-balances every request
independently, so a page load and the project switch a minute later
routinely land on different replicas.

A guest sandbox's fleet-wide identity is its Modal **name**
(`agent-<hash(slug)>-v<version>`): `sandboxes.create` throws
`AlreadyExistsError` when the name is taken, and `sandboxes.fromName` returns
only a RUNNING sandbox. So a COLD broker (no local resident) asks Modal
whether some replica is already serving this deploy and routes to that
guest's tunnel — sessions dial the guest directly, so a peer's URL serves a
client exactly as well as a local one.

This replaced `aai_platform.sandbox_registry`, a lease table the owning
replica heartbeated every 10s. What went with it: the heartbeat timer and its
per-tick ownership re-check (which existed so every detach path — retire,
terminate, idle self-exit, lost guest, blue-green handover — converged on an
unregister without knowing the registry existed), the pg_cron sweep for
crashed replicas' rows, `replicaId` on the agent path, and the accepted
**stale-lease window**: the old design could hand out a dead peer URL for up
to one lease after a crash, and a retired sandbox's URL for up to one
heartbeat. A name is released when the sandbox stops, so `fromName` cannot
return something that is not running.

Three properties worth keeping:

- **The name carries the deploy VERSION.** A blue-green handover
  (`handoverSlot`) boots the replacement while the old resident drains, so a
  slug legitimately has two live sandboxes for minutes and a version-less
  name would collide. It also makes the peer lookup version-EXACT — the lease
  table could hand out a guest running superseded code until the owner's
  heartbeat stopped.
- **The peer route is gated on the agents row still existing.** A deleted
  agent's sandbox can still be running (retirement drains it for minutes),
  and routing to it would resurrect a 404. The same `getAgentVersion` read
  serves as both that gate and half the name.
- **Losing the name race routes to the winner** (`awaitBrokeredUrl`). A
  create that lost is the ONE remaining path to a duplicate; it comes back as
  `SandboxNameTakenError`, and the broker returns to the directory rather than
  retrying a spawn that can only lose again.

The directory is read at the broker, NOT subscribed to: it only matters at
the moment a cold broker runs. A change stream would be a second mechanism
answering the same question — the duplication rule that shaped
`watchAgentInvalidation`.

### No host mode on deployed agents

Host mode (`?host=1` — the caller supplies `systemPrompt`, `greeting`, and
relayed tool schemas while the session runs on the operator's credentials) is
an **`aai dev` feature only**. The platform version (`ws-host-mode.ts`,
owner-authenticated via bearer on the upgrade) was deliberately removed: it
was the one path where the SERVER'S current SDK interpreted a STORED config
(`toRuntimeAgent` → the server's `createRuntime`) — a cross-version seam that
could break already-deployed bundles, and the reason the server carried a
config→runtime-agent mapping at all. Every platform session now runs the
bundle's own frozen SDK inside its sandbox; `/:slug/websocket` upgrades are
pure handshake redirects to the sandbox, and the platform process terminates
no sessions of any kind. Don't reintroduce an in-process session surface — if
platform host mode ever returns, run it in the guest on the bundle's runtime.

### Testing security boundaries

- `modal-sandbox.test.ts` — Modal spawn flow against an injected fake
  context: sandbox creation, tunnel dial + per-sandbox token, teardown on
  failure. (Isolation itself — filesystem, memory — is enforced by Modal's
  sandbox boundary, not host code.)
- `aai-guest/harness.test.ts` — the guest's `run_code`
  executor (console capture, thrown-error reporting, timeout). It does NOT
  test network/filesystem/env denial: the executor has no in-process
  sandbox — the Modal container is the boundary, so those are Modal's to
  enforce, not host code's.
- `net.test.ts` / `ssrf-extended.test.ts` — SSRF bypass prevention
  (IPv4-mapped IPv6, cloud metadata, `.internal` domains).

There is deliberately **no load or chaos tier.** `packages/aai-server/load/`
and `packages/aai-server/adversarial/` (plus the `load-and-adversarial` CI
job and `docker-compose.load.yml`) were deleted, because what they asserted
had drifted away from what they claimed to test:

- The two "adversarial" tests deployed an agent whose tool body was a
  `while (true) {}` spin or an unbounded allocation loop — **and then never
  invoked it.** No message was ever sent on the socket and the deploy seeded
  a fake `ASSEMBLYAI_API_KEY`, so no LLM existed to call the tool. Both
  amounted to "an idle server stays under 90% memory." Their docstrings still
  described "the isolate" and a "V8 heap (128 MB limit)" — the secure-exec
  design replaced two architectures ago.
- `lru-eviction.test.ts` configured `MAX_SLOTS` / `SLOT_IDLE_MS`, neither of
  which exists in the server anymore; testcontainers passes unknown env vars
  through silently, so it stayed green while testing nothing.
- `ws-memory.test.ts`, `session-memory.test.ts`, and
  `s2s-session-memory.test.ts` were benchmarks with `.test.ts` extensions —
  their only assertions were shape checks like `results.length > 0` and
  `sessions.length === TIERS.at(-1)`. `ws-memory` imported no aai-server code
  at all; it measured the `ws` package.
- `sandbox-storm.test.ts` swallowed deploy failures and passed on
  `aliveCount > 0` — 1 of 14 sandboxes working was a pass.

Two were real (`connection-flood`, `kv-corruption`), but not worth an 8-minute
Docker job wired into the required `ci` gate, where a wall-clock memory
threshold on a shared runner blocks merges when it flakes.

If you reintroduce load or chaos testing, the bar is: **the hostile code must
actually execute** (put it at the bundle's top level so the boot-time load
triggers it — no LLM needed), the thresholds must be tied to constants the server
really reads, and it belongs outside the merge gate. Note also that a
successful WebSocket upgrade proves nothing about the sandbox:
a client can hold an open `/session` socket to a guest whose runtime
failed to build (it is accepted, then closed 1011), so `opened.length === 1`
can hold while every sandbox fails.
