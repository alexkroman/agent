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
  slug for the container's life; a rebuild needs nothing from an empty slot.
  **A plain `Map`, and `withSlugLock` is the exclusion** — it was an `OwnedMap`
  whose ownership affordance nothing used, i.e. a type describing a guarantee
  no call site asked for; `SlotCache`'s own doc has the argument
- `guest-forward.ts` — the one platform→guest forward (`forwardToGuest`) and
  its header policy, shared by the three routes that proxy into a tenant's
  sandbox (`/client-config`, `/:slug/workflows/*`, the durable-run webhook),
  which had re-derived broker→URL→filter→bounded-fetch three times with three
  different filters. **A header crossing this hop reaches TENANT CODE**, so
  `Cookie`, `Authorization` and `X-Forwarded-*` never do; the API routes take
  an allow-list and the webhook route deliberately passes the rest through. Its
  module doc has the argument.

  **A route forwarding a STREAMING request body needs `bound: "activity"`; the
  other two bounds are a trap for it.** Both bound the response HEAD, so a
  guest that answers only after consuming the whole body has the entire upload
  inside its deadline — `POST /workflows/uploads` did, and a 500 MB file was a
  503 at 30.3s while working under `aai dev`, which has no forward at all. The
  `bound` doc in that module carries the arithmetic and why no TOTAL is right
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
- `workflow-webhook-handler.ts` — the durable-run webhook proxy (see
  "Durable workflows" below): brokers a sandbox for a run whose guest exited
  long ago and forwards one request to the guest's own webhook endpoint. The
  DevKit route the platform serves — the tenant-facing `/:slug/workflows/*`
  API is `workflow-handler.ts`
- `workflow-wake.ts` — the durable-run wake sweep (see "Waking a run whose
  sandbox is gone" below): the one thing here that boots a sandbox on a
  SCHEDULE rather than for a caller. Leader-elected per tick, reads a
  guest-published wake hint out of each app's own database, and wakes through
  `brokerSessionUrl` like every other caller
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
  Realtime streams — so a gap is invisible there and, in dev, is a write that
  lands and bumps the version with no watcher hearing it; there is no polling
  loop behind these streams to cover for it. `withWorkspaceEvents` missed
  `patch`, the METADATA STAMP (`stampWorkspaceMeta`, the only writer of the
  preview/deployed/database fields), so under `pnpm dev:aai-server` a finished
  preview deploy pushed no `project` frame at all. It survived because the
  studio SSE test modelled the stamp as a read-modify-write instead of calling
  `stampWorkspaceMeta` — **a test standing in for a real writer has to BE that
  writer.**

  **Wait out an emit with `memory.settled()`, never a microtask spin** — an
  emit is fire-and-forget in both directions, and the spin's iteration count is
  unknowable and silent when wrong. `settled()`'s own doc comment carries the
  full account; the two consequences to carry into new code are that a watcher
  whose work must be waitable has to RETURN its promise (which is why
  `watchAgentInvalidation` returns its `withSlugLock` promise rather than
  `void`-ing it), and that because `settled()` really waits it can DEADLOCK — a
  test holding the slug lock must commit, release, then settle
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
  orphaned `-preview` agents + their app database/role and Vault secrets,
  unreferenced deploy blobs, runaway tenant queries, pg_cron's own run log),
  installed idempotently at boot.

  **The orphan sweep drops its databases through `dblink`, because `DROP DATABASE`
  cannot run in pg_cron's transaction** (`25001`). dblink runs it on a second
  connection, so it is outside the caller's transaction — and it SURVIVES a
  rollback, which is why the drops must be the LAST thing a job body does. Three
  things it needs, each verified and each argued at its own site: a non-loopback
  host (`AAI_DBLINK_HOST` — over loopback a `trust` rule means the password is
  never used and dblink answers `2F003`), the credential from Vault
  (`PLATFORM_DB_DSN_SECRET`, never the job text), and the extension in a schema
  NOTHING has `USAGE` on (`aai_admin`) — dblink ships 39 `PUBLIC`-executable
  functions and a tenant reaching any of them executes as the ADMIN. That
  escalation was reproduced; revoking the overloads by name does not hold, the
  schema is the only chokepoint that does.

  **Per-app maintenance is `cron.schedule_in_database` instead** — pg_cron 1.6.4,
  usable by Supabase's non-superuser `postgres`, and it really fires into a
  database whose `CONNECT` is revoked from `PUBLIC` (the admin owns it). The
  session-state sweep is one job per app, created at provision time and
  unscheduled before the drop; `_session-state-sweep.ts` carries why, including
  the trap that its job-name prefix must stay disjoint from the one
  `schedulePlatformSweeps` DIFFS — a shared prefix would silently unschedule
  every app's sweep on the next boot. `cron.schedule` upserts by name,
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
  Only the MECHANISM is here; policy stays with each consumer, and every window
  the platform runs is the studio's (`aai-studio-server/CLAUDE.md`, "Rate limits")
- `client-ip.ts` — the rate-limit key. Reads the **last** `X-Forwarded-For`
  entry (the hop our own proxy appended), not the first — the leftmost is
  client-supplied, and keying on it hands an attacker an unlimited supply of
  rate-limit buckets. Note `public-origin.ts` reads the FIRST entry from the
  same header and is right to: it wants what the browser saw, which is the
  opposite end of the same list
- `_semaphore.ts` — counting semaphore with a bounded wait. Caps how many
  deploy bodies buffer at once (`DEPLOY_BODY_CONCURRENCY`): the size caps bound
  ONE request, so peak memory was arrival rate times a number the CALLER picks.
  `constants.ts` carries the measurement and the container budget it is sized
  against
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
  It replaced unstorage's generic S3 driver plus a local `getKeys` override, and
  the `SUPABASE_S3_*` credential triple with it — that module's own doc has the
  argument. A miss (404) MUST resolve `null` while any other failure throws: the
  bundle store caches misses under a sentinel and retries failures, so conflating
  them makes a live deploy read as absent. (The inert one-year `cacheControl` is
  argued at its own comment there too.)

  **`SUPABASE_SERVICE_ROLE_KEY` must be a SECRET key (`sb_secret_…`), and boot
  refuses an anon-authority one** — `assertServiceRoleKey` in `_boot.ts`, called
  once from `buildServiceConfig` (the only caller of both consumers, so the guard
  cannot be half-applied). **Its doc comment carries the argument**: what a
  publishable key does to Storage, the worse thing it does to Realtime, and why
  only the two definitely-wrong forms throw. Read it there rather than here — it
  was duplicated in both places, and this guide is the copy at a size cap. Note
  `SUPABASE_PUBLISHABLE_KEY` (browser sign-in, `supabase-auth.ts`) is a separate
  setting and stays publishable.

  Agent env lives in Supabase Vault through the injected `SecretStore`.

  **No referrer may delete a blob, but the SET of referrers may.** Content
  dedupes, so a superseded deploy's blob can be another agent's live file —
  which for a long time meant nothing deleted one, ever, and the bucket grew
  by a worker bundle (~8 MB) per changed deploy. `aai-sweep-blob-gc`
  (pg-cron.ts) closes it by mark-and-sweep, safe only BECAUSE the keys are
  hashes: the live set is every `worker_hash` plus every value of
  `client_files`, so a blob outside it is unreferenced by construction.

  **`assertBucketPrivate` refuses boot on a MISCONFIGURED bucket and only warns
  on an unreachable one.** The bucket is the one piece of Supabase state living
  in the dashboard rather than in `supabase/migrations` (a local `supabase start`
  declares it in `config.toml`), so nothing else would notice it going missing or
  turning public — but unlike the two guards above this one is a NETWORK call, and
  failing boot on a Storage blip would stop every container at once.
- `upload-bytes.ts` / `upload-handler.ts` — `PUT/GET/HEAD /:slug/uploads/:id/:offset`,
  one WINDOW of a workflow upload's bytes. The SAME bucket as deploy blobs, under
  `uploads/` rather than `blobs/` — which is safe only because
  `aai-sweep-blob-gc` filters `name like 'blobs/%'`; without that clause it would
  delete every upload in the bucket on its first run, an upload having no
  `worker_hash` to be found by. **Anything else put in this bucket owes the same
  check.** See "A workflow upload's bytes are the PLATFORM's" below.
- `deploy.ts` / `delete.ts` — deployment lifecycle.

  **A delete whose app-database deprovision fails FAILS (503)**, rather than
  warning and continuing — which deleted the `app-db:<slug>` secret and the
  agents row, leaving the tenant schema and login role alive with their only
  credential record gone and nothing naming the slug (`slugs()` no longer lists
  it; the orphan sweep matches `%-preview` only). The comment claimed "a later
  retry can finish the job"; there was none. Throwing makes it true: nothing is
  deleted, and the drops are `if exists` so a retry is a no-op on whatever the
  first attempt managed
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
- `app-database.ts` — per-app Postgres DATABASE/role provisioning in the
  platform's Supabase instance (`provisionAppDatabase`,
  `deprovisionAppDatabase`, `withAppDb`).

  **A DATABASE per app, not a schema, and the Workflow DevKit is why.**
  `@workflow/world-postgres` puts its run journal in a `workflow` schema and its
  queue in `graphile_worker` — DATABASE-level names it cannot nest inside
  `app_<hex>`. Creating them needs `CREATE ON DATABASE`, which a shared database
  cannot grant a tenant, so the DevKit's migration failed
  `42501 permission denied for database postgres` and every durable workflow
  silently had nowhere to live. Measured on PG 17.6: under the old grants both
  `create schema` statements are denied; inside the app's own database both
  succeed. It also closes a catalog leak for free — an app role could enumerate
  every other tenant's schema and role name out of `pg_namespace`/`pg_roles`.

  Three properties the module doc argues in full, each learned by getting it
  wrong: the database is owned by the ADMIN role (a non-superuser cannot drop a
  database it does not own — `42501 must be owner of database` — even one it
  created); **`revoke connect … from public` IS the tenant boundary** now, since
  Postgres grants `CONNECT` on a new database to `PUBLIC`; and `grant … on schema
  public` is required because PG15+ makes `public` writable by nobody else.
  `search_path` pinning is gone — an app owns `public` in its own database.

  **Deprovision follows the app's stored LOCATOR, never a recomputed
  placement**, and so does `usage`: changing `APP_DB_URLS` re-shuffles every
  existing app, so the `url` in its `app-db:<slug>` meta is the only record of
  where it lives. `AppDatabases.deprovision`'s own doc comment carries what
  recomputing costs — silent no-op drops beside a deleted credential, i.e. tenant
  data left unreachable with nothing raised — and why a meta-less sweep of every
  cluster is safe. Read it there.

  **The per-tenant caps differ in strength, and only two are controls.**
  `connection limit` is superuser-only to raise and `temp_file_limit` is
  `SUSET` (lowerable, never raisable), but `statement_timeout` is `USERSET` —
  tenant code holding the credential can `set statement_timeout = 0`. The 10s
  setting is what a well-behaved app sees; the enforceable half is
  `aai-sweep-app-db-runaways`, which terminates `app\_%` backends active past
  a much higher ceiling. Never treat the role setting as isolation.
- `storage-handler.ts` — `GET/POST/DELETE /:slug/storage` (owner-auth'd)
  toggling the app's database, plus `storageUsage`/`appDatabaseUsage` (how
  much is IN it — see `packages/aai-studio-client/CLAUDE.md`).

  **`enableStorage` no-ops on an already-enabled app, and that is the point.**
  `provisionAppDatabase` mints a fresh password every call and the caller
  persists it, so re-provisioning ROTATES the role's credentials under a
  resident guest holding the `DATABASE_URL` baked in at spawn — and storage
  changes move no sandboxes (below), so nothing rebuilds behind it.
  `aai storage enable` run twice broke `ctx.db` mid-session, silently. The
  check is INSIDE the slug lock, and having it here means neither caller can
  forget it

## Two questions, two sentinels

**`SUPABASE_DB_URL` decides where platform state lives; `AAI_LOCAL_DEV=1`
decides whether tenant code gets a real boundary.** They are independent, and
one variable used to answer both — `isLocalDev` was `!SUPABASE_STORAGE_BUCKET`
and gated the stores, the sandbox backend, key verification, the session-mode
and service-role-key assertions, dev auth, and origin retention together.

| Question | Sentinel | Set | Unset |
| --- | --- | --- | --- |
| Where is platform state? | `SUPABASE_DB_URL` (`hasPlatformDb`) | Postgres/Vault/Realtime/Storage, companions REQUIRED | memory, everywhere |
| Is this a local run? | `AAI_LOCAL_DEV=1` (`isLocalDev`) | `subprocess` backend, key verification optional, origin retained | production defaults |

Three things the split fixed, all of them measured on a morning it cost:

- **There is no third tier.** `buildPlatformDb` used to have a
  local-dev-with-a-database branch giving memory stores beside REAL per-app
  schemas. So `pnpm dev:aai-server` against the local stack lost every deployed
  agent on restart while its app database sat in Postgres — a published slug 404s
  and nothing about the failure names the store that dropped it. With a platform
  database every store is Supabase's, and `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` are required rather
  than optional: half-configured is refused at boot, because a platform database
  with no Realtime credential is a server that silently stops invalidating
  sandboxes and pushing SSE.
- **The safe branch is the default.** The old sentinel made an EMPTY environment
  resolve the isolation-free `subprocess` backend and skip AssemblyAI key
  verification. `AAI_LOCAL_DEV=1` inverts that; `sandbox-backend.test.ts` asserts
  it on `{}` for exactly this reason.
- **Local is no longer an excuse.** `assertSessionModeUrl` and
  `assertServiceRoleKey` run on every tier now — a laptop is where a publishable
  key gets pasted by mistake, and both of that key's symptoms (a deploy dying on
  `storage.objects` RLS, a Realtime channel rejoining in silence) are the
  misleading ones those assertions exist to pre-empt. Dev auth is refused outright
  once a platform database is configured, with no `AAI_LOCAL_DEV=1` escape: if
  state is in Supabase, identity is too (`createStudioAuthFromEnv`).

`scripts/dev-server.mjs` supplies both, so `pnpm dev:aai-server` needs no
exported variables — it sets the declaration and resolves the stack from
`supabase status -o env`, layered under a repo-root `.env` and under the shell.
`supabase/README.md` is the setup walkthrough, GitHub OAuth app included.

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

Three deliberate divergences (`postgres_changes` rather than Broadcast, DENY-ALL
RLS over a schema no role holds a grant on, per-app Postgres roles instead of
RLS) plus the two operational facts the code depends on and cannot assert
(IPv4/IPv6 on a direct connection, and the deprecated legacy key forms) are in
**`supabase/README.md`**, beside the migrations they describe. Read it before
adding a fourth watched table, a table without RLS, or a publication column
list — the last is measured, reverted and guarded against.

### Two arms per store contract, and the stack is the only real one

Every store's memory/Postgres equivalence is ASSERTED, not assumed. One case list
per contract in `store-conformance-cases.ts` (registry: `store-conformance.ts`);
the unit suites run it over the MEMORY arm unconditionally, and the two
`*store-conformance.scenario.test.ts` files run the same list over the local
Supabase stack behind `describeWithStack`, which `pnpm test:pg` resolves. The
rules:

- **An arm is legitimate only if something really runs on it.** Memory qualifies
  (an agent with no `DATABASE_URL`), the stack qualifies (it IS the platform), a
  STOCK Postgres does not — nothing runs `aai_platform` without Vault, pg_cron and
  walrus — so the `create extension`-stripping regex and the plpgsql `pgmq.create`
  stub propping that arm up are deleted. A plain server stays right for the SDK's
  own stores, where a user brings the database.
- **The fake `SqlExec` is a RECORDER, not an arm**, and keeps its own spec: the
  statements a store issues, and the DDL it must not.
- **A case is arm-independent** — fresh keys from `uniqueKeys`, never `"s"`/`"p"`
  — and what one arm cannot express is not a shared case (`RateLimiter.check`'s
  `now` is dropped by the pg implementation on purpose).
- **A case REMOVES what it wrote, and a QUEUE makes that load-bearing.** Unique
  keys stop collisions, not accumulation, and the stack arm's pgmq queue is the
  real one a dev server drains: four `previewQueueConformance` cases used to
  leave their job claimed-but-unacked, so it came back after the visibility
  timeout and stayed. Measured — 24 conformance jobs from runs two days earlier,
  drained by `pnpm dev:aai-server` the first time it had a platform database,
  each printing `Archiving preview job with no resolvable credential
  { project: 'p' }` against a `user:abc` no Vault can resolve. Nothing in that
  log names a test, which is what makes a left-behind row worse than a noisy
  one. The cleanup is per CASE rather than an `afterAll` sweep, because a claim
  hides a job for its visibility timeout and a suite-level drain cannot see the
  very set that needs removing.
- **Register the pair or the gate fails.** `store-conformance-registry.test.ts`
  (a TEXT scan, respecting the boundary this package may not import across)
  refuses an unregistered `createPg*`/`createMemory*` pair, a registered name that
  does not exist, or a conformable contract not invoked from BOTH a unit and a
  scenario file; `conformance: false` must say why.
- **`ensurePlatformTables` VERIFIES a CLI-built database** against
  `supabase_migrations.schema_migrations`, failing with the pending filenames and
  the command rather than on a column six migrations later.
- **`pg-cron.scenario.test.ts` EXECUTES every sweep body**, which nothing did:
  `pg-cron.test.ts` asserts only that the body reached `cron.schedule` as a
  string, so a syntax error was green and swallowed hourly by `guarded()`.

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
  pinned by `platform-db-budget.test.ts`): these are DIRECT connections, so
  `MAX_CONTAINERS` × the per-replica pools consumes `max_connections` outright —
  whose ceiling is an outage rather than degradation.

  **The budget counts APP DATABASES now, and excluding them was an accounting
  error rather than a routing decision.** The test excluded them because they
  are POOLED — but the pooler is Supavisor in SESSION mode, mandatory for the
  Workflow DevKit and multiplexing NOTHING, so one client connection is one real
  backend. Routing them through it changes which limits apply, never how many
  connections exist. So the bound was on the term that does not grow
  (`MAX_CONTAINERS`, which an operator sets) while the term that scales with
  TENANTS went uncounted, and the two always competed for the same
  `max_connections`. `MAX_ACTIVE_APP_DATABASES` is that term, and its value is
  the finding: at `MAX_CONTAINERS = 5` the platform's own pools take 20 of the
  40, leaving room for **two** apps at their entitlement. Raising it needs a
  larger instance or `APP_DB_URLS` sharding — no code change can buy it —
  which is why the number is deliberately small enough to fail the test when
  growth outruns the provisioning.

  Measured, for calibration: the admin pool genuinely multiplexes (4 client
  connections cost 2–3 backends, fleet-wide rather than per replica), the
  slug-lock pool reaches exactly its 4 under concurrent distinct-slug mutations,
  and one provisioned workflow app holds 6 backends at rest against its 10.

  **And boot CHECKS the claim** (`platform-db-capacity.ts`): `show
  max_connections` plus a `pg_stat_activity` count against `platformDbBudget()`,
  warning with the arithmetic on an overrun. The constant's doc used to say
  "nothing in the repo can check it", which was the reason it went unchecked
  rather than a property of the problem — this process holds a connection. Other
  load is **measured, not declared**, which the laziness above is what makes
  sound (ONE direct backend at idle here, on pools sized 4 and 4); it is a FLOOR,
  since a replica booting into a warm fleet counts its peers, so it errs toward
  warning. It never blocks boot — refusing to start over a projection turns a
  future degradation into a present outage.

  **Only the SLUG-LOCK pool is in that number, and what decides membership is
  whether a connection needs SESSION affinity.** Measured against a real
  Supavisor in transaction mode: `pg_advisory_lock` (the slug lock, held for a
  whole deploy) LOSES exclusion — a rival connection acquired the same lock while
  it was held, which is the bug `assertSessionModeUrl` exists to prevent and had
  never been reproduced before. `pg_try_advisory_xact_lock` (the wake sweep's
  leader election, inside `begin … commit`) is correct throughout, because a
  transaction pooler pins one backend for exactly that lock's lifetime. So:
  - `SUPABASE_DB_URL` — direct, session mode. The slug-lock pool, and the app-db
    locator. `assertSessionModeUrl` still refuses a pooler here.
  - `PLATFORM_POOLER_URL` — Supavisor TRANSACTION mode, for the admin pool.
    Refuses a session-mode URL, which multiplexes nothing while looking set.
  - `APP_DB_POOLER_URL` — Supavisor SESSION mode. Every app-database connection,
    the guest's own `DATABASE_URL` included. Refuses transaction mode, which
    breaks the DevKit three ways (graphile-worker's named prepared statements,
    `world-postgres`'s `LISTEN` with no polling fallback, and
    `workflow-lock-sweep.ts`'s session-scoped advisory lock).

  Session mode does not multiplex, so app databases still cost real connections
  at peak — bounded by Supavisor's pool sizing (a pool per `user+db+mode` triple,
  `max_pools` defaulting to 50 per tenant) rather than by this formula. Unset,
  either pooler variable means DIRECT and the budget understates a replica, so
  boot announces it. `platform-connection-config.test.ts` pins all three rules.

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
- **Rate limits** (`rate-limit.ts`): rows in `aai_platform.studio_rate_limits`,
  one atomic upsert per check, so a limit holds platform-wide rather than
  multiplying by the replica count. Windows and keying: "Rate limits" in
  `packages/aai-studio-server/CLAUDE.md`.
- **Session resume needs no cross-replica store**: sessions live in the guest
  sandbox, not on a replica — a `?sessionId=<id>` reconnect re-brokers via
  `GET /:slug/client-config`. It need not land on the SAME sandbox any more: slot
  state is durable in the app's own database when storage is on, so a REPLACEMENT
  guest (redeploy, `handoverSlot`, the peer route) recovers it.
  `_session-state-sweep.ts` reclaims what a dead guest left.

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
`.ts` source, which its consumer bundles). `aai-studio-server` is the studio
surface AND the composition root: its entry is the only one any deployment
runs, and `pnpm dev:aai-server` runs it too, so local dev and production are
the same composition. There is ONE Modal app, `aai-server-web`, from
`packages/aai-server/modal_deploy.py` — note the asymmetry, the deploy script
lives in the package that does NOT provide the entry.

**The composition itself is documented where the composition ROOT lives: see
"One deployment, two packages" in `packages/aai-studio-server/CLAUDE.md`.**
That is where the retired split deployment and the two constraints any revival
owes are recorded, along with the `alwaysBundle` specifier bug that cost every
container cold start ~72 modules of type-stripping, the 31-subpath shared-core
`exports` map (widen it in package.json, and delete an entry when a coupling
goes away — this list only ratchets down), `resolvePublicOrigin` and the two
outages that came of deriving a scheme from the request URL,
`AAI_ALLOWED_ORIGINS`, the agents-row CHANGE STREAM that is the only
cross-service invalidation (and why its REJOIN is itself a signal), retirement
vs. termination, and the shutdown ordering — the boot guard, the grace, the
two-level bound, and why a long-lived response must register with
`live-streams.ts`.

Two rules from it that a reader of THIS package needs in front of them:

- **A resolved public origin may be used WITHIN the request that asked for it
  and never stored for a later one.** `Host` and `x-forwarded-*` are the
  caller's to write, so a use inside the request is self-directed (a caller who
  lies gets its own lie back) while one that outlives it is an injection — see
  "Durable workflows" below for the shipped instance.
- **Deploy and delete are the ONLY mutations that move sandboxes.** Secret and
  storage changes write Vault and bump nothing; the documented way to apply a
  secret is to redeploy.

## Modal sandbox notes

- **Two backends, selected by `sandbox-backend.ts`.** Guest sandboxes are
  **remote Modal Sandboxes** (`modal-sandbox.ts`) in production and a plain
  **child process** (`subprocess-sandbox.ts`) in local dev. The policy is
  three rules: an explicit `SANDBOX_BACKEND` (`modal` | `subprocess`) always
  wins (unknown values throw — a silent fallback would look like the override
  not working); otherwise not-local-dev → `modal`, unconditionally; otherwise
  → `subprocess`. `isLocalDev` is an explicit **`AAI_LOCAL_DEV=1`** and nothing
  else, so `modal` is the DEFAULT and **production can never resolve the
  host-local backend** — it fails loudly without
  `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (or a `~/.modal.toml` profile) rather
  than degrading. There is **no fallback between backends at spawn time**: a
  failed spawn is a failed spawn.

  That sentinel was `!SUPABASE_STORAGE_BUCKET`, which inverted the rule it
  exists for: the isolation-free branch was what a FORGOTTEN variable selected.
  It also tied the backend to where platform state lives, so pointing a dev
  server at the local Supabase stack silently demanded Modal credentials — see
  "Two questions, two sentinels" below.
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
  Modal App sandboxes are created under (default `aai-server`). **Its major
  tracks the SERVICE image's and `.node-version`, and that split floor decides
  which Node 26 features may be used where — a rule `tsc` cannot enforce.** See
  "The guest image's Node major, and the split floor it creates" in
  `packages/aai-guest/CLAUDE.md`.
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

  **Why they must stay two numbers is argued in `modal_deploy.py`'s own
  guest-sandbox resources block** — the bimodal load, the direct-reclaim wedge
  a single number produced, and why the cgroup cap defeats moving the bundler
  into a child process (#845, reverted in #863). Read it there; this guide is
  the copy at a size cap. What it does not carry is the MEASUREMENT, so: on a
  wedged production sandbox, RSS pinned flat at 1.29 GB, ~1 core split seven
  ways across 4 V8 GC workers + the main thread + 2 rolldown workers, **zero**
  I/O, 453 CPU-seconds and no progress, versus 253 MB / 0.97 CPU-seconds on an
  idle sibling. It reads as a hung build, never as an OOM — and
  `--max-old-space-size` cannot help, because the memory is native rather than
  V8's.

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

  The locality it bought was narrower than the note that justified it claimed:
  AGENT guests have no host channel at all, so a voice turn crosses that hop
  **zero** times and only the studio's control-channel RPCs pay it, outside any
  latency budget. Re-pin per environment if that stops being true; don't re-bake
  it into the shared image.

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

## A teardown may not depend on the boot it is tearing down

`createSandbox` returns SYNCHRONOUSLY with a pending `vmReady`, so a spawn's
Modal create, boot writes and readiness probe all run OUTSIDE the slug lock the
broker took — and `deleteAgentResources` drops the app's Postgres role and
database FIRST. So a DELETE landing in that window completes while a guest is
still coming up, which reached production as `28P01 password authentication
failed for user "app_<hex>"` out of `@workflow/world-postgres`'s migration.
**28P01 is also what a MISSING role reports**, so it reads as a
storage-credential bug and is a lifecycle race.

**The rule, because this shape recurs: a capability a TEARDOWN needs must never
be published on the RESOLVED handle.** `terminate` was, so the one operation
that must not require a healthy guest was gated on having one — `shutdown()`
waited 5s on `vmReady` and swallowed the lapse, which `DrainingError` had
already guarded the shutdown-time version of. Both backends hand a kill over the
moment the sandbox exists now (`BackendAgentSpawn.onSpawned`, which carries the
full account) and `shutdown()` falls back to it.

## A new guest route must declare how the PLATFORM exposes it

`aai dev` serves the guest's own routes directly, so a feature is developed
against a server where the guest's dispatch table is the whole API. Deployed,
almost nothing works that way: a browser voice socket and a carrier media
stream are handed a sandbox URL, and every other caller has to be brokered,
which means the orchestrator needs a `/:slug/…` route of its own. The gap is
invisible in a diff and invisible to the feature's own tests, and it has landed
twice — once as a whole guest surface nothing routed to (every request fell
through to `app.notFound`), once as a platform route serving GET and POST for a
guest that also answered DELETE, so a Stop button worked in dev and 404'd on
every deployed agent.

So `GUEST_ROUTE_EXPOSURE` (`packages/aai-server/guest-routes.ts`) declares each
route as `proxied` (with the methods the GUEST answers, plus the `suffix` when
the platform path ends in a parameter), `direct-dial`, `host-only`, or
`guest-internal` — dialled only from inside the container on loopback, which is
a different claim from `host-only` and worth keeping apart: `host-only` says the
platform dials it holding a token, so writing it on a loopback-only route
describes a gate that is not there. A missing entry is a compile error, and
`guest-routes.test.ts` asserts every proxied method is really registered under
`/:slug` — plus the reverse, so a stale `direct-dial` declaration cannot sit
beside a platform route that does forward. Declare the methods from the guest's
dispatch; making the platform match is then a failing test rather than a
production 404.

**Only the PLATFORM half of that is verified by a test; the upstream half is a
guard.** `guest-routes.test.ts` introspects the real orchestrator app, so
"declared `proxied` but not registered" and "registered but declared otherwise"
both fail. What it cannot check is whether `GUEST_ROUTES` still describes the
guest — that list is transcribed by hand, and it cannot be derived, because
`aai-server` may not import guest source. It had already drifted:
`GET /studio/tools` was a real guest route in neither table, and the `satisfies`
could not catch it (that compile error fires for a KEY with no exposure entry,
never for a route nobody wrote down), so the studio client reached it by
rewriting another route's URL — the exact surgery `guest-routes.ts` says the
table exists to end. `guard-invariants.mjs` rule 12 closes it by reading both
trees as TEXT, which respects the boundary the same way `sync-agent-guide.mjs`
does. Methods stay declarative: the guest dispatches with `if (url === X)`
chains, so there is no table to derive verbs from, and a route can still be
declared with the wrong ones — it can no longer be absent.

**A route's exposure is decided by WHO CALLS IT, not by what it does.** The
three workflow routes are the worked example, and they split: the DevKit's
`flow` and `step` queue callbacks are `guest-internal` (the guest's own worker
dials its own server, and they are unauthenticated *because* loopback is the
whole gate — a platform route would hand anyone another tenant's run), while
`webhook` is `proxied`, because its URL is handed to a third party and has to
outlive the sandbox that minted it.

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

**In production.** A run declaring `AAI_LOCAL_DEV=1` defaults to the
`subprocess` backend, which has **none** of the properties described below —
the harness is a child process of the server, sharing its uid, filesystem, and
network — see "Modal sandbox notes". Selection (`sandbox-backend.ts`) makes it
unreachable without that declaration: every other environment resolves `modal`
unconditionally, so the boundary is what a deployment gets by DEFAULT rather
than by remembering a variable. When reasoning about the security model, the
backend is the first thing to establish, and the boot log names it (with a
warning when there is no boundary at all).

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
- **Sessions live in the guest**: the embedded runtime owns per-session state
  (slot values, history, the resume grace window) exactly as the self-hosted
  runtime does. The host holds no session state; a DURABLE slot value lives in the
  tenant's own schema, on the tenant's own role.

Key files: `sandbox.ts`, `sandbox-vm.ts`, `modal-sandbox.ts`,
`aai-guest/harness.ts`, `rpc-transport.ts`. A deployed agent's env is
delivered as a boot FILE written into its own sandbox (scrubbed after
reading); per-sandbox tokens ride the exec env, and platform secrets stay
host-side.

**Credential separation:** each agent provides its own `ASSEMBLYAI_API_KEY`
via `.env` (local dev) or `aai secret put` (production) — **there is no
central/platform-owned key**, and `SandboxOptions` keeps `apiKey` (host-only,
for S2S connections) apart from `agentEnv` (forwarded to the guest). Agent
secrets live in Supabase Vault (`agent-env:<slug>`), and app-database
credentials reach the guest as `DATABASE_URL` — the app's OWN scoped role,
never a platform admin credential. **What a guest may hold, why credential
resolution reads the agent env only and never `process.env`, the two helpers
that must both stay sealed, and the type-level `HostCredentialEnv` brand that
keeps `withHostCredentialFallback` out of `ctx.env` are in
`packages/aai-guest/CLAUDE.md`, "Credential separation, and what reaches a
guest".**

**Cross-agent isolation:** app databases are separate Postgres DATABASES with
per-app login roles and `CONNECT` revoked from `PUBLIC` (verified: a neighbour's
database answers `42501 permission denied`), each sandbox communicates over its
own authenticated WebSocket, sessions are per-sandbox, and there is no shared
mutable state between sandboxes.

**`run_code`**: executes only inside the guest sandbox — see "The
`run_code` executor" in `packages/aai-guest/CLAUDE.md` for its authority
and why there is no in-process capability stripping.

**SSRF protection**: `aai/host/ssrf.ts` is the implementation. The screening
policy (why a CONTAINED guest is not screened), the bypass classes covered, and
the two undici-version traps in the pinned dispatcher are in
`packages/aai-guest/CLAUDE.md`, "Guest network access".

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
  - **Both ways to switch it off are DECLARATIONS** — `AAI_LOCAL_DEV=1`
    (`isLocalDev`) or an explicit `AAI_VERIFY_API_KEYS=0` — and it is present
    otherwise, so a boot that merely forgot a variable gets verification, not a
    hole. Neither is inferred from where platform state lives, so a dev server
    on the local Supabase stack is unaffected by which is set. The endpoint is
    `AAI_KEY_VERIFY_URL`-overridable.
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
- **Browser sessions are Supabase Auth**, and `aai login` LINKS an
  already-signed-in browser account rather than signing anyone in — the
  device-link flow whose grant is one exchange for the account's stored key.
  Both are the STUDIO's auth surface and are documented with it:
  `packages/aai-studio-server/CLAUDE.md`, "Studio auth". The mechanisms live
  here (`supabase-auth.ts`, `middleware.ts`) because the shared core owns
  them; the two verification paths, why one of them pays a round trip, and
  the cli-link grant's lifetime are all there.
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

### A workflow upload's bytes are the PLATFORM's

A deployed guest holds no bucket credential: it runs tenant code and the bucket is
platform-wide, so a service key there is a cross-tenant read of every agent's
uploads AND every agent's worker bundle. So the byte path is a platform route the
guest brokers through (`aai/host/_upload-blobs-brokered.ts`, selected by the
`AAI_UPLOAD_BROKER_URL` boot key — a SECOND name for `AAI_PUBLIC_BASE_URL`'s value,
because that one is a claim a self-hosted deployment also makes; `agentBootEnv`
carries why), the browser sends each
window here and then tells the agent which one landed, and no upload byte reaches a
guest or a tenant database. **`upload-handler.ts`'s module doc carries the argument**
— the key derivation, why the route is as public as `/client-config` beside it, and
why reads REDIRECT (a sixty-step fan-out would otherwise move a 200 MB recording
through this process once per run) while writes do not. Read it there; this guide is
the copy at a size cap. `aai/host/_upload-blobs.ts` has what those bytes cost when
they were `bytea` rows in the app's own database.

One thing a reader of THIS package needs in front of them: the key is composed from
the slug Hono matched and never from anything the caller sends, because the prefix it
must never be able to name is `blobs/<hash>`.

### Telephony — `GET/POST /:slug/phone`

A carrier points a phone number at this route; it brokers the agent's sandbox
and answers with the markup that tells the carrier to open a media stream
against that sandbox's own `/phone` endpoint. From there the carrier talks to
the guest directly and the platform is out of the path, exactly as it is for
browser sessions. The guest half — the bridge, the codecs, the resampling — is
the SDK's code (`aai/host/telephony/`) and is documented below.

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

**"Enabled by the secret" is per AGENT, never per CARRIER — the caller names
the carrier.** `?carrier=` is a query parameter on a route carrying only
`slugMw`, so reading enablement per carrier let the caller pick the branch:
against an agent with `TWILIO_AUTH_TOKEN` set, `?carrier=telnyx` missed the
Twilio branch (carrier mismatch) AND the Telnyx branch (no key) and fell
through to `{ ok: true }`, after which the route brokered a Modal sandbox and
answered with TwiML carrying the guest's auth-free `wss://…/phone`. Symmetric:
a Telnyx-only agent was bypassed by OMITTING the parameter, the default being
`twilio`. So the fall-through is scoped to an agent that configured NOTHING:
once ANY carrier secret is set, an unverifiable request is refused — including
one naming a carrier whose secret is absent.

**The signed URL is the PUBLIC one.** Twilio signs the URL it built the
request from, which behind Modal's TLS termination is never `c.req.url` — the
handler composes it from `resolvePublicOrigin`, for the same reason everything
else on this platform does (see "Never derive the public scheme from the
request URL").

#### The guest half: a phone call is an ordinary session

`WS /phone` (`host/telephony/`) accepts a carrier's bidirectional media
stream — Twilio Media Streams, Telnyx media streaming — and runs it as an
ordinary session. `createServer` serves it by default, so `aai dev`, a
self-hosted server and every deployed agent all answer phone calls with no
per-agent configuration — the platform route above is only what points a carrier
at it.

**Nothing in the session stack knows about telephony, and that is the whole
design.** `SessionCore` talks to a `ClientSink`; `wireSessionSocket` talks to
a `SessionWebSocket`. So the adapter is a socket-shaped SHIM
(`createTelephonyBridge`) that speaks the client protocol on one side and the
carrier's JSON framing on the other, handed straight to
`runtime.startSession`. Turn-taking, barge-in, tool calls, the audio pacer and
its ordering rules, session eviction, keepalives, start timeouts and teardown
are not reimplemented for phone — a call gets them because it runs the same
code the browser does. Resist adding a telephony branch anywhere below the
bridge; if one seems necessary, the bridge is the wrong shape.

Four things that are easy to get wrong here, each of which was a decision:

- **Pacing stays ON.** A carrier accepts audio far faster than it plays it and
  buffers the rest — exactly the shape that made unpaced host-mode sessions
  destroy 36% of all agent audio (see "Host-mode audio pacing" in
  `packages/aai-cli/CLAUDE.md`): the
  backlog builds on the FAR side, where `PacedAudioSink.clear()` cannot reach
  it. So the bridge sets no `audioLeadMs` and a barge-in additionally sends the
  carrier's own `clear` frame, which is the only way to drop what it already
  holds. Without that frame the caller talks over an agent that keeps speaking
  for seconds after being interrupted.
- **The rates are LEARNED from the `config` frame**, not configured. The first
  thing any runtime sends a session is `{ sampleRate, ttsSampleRate }`, so the
  bridge builds its converters from that — which lets one adapter serve a
  16 kHz pipeline agent and a 24 kHz S2S agent, and avoids plumbing a rate
  through `createServer`, whose runtime is a LAZY facade in the guest harness
  and cannot answer a rate question before the first session exists.
- **Downsampling must low-pass first, and both converters are STATEFUL**
  (`telephony/resample.ts`) — decimating without the filter folds everything
  above 4 kHz back into the speech band, and rebuilding a converter per 20 ms
  chunk puts a click at every boundary, 50 a second. That module's doc carries
  the measurement; `telephony/mulaw.ts`'s carries why the G.711 curve is kept
  sample-exact rather than approximated.
- **This does not contradict "the host does not resample"** (see the S2S
  section). That rule says rate conversion belongs at the EDGE, because every
  client owns its own rate and asking it to send the advertised one is cheaper
  and more honest. A carrier is the one client that cannot comply — 8 kHz
  μ-law is what the PSTN carries — and the bridge IS the edge. The rule put
  the conversion exactly here.

Adding a carrier is one `CarrierCodec` in `telephony/carriers.ts` and nothing
else — that module's doc owns the two properties every codec owes (decoding
NEVER throws, and a media frame on a non-`inbound` track is DROPPED) and why
these frames are narrowed by hand rather than by a Zod schema.

**Known gaps**, both deliberate: no `mark` frames, so `playback_progress` is
unused and the pipeline falls back to its open-loop estimate; and DTMF is
ignored rather than surfaced as a custom event.

### Durable workflows — `/:slug/.well-known/workflow/v1/webhook/:token`

The Workflow DevKit runs entirely inside the guest (see
`packages/aai/host/workflow-*.ts`); this is the platform's share of the DEVKIT's
own three routes — the tenant-facing API is separate, below — and which of the
three gets a proxy is the decision worth keeping:

- **`flow` and `step` get nothing** (`guest-internal` in
  `GUEST_ROUTE_EXPOSURE`). They are queue callbacks the guest's own
  graphile-worker dials on loopback, and they are unauthenticated *because*
  loopback is the gate — a platform route would be an unauthenticated way to
  replay another tenant's run or execute one of its steps. If a run's queue
  ever moves out of the guest they need a route AND an authenticity check,
  never one without the other.
- **`webhook` is PROXIED**, because it is the one URL that leaves the system.

**The proxy exists because the run outlives the SANDBOX.**
`createWebhook()`'s URL goes to a payment provider or an approval mail and must
still work weeks later; a Modal tunnel URL changes on every respawn, and agent
mode self-exits after `AGENT_IDLE_EXIT_MS` with zero sessions. So the common
case is a delivery arriving at a slug with NO sandbox, and
`workflow-webhook-handler.ts` brokers one exactly as `GET /:slug/client-config`
does — which works because run state lives in the app's own Postgres (the
DevKit's Postgres world), not in guest memory: a freshly booted guest resumes a
hook parked days ago. A still-booting sandbox is a **503 + `Retry-After`** (the
boot continues and the sender's retry joins the same readiness promise) rather
than the phone route's retry-in-the-response, because a webhook sender already
has a retry loop and a carrier does not.

A forward, not a redirect: senders differ on whether they follow one on a POST
(and those that do may drop the body). Auth is the token and nothing else, at
both ends — the DevKit is explicit that this is the endpoint's only
authorization, and the posture matches `/client-config` and `/:slug/phone`
beside it, so nothing is newly reachable; the body is capped
(`MAX_WEBHOOK_BODY_BYTES`) before it is buffered, since the route is public
and boots sandboxes.

**The URL the DevKit MINTS is still guest-local, and the SDK mints the public
one.** `createWebhook()` sets `hook.url` from `getWorkflowMetadata().url`, which
is `http://localhost:<port>` off the running process — verified in the installed
`@workflow/core`, whose only other branch is `https://$VERCEL_URL`, and that one
also switches on a replay watchdog calling `process.exit(1)` inside what is also
a voice guest. So `hook.url` names the inside of a container that will not exist
when the payment provider calls back. The platform therefore CARRIES its own
answer into the guest: `agentBootEnv` sets **`AAI_PUBLIC_BASE_URL`** (the public
origin plus the slug — `agentPublicBaseUrl` in `public-origin.ts`), the harness
passes it to the bundle's runtime as `publicUrl`, and
`ctx.workflows.publicWebhookUrl(token)` composes the URL this route answers from
the same `WORKFLOW_WEBHOOK_PREFIX` constant. `WORKFLOW_LOCAL_BASE_URL` is
untouched and could not have helped: it steers QUEUE dispatch and never reaches
`hook.url`, and repointing it would 404 the `guest-internal` `flow`/`step`
callbacks. (The other gap this section used to name — a parked run that nothing
ever boots the guest for — is what the wake sweep below closes.)

**In production `AAI_PUBLIC_ORIGIN` is the ONLY source of that value, and any
deployment that mints durable URLs owes it.** It is baked at spawn and there is
one sandbox per slug fleet-wide, so a per-request mechanism would buy nothing
anyway — a URL handed to a payment provider has to outlive the request that
minted it. Unset, the key is omitted and the SDK throws naming the option,
which is the designed answer.

An OBSERVED origin (`rememberPublicOrigin`, wired into `app-middleware.ts` for
the spawn paths that hold no request — the blue-green handover fires off the
change stream, the wake sweep off a timer) is kept in LOCAL DEV only, because a
real hole shipped: that middleware runs before any auth, and the origin
resolves from caller-written `Host`/`x-forwarded-host`. One
`curl -H 'Host: evil.example' <replica>/health` made the next sandbox that
replica booted — any slug, any tenant — mint `https://evil.example/<slug>/…`
from `ctx.workflows.publicWebhookUrl(token)`, so the payment callback delivered
its payload and the run token to the attacker and the run never resumed:
unauthenticated, cross-tenant, durable past the request that caused it. That is
the "outlives the request" half of the rule above, and no header tells an
honest `Host` from a forged one — so production refuses to guess, while local
dev keeps observing on the premise that also lets the isolation-free
`subprocess` backend be selected there.

### Waking a run whose sandbox is gone — `workflow-wake.ts`

A webhook is a delivery, so the proxy above has a caller to react to. A
`sleep()` has nobody: the queue is graphile-worker POLLING the app's database
from inside the sandbox, and an agent guest self-exits after
`AGENT_IDLE_EXIT_MS` with zero sessions, so a run asleep until tomorrow has no
process polling for it and never resumes — with no error, no log, and
`ctx.workflows.get(runId)` still reporting `running`. The sweep is the thing
that notices the TIME.

**It detects due work and BOOTS the sandbox; it does not run the queue.** The
alternative — the replica polling the queue on the tenant's behalf — was
rejected on the boundary, not on cost: it would execute tenant step bodies in
the process holding the service-role Postgres credential, Vault, and Modal's
tokens. What the chosen shape costs is priced in the module doc, and the number
to know before designing on top of it is **one sandbox per wake, billed for at
least one idle window** — a workflow that sleeps 24 times pays 24 boots and
24 × 5 minutes of guest lifetime. That is inherent to durable runs on ephemeral
sandboxes; the lever is `AAI_GUEST_IDLE_EXIT_MS`, not the sweep.

**The platform cannot ask the queue, so the GUEST answers.** The DevKit's
`graphile_worker` schema is per-DATABASE and its rows carry no tenant column, so
"which of these jobs is agent X's" is answerable only inside the process whose
world it is. Each workflow guest therefore reduces its whole queue to one
timestamp — the earliest moment a job could be claimed — and upserts it into
`aai_workflow_wake` in the app's own `ctx.db` database
(`aai/host/workflow-wake-hint.ts` owns that contract, including why a locked job
is dated from graphile-worker's 4-hour job expiry and why a job past
`max_attempts` counts for nothing). The sweep reads that one column on the
platform's admin connection. The hint is tenant-writable and is treated as a
HINT: the only thing it can cause is a boot of the tenant's OWN agent, which
`GET /:slug/client-config` can already cause, and forging a neighbour's is
impossible by construction — the schema name is `appDbIdentifier(slug)` and the
slug comes from the agents table.

Four properties, each the answer to a way this could go wrong:

- **It cannot resurrect a deleted agent**: candidates come from the agents
  TABLE, so a deleted one is not in the list (its schema outlives the row until
  the orphan sweep, and is skipped for having no slug), and behind that
  `brokerSessionUrl` answers 404 for a slug with no bundle.
- **It cannot fight the blue-green handover**, because waking IS
  `brokerSessionUrl` — the one routing point, which serves a live resident
  as-is, joins a boot in flight, routes to a live PEER rather than duplicating,
  and refuses while draining. The sweep touches no slot itself.
- **A wake LOOP is bounded twice** (`WORKFLOW_WAKE_RETRY_MS` per slug,
  `WORKFLOW_WAKE_MAX_PER_TICK` per tick): a guest that boots and cannot run its
  world never rewrites its hint, so without the backoff it is a sandbox per
  interval, indefinitely.
- **One replica sweeps per tick**, via a transaction-scoped advisory try-lock on
  the reserved admin connection that also carries the pass's `set local
  statement_timeout`. Efficiency, not correctness: `brokerSessionUrl` is
  idempotent fleet-wide, which is why a lost lock is a silent skip.
- **The per-app reads are one SHORT-LIVED connection each, taken SERIALLY.** A
  Postgres connection is bound to one database, so the admin connection cannot
  read a tenant's hint however it is qualified. Serial keeps a pass at one extra
  connection at a time however many apps exist. The SAVEPOINT per tenant is gone
  with the shared transaction and so is its reason: a read that throws now takes
  down a connection nothing else is using, so one broken tenant cannot deny
  every later one its wake. The candidate filter changed too — the old catalog
  query is per-database now, so the cheap filter is the `app-db:` credential
  itself, read for the fleet in one query over the same Vault view the sweeps use.

**Each tenant's read sits in a SAVEPOINT, and that is not tidiness.** The hint
table is tenant-owned, so a dropped, reshaped, or hugely-grown one makes that
read fail — and a failed statement aborts the whole transaction, which without a
savepoint means the first broken tenant costs EVERY later tenant its wake in the
same pass: a cross-tenant denial of the only mechanism a parked run has.

**Two things it does not cover, both inherited.** Apps on an extra
`APP_DB_URLS` cluster are not swept — those pool their own connections, which
the fleet budget cannot afford (`platform-db-budget.test.ts` fails for one extra
target), so there are none, and boot WARNS naming the gap. And a step lost with
its container stays lost for graphile-worker's 4-hour job expiry, since no other
worker may claim a locked job before then — any boot for another reason repairs
it sooner, because the Postgres world re-enqueues active runs on `start()`.

**The guest half is a lifecycle change too**: in-flight workflow callbacks count
as busy for both the idle window and a drain (`packages/aai-guest/CLAUDE.md`).
Without that a wake buys at most one idle window of progress — the woken guest
has no session, so it would exit mid-step.

### The workflow API is brokered too — `/:slug/workflows/*`

`workflow-handler.ts` (its module doc carries the full argument). The route
exists because of WHO calls it: a WORKFLOW APP (`agent({ page: "static" })`) is
served at `GET /:slug/` and its page builds every URL from `location`, so the
calls land HERE — `createWorkflowApi` has no broker step and must not, since a
tunnel URL changes on every respawn while the page holding a `runId` does not.
Without it every request falls through to `app.notFound` and reads as a failure
of the feature. Shaped like the first routing point: broker and forward,
streaming the body, with `brokerSessionUrl`'s taxonomy. Three decisions:

- **PUT and DELETE too**, off `GUEST_ROUTE_EXPOSURE.workflows` — `cancel` is a
  DELETE, `uploadStream` a PUT, and a platform serving only GET and POST 404s both
  on a DEPLOYED agent while the page works under `aai dev`. Each shipped once;
  that file's comment carries both.
- **The timeout bounds the response HEADERS, not the body**, because
  `GET /runs/:id/events` legitimately holds a stream open for minutes; that
  stream also registers with `live-streams.ts`.
- **Per-IP limits run BEFORE the handler**, so a refused request never brokers:
  a surface limit sized for a POLLING page plus a tighter one on `POST /runs`
  counted IN ADDITION — the one route whose cost OUTLIVES its request.

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

This replaced `aai_platform.sandbox_registry`, a lease table the owning replica
heartbeated every 10s. With it went the heartbeat timer and its per-tick ownership
re-check, the pg_cron sweep for crashed replicas' rows, `replicaId` on the agent
path, and the accepted **stale-lease window** — that design could hand out a dead
peer URL for up to one lease after a crash. A name is released when the sandbox
stops, so `fromName` cannot return something that is not running.

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
and `packages/aai-server/adversarial/` (plus the `load-and-adversarial` CI job
and `docker-compose.load.yml`) were deleted, because what they asserted had
drifted away from what they claimed to test. The two "adversarial" tests
deployed an agent whose tool body spun forever **and then never invoked it**,
so both amounted to "an idle server stays under 90% memory"; `lru-eviction`
configured `MAX_SLOTS`/`SLOT_IDLE_MS`, neither of which exists (testcontainers
passes unknown env vars through silently, so it stayed green while testing
nothing); three more were benchmarks with `.test.ts` extensions whose only
assertions were `results.length > 0`, one of which imported no aai-server code
at all; and `sandbox-storm` passed on `aliveCount > 0`, i.e. 1 of 14 sandboxes
working. Two were real (`connection-flood`, `kv-corruption`) and not worth an
8-minute Docker job in the required gate, where a wall-clock memory threshold
on a shared runner blocks merges when it flakes.

If you reintroduce load or chaos testing, the bar is: **the hostile code must
actually execute** (put it at the bundle's top level so the boot-time load
triggers it — no LLM needed), the thresholds must be tied to constants the server
really reads, and it belongs outside the merge gate. Note also that a
successful WebSocket upgrade proves nothing about the sandbox:
a client can hold an open `/session` socket to a guest whose runtime
failed to build (it is accepted, then closed 1011), so `opened.length === 1`
can hold while every sandbox fails.

## Testing this package

### Building a platform request in a test

**Build a request with `authFetch`/`deploy`, not a header literal.** The
`Bearer`+`Content-Type` pair was spelled out at ~47 sites across 8 files;
they are converted, and the 28 remaining `Bearer` strings in the package are
all ones where the literal IS the subject — the bearer parser's own spec
(`_bearer.test.ts`), the `resolveBearer` cases in `middleware.test.ts`, and
header ASSERTIONS in the blob-storage / supabase-auth / warm-harness suites.
`deploy(fetch, { key, body })` is the same idea one level up, for the
`POST /deploy` shape ~40 specs restate; `deployPayload()` is `deployBody()`
as an object, for callers that re-encode it (the gzip specs). Drop to a bare
`fetch` only when the REQUEST is what a spec exercises — a missing header, a
gzipped body, a raw string — and those cases are why `deployBody` stays.

### Gating a suite on a real Postgres

**Seven scenario suites need a real Postgres, and without one they SKIP.**
That tier is the only thing in the repo that can see a driver-level bug — an
encoding that round-trips wrong, an advisory lock not held by the session that
thinks it holds it — because an in-memory fake holds JS values and cannot be
stricter than the driver beneath it. So a silent skip is the worst outcome
available, and it was the default one: `pnpm test:scenario` with no
`AAI_TEST_PG_URL` prints a green run, and CI's Linux leg would also have passed
if its `$GITHUB_ENV` export ever broke.

- `pnpm test:pg` resolves a local database (the Supabase stack on 54322, a
  server on 5432, or an explicit `AAI_TEST_PG_URL`) and runs the tier against
  it. With the stack up it ALSO shells out to `supabase status -o env` and
  exports the Supabase trio, because a port is not an arm — see "Two arms per
  store contract" above. It starts nothing itself.
- A skip ANNOUNCES itself, via `describeWithPg` (a database) or
  `describeWithStack` (the whole stack) from
  `_pg-test-utils.ts` — the one spelling for each gate, in
  place of hand-rolled copies of `PG_URL ? describe : describe.skip`.
- `AAI_REQUIRE_PG` and `AAI_REQUIRE_STACK` turn a skip into a hard failure. CI
  sets each on the leg that provides it (and `pnpm test:pg` sets them for the
  run it starts), so "the wiring broke" is red rather than quiet. Both are
  declared in the `check:scenario` task's `env` in `turbo.json` — undeclared,
  strict env mode would strip them and the enforcement would silently do
  nothing.
- **`AAI_REQUIRE_REGISTRY` is the same shape one tier up**, in `check:e2e`'s
  `env` for the same reason — see `packages/aai-cli/CLAUDE.md`.

Note vitest EXECUTES a `describe.skip` callback (it has to, to enumerate what
it is skipping), so read `pgUrl()` inside a hook or a test, never at the top of
a gated `describe` body — up there it throws during collection on a machine
with no database, which fails the file instead of skipping it.

### The missing logger seam

One known gap, found by audit and deliberately left alone because it is a
refactor in its own right rather than a fix riding along with something else —
sized, not stuck.

**`aai-server` writes to `console.*` directly** — 47 calls, 45 of them
outside `_debug-log.ts` — with no logger seam, so 39 of the repo's 86
`spyOn(console, …)` calls exist purely to keep test output quiet. The
abstraction already exists one package over — `aai/host` has a `Logger`
type and `consoleLogger` — and this package has
a partial one of its own in `_debug-log.ts`. The work is to give the
package a single injected (or module-swappable) logger and convert the call
sites, after which the silencing spies delete themselves. It has been left
alone because it touches ~25 files and changes production log wiring, which
should not land inside a test-quality change.
