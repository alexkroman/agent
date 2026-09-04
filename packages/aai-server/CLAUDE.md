# packages/aai-server — platform guide

The agent service plus the shared platform core (private package). Repo-wide
conventions live in the root `CLAUDE.md`; the guest side of every sandbox is
in `packages/aai-guest/CLAUDE.md`, and the studio service in
`packages/aai-studio-server/CLAUDE.md`.

## Key files

- `tracing.ts` — OTLP export ([`TRACING-CLAUDE.md`](TRACING-CLAUDE.md))
- `orchestrator.ts` — HTTP + WebSocket routing
- `sandbox.ts` — agent sandbox lifecycle: `sessionUrl()` (the public tunnel
  endpoint the broker hands to clients), `drain(deadlineMs?)` (retirement's
  one request), `shutdown()`. DEPLOYED AGENTS RUN AS SERVERS — the host
  holds NO channel to them (see `packages/aai-guest/CLAUDE.md`, "Agent guests
  are servers")
- `sandbox-vm.ts` — `spawnAgentServer` (the agent-server dispatch over the
  three backends) and the studio-side `spawnWarmHarness` control-channel
  machinery
- `sandbox-backend.ts` — backend selection policy (`SANDBOX_BACKEND` override,
  production → `modal`, local dev → `microsandbox`, `subprocess` opt-in) plus
  the reason string the boot log prints, so "which backend am I on, and why" is
  one log line
- `microsandbox-sandbox.ts` / `microsandbox-network.ts` — the local microVM
  backend; see "The local backend is a microVM" below
- `warm-harness.ts` — backend-independent guest wiring shared by all three:
  dial-with-retry, stdio draining, free-port allocation, `WarmHarness` exit and
  cleanup semantics
- `sandbox-slots.ts` — the per-slug slot cache: `{ slug, version?, sandbox? }`
  plus the slug lock. NO idle machinery — idleness is the guest's own job
  (agent-mode self-exit), and its exit drops the whole SLOT via
  `onSandboxLost` — not just its sandbox, which grew the map by one shell per
  slug for the container's life; a rebuild needs nothing from an empty slot.
  **A plain `Map`, and `withSlugLock` is the exclusion** — `SlotCache`'s own
  doc has the argument
- `guest-forward.ts` — the one platform→guest forward (`forwardToGuest`) and
  its header policy, shared by the three routes that proxy into a tenant's
  sandbox (`/client-config`, `/:slug/workflows/*`, the durable-run webhook),
  which had re-derived it three times with three different filters. **A header
  crossing this hop reaches TENANT CODE**, so `Cookie`, `Authorization` and
  `X-Forwarded-*` never do. **Every direction is an allow-list except the
  webhook's REQUEST**: a sender's `Stripe-Signature`-class headers cannot be
  enumerated, where its RESPONSE (`content-type`, `retry-after`) is read by a
  sender wanting a status and a type. Its doc argues that asymmetry.

  **A route forwarding a STREAMING request body needs `bound: "activity"`; the
  other two bound the response HEAD, so a guest that answers only after
  consuming the whole body has the entire upload inside its deadline** —
  `POST /workflows/uploads` did, and a 500 MB upload 503'd at 30.3s while
  working under `aai dev`, which has no forward. Its `bound` doc has the rest
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
- `workflow-queue-store.ts` / `workflow-queue-claim.ts` /
  `workflow-queue-sweep.ts` / `workflow-queue-deliver.ts` — the platform's OWN
  durable-run queue: enqueue, ack/fail/reschedule, the claim, and the
  leader-elected pass that DELIVERS a due message to the guest owning the run.
  The CLAIM is its own module; `claimDue`'s doc has the argument. It is also the
  one thing here that boots a
  sandbox on a SCHEDULE rather than for a caller, and it brokers through
  `brokerSessionUrl` like every other caller — see "The platform owns the
  queue" below
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

  **A channel that is DOWN is COUNTED, not narrated** — and "down" means
  currently, not never-joined. realtime-js rejoins forever, so a channel that
  cannot deliver differs from a healthy one only in the rate of a warn, which is
  how it twice reached production and merely stopped invalidating sandboxes and
  pushing SSE. `realtime-subscription-monitor.ts` tracks up/down per topic: a
  drop after a successful join warns, a REJOIN reports the gap it covered, any
  channel down past `JOIN_BUDGET_MS` escalates ONCE (naming authority or
  connectivity by whether it ever joined), and `PlatformEvents.health()` reports
  it in `/health`'s BODY — never as a 503, since the causes are project-wide and
  every replica would leave rotation at once, turning a feature outage into a
  total one. A high-water-mark `joined` flag made the drop-after-join case, the
  worse one, structurally invisible.
- `pg-cron.ts` — janitorial sweeps as pg_cron jobs (dead rate-limit windows,
  archived queue jobs, unreferenced deploy blobs, runaway tenant queries,
  pg_cron's own run log), installed idempotently at boot.

  **The orphan-preview reap (`aai-sweep-orphan-previews`) IS one of them,
  again**, and that module's own doc carries why the round trip is safe: the
  two reasons it left (`DROP DATABASE` inside pg_cron's transaction, `25001`;
  and a SQL sweep duplicating a Management API step) both stopped holding, and
  with no database to drop there is no step SQL cannot perform — a reap is a
  Vault row and an agents row.

  Three properties make the move safe rather than merely possible, and each is
  asserted in `pg-cron.scenario.test.ts` against a real database:

  - **It takes the SAME lock a deploy takes.** `pg_try_advisory_xact_lock` and
    `withSlugLock`'s session-scoped `pg_advisory_lock` share one lock space and
    differ only in when they release — verified on PG 17.6 from a second
    connection, and A/B'd by bypassing the guard. A parallel lock that merely
    looked like the deploy's would exclude nothing.
  - **Cross-replica invalidation is unaffected**, because
    `watchAgentInvalidation` rides the agents table's Realtime stream, which
    decodes the WAL — and a delete from pg_cron writes the WAL exactly as one
    from the app does.
  - **The duplicated delete path is GUARDED, not argued away.**
    `pg-cron-delete-parity.test.ts` reads `bundle-store.ts`'s `deleteAgent` and
    fails if it grows a step the SQL body does not have. Without it this is the
    "leaked, out loud" shape the sweep's own history warns about: a second
    deleter that silently stops matching.

  `platformDbDsn`, `PLATFORM_DB_DSN_SECRET` and `AAI_DBLINK_HOST` went with the
  earlier move and have not come back — the body runs on the platform database's
  own connection. The `dblink` extension and the `aai_admin` schema are DROPPED
  by `20260827030000_drop_dblink_admin.sql`: nothing uses them, and an unused
  capability that can open a connection to any reachable Postgres is not
  neutral.

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

  **The writes overlap, and the WIDTH is ours rather than the caller's**
  (`DEPLOY_BLOB_CONCURRENCY`). `DeployBodySchema` permits 100 client files, so an
  unbounded `Promise.all` was up to 102 sockets at one Storage endpoint per deploy
  — and the transient codes `_retry.ts` retries (`ECONNRESET`, `UND_ERR_SOCKET`)
  are what an S3-compatible endpoint returns to a client opening far more than it
  should, so the retry was treating this fan-out's symptom. A worker pool rather
  than `_semaphore.ts`: that primitive's wait is bounded by design so a request
  path can answer 503, and a lapse here would mean silently not writing a blob the
  row is about to reference.

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
  `aai-sweep-blob-gc`'s FIRST arm filters `name like 'blobs/%'`; without that
  clause it would delete every upload in the bucket on its first run, an upload
  having no `worker_hash` to be found by. **Anything else put in this bucket
  owes the same check.** See "A workflow upload's bytes are the PLATFORM's".

  That job now has a SECOND arm over `uploads/%`, because nothing reclaimed
  those bytes at all — four paths each assumed another did, and past the 7-day
  record expiry they were unreachable as well as unreclaimed, every reader
  resolving the record before it touches a window. Its referrer is the
  `workflow_uploads` row rather than a hash set, which is the stronger claim: an
  object whose `(slug, id)` has no row cannot be read by construction. Because
  that table cascades on agent delete, a deleted agent's uploads go with it and
  `deleteAgent` does NOT grow a step — which `pg-cron-delete-parity.test.ts`
  would fail, pinning it to exactly two store calls. The arm deletes only a key
  it can fully parse, carries its own empty-table guard, and waits
  `UPLOAD_ORPHAN_GRACE` (3 days) because `create` writes bytes BEFORE the row —
  `stream` and `beginParts` do not — a gap bounded by one guest request and so
  by `SANDBOX_TIMEOUT_SECS`, whose 86,400s ceiling the grace is 3x.
- `deploy.ts` / `delete.ts` — deployment lifecycle.

  **A delete is one row and the cascades hanging off it** —
  `deleteAgentResources` is a slug lock around `store.deleteAgent(slug)`, which
  drops the agents row and the `agent-env:<slug>` secret. Nothing external has
  to answer for it to succeed.

  It also deprovisioned the app database, and the rule from that is worth
  keeping for the next external step: **a delete whose external step fails must
  FAIL (503), not warn and continue.** Warning deleted the credential record and
  the agents row while the tenant's schema and login role stayed alive, with
  nothing naming the slug. The comment claimed "a later retry can finish the
  job"; there was none.
- `secret-handler.ts` — secret management
- `secret-store.ts` — `SecretStore` interface: Supabase Vault
  (`createVaultSecretStore`, over the `SUPABASE_DB_URL` Postgres
  connection) in production, in-memory for local dev/tests. Holds agent
  env (`agent-env:<slug>`) and the platform's own Storage key for the blob GC
  sweep (`PLATFORM_STORAGE_KEY_SECRET`). A third, `app-db:<slug>`, held a
  provisioned database's credentials; nothing writes one now and a legacy row is
  swept by nothing — see below.

  **`put` absorbs a lost create race.** Read-id-then-create-or-update has a
  window, and while every per-SLUG write is serialized by the advisory lock,
  the ACCOUNT paths are not — `PUT /studio/account/key` and
  `POST /studio/cli-link/approve` can write the same name at once. A `23505`
  is retried as an update exactly once, which is sufficient by construction:
  after it the name exists. Read the SQLSTATE, never the message.

## The platform provisions no tenant database

Eleven modules used to sit here — `app-database.ts`, `app-db-*.ts`,
`app-db-admin.ts` + `supabase-management.ts` (`create database` /
`drop database` over the Supabase Management API), `storage-handler.ts`
(`GET/POST/DELETE /:slug/storage`) and `dev-management-api.ts`. All gone, with
the `aai storage` CLI command, the studio's Database card and pane, and the
`databaseEnabled` project flag.

**A tenant gets no database from the platform.** An author who wants one puts a
`DATABASE_URL` in their own secrets and it reaches the guest like any other
secret — `sandbox-resolve.ts` no longer overlays anything on top, which it did
LAST, so enabling storage silently beat whatever the author had set.

**What did NOT go is the durable state**, which is the point of the change. All
three things the app database held are the platform's now, reached over HTTP
with the sandbox's own bearer: durable workflow runs (the queue, storage and
streamer as `aai_platform` tables; the guest's world is
`workflow-platform-world.ts`), turn-level durability (`session_slots` /
`session_events`, behind the runtime's third `SessionStateBackend`), and
workflow upload RECORDS (`workflow_uploads`, behind its third `UploadRecords` —
`platform-uploads.ts`).

**A guest therefore keeps nothing durable on disk** — ephemeral scratch for
builds and the DevKit's artifact, nothing more. Uploads were the last holdout
and the interesting one: `createUploadStore` chose an upload's home from whether
the agent had a `ctx.db`, because "a database means durable runs". Moving the
queue here falsified that, so a deployed guest with no `DATABASE_URL` got
DURABLE RUNS with uploads in a directory that recycles — one sandbox filled its
filesystem and `ENOSPC`'d every write. `platform-uploads.ts` has the account,
including the write-volume measurement and the tripwire that would change the
design.

The measurable win is the connection budget — `MAX_PLATFORM_DB_CONNECTIONS` had
a tenant-scaled term, so the fleet claim grew with the one variable a constant
cannot bound. It has one term now; the numbers are under "Per-slug mutation
lock" below.

**The shape a Postgres tenant boundary has to take, if one is ever needed
again**, is the one that was here: a database per app with a per-app login role
and `CONNECT` revoked from `PUBLIC` — verified at the time, a neighbour's
database answering `42501 permission denied`. Cross-agent isolation rests on
nothing like it now; see "Cross-agent isolation" below for what it rests on.

**Four Postgres-tenancy arguments came out of those modules, and they are
recorded in `20260827030000_drop_dblink_admin.sql`** rather than here — this
guide is at its size cap and they are history about code the repo no longer has.
The one that still explains current behaviour: the DevKit needs `workflow` and
`graphile_worker` as DATABASE-level schemas, which a shared database cannot
grant a tenant (`42501`), and that is why the platform world runs them on the
PLATFORM's database.

**One operational note, not automated.** App databases and their `app-db:<slug>`
Vault secrets may still exist on a deployed fleet, and nothing here drops
either: dropping a database is an operator's call with a backup behind it, and
deleting the SECRET while the database survives strands the data with its only
credential gone — the failure `orphan-previews.ts` names.
`20260827030000_drop_dblink_admin.sql` carries the same reasoning.

## Two questions, two sentinels

**`SUPABASE_DB_URL` decides where platform state lives; `AAI_LOCAL_DEV=1`
decides whether tenant code gets a real boundary.** They are independent, and
one variable used to answer both — `isLocalDev` was `!SUPABASE_STORAGE_BUCKET`
and gated the stores, the sandbox backend, key verification, the session-mode
and service-role-key assertions, dev auth, and origin retention together.

| Question | Sentinel | Set | Unset |
| --- | --- | --- | --- |
| Where is platform state? | `SUPABASE_DB_URL` (`hasPlatformDb`) | Postgres/Vault/Realtime/Storage, companions REQUIRED | memory, everywhere |
| Is this a local run? | `AAI_LOCAL_DEV=1` (`isLocalDev`) | `microsandbox` backend, key verification optional, origin retained | production defaults |

Three things the split fixed, all of them measured on a morning it cost:

- **There is no third tier.** `buildPlatformDb` used to have a
  local-dev-with-a-database branch giving memory stores beside REAL per-app
  schemas. So `pnpm dev:aai-server` against the local stack lost every deployed
  agent on restart while its app database sat in Postgres — a published slug
  404s and nothing about the failure names the store that dropped it. **The rule
  outlives per-app databases rather than depending on them**: the workflow world
  and session state ride this same connection, so a mixture reproduces the
  identical failure with durable runs and conversation state in place of a
  schema. With a platform
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
client files in Storage, agent env in Vault, studio workspaces/chats plus the
workflow world and session state in Postgres), and cross-replica coordination
lives in the same Postgres over `SUPABASE_DB_URL`.

**Being stateless does not mean everything has to flow THROUGH the replica.**
The largest byte path deliberately doesn't: a guest fetches its own worker
bundle from a signed Storage URL (see "The guest fetches its own bundle") —
hand out a narrowly scoped capability and verify the result (a content hash)
rather than proxy the bytes. It named a SECOND path, `ctx.db` on a per-app role;
both went with per-app databases, and run storage, the queue, session state and
uploads are platform tables over HTTP now — so those bytes DO cross a replica,
bounded there (`_platform-route.ts`).

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

  **The budget counts nothing per-tenant, and the history is why that matters.**
  It carried an allowance for APP DATABASES, first excluded as "pooled" — an
  accounting error rather than a routing decision, since the pooler was
  Supavisor in SESSION mode, which multiplexes NOTHING. Counting them in was the
  correction, and the number was **two** apps at the workflow entitlement out of
  40: the bound was on the term an operator sets (`MAX_CONTAINERS`) while the
  tenant-scaled term ate 28 of the budget. And it was worst-case accounting that
  NOTHING ENFORCED — a `connection limit` is a refusal threshold, not a
  reservation, and provisioning was unbounded. Removing tenant databases removed
  the term, not merely its miscounting.

  **The ceiling is still crossed SILENTLY, because no admission control exists**
  — nothing refuses to boot the Nth guest and no pool sheds load. What an
  operator sees first is `remaining connection slots are reserved` on a platform
  read: a control-plane outage at peak.

  **It is NOT measured continuously any more.** `platform-db-pressure.ts` was a
leader-elected five-minute reading of `pg_stat_activity` per role. It is
deleted: its whole argument was the tenant-scaled term above, and with that gone
the fleet claim is a constant this file states and boot checks. Its per-role
trigger had also become near-dead weight, aimed at app roles when `postgres` —
what every platform pool connects as — carries no `rolconnlimit`.

  What that gives up, stated because it is real: Supabase's own workers share
  this instance and scale with usage, and boot measures `inUse` exactly ONCE, so
  their footprint growing afterwards is unobserved — as is a leak in one of our
  own pools.

  **Boot CHECKS the claim** (`platform-db-capacity.ts`): `max_connections` plus
  a `pg_stat_activity` count against `platformDbBudget()`. Its trap was that the
  claim depends on how the ADMIN pool is ROUTED and the check could not see it.
  Production ran with `PLATFORM_POOLER_URL` unset, so boot printed
  `capacity ok — 0 spare` one line under the warning naming the connections it
  was not counting, and the 53300 exhaustion arrived unwarned. The budget takes
  an env now and `modal_deploy.py` EXPORTS `MAX_CONTAINERS` (asserted by
  `platform-db-budget.test.ts`).
  `MAX_PLATFORM_DB_CONNECTIONS`'s doc has the rest, including why the reading is
  a FLOOR and why it never blocks boot.

  **Only the SLUG-LOCK pool is in that number, and what decides membership is
  whether a connection needs SESSION affinity.** Measured against a real
  Supavisor in transaction mode, `pg_advisory_lock` (the slug lock, held for a
  whole deploy) LOSES exclusion, while `pg_try_advisory_xact_lock` inside
  `begin … commit` is correct throughout — a transaction pooler pins one backend
  for exactly that lock's lifetime, which is what the wake sweep's and the
  pressure reading's leader elections rest on.
  `platformDbConnectionsPerReplica` carries it. So:
  - `SUPABASE_DB_URL` — direct, session mode. TWO consumers: the slug-lock pool,
    and the queue sweep's `NOTIFY` listener, on a handle of its own — it rode the
    admin pool, where a subscription establishes and then receives nothing.
    `assertSessionModeUrl` refuses a pooler here. It read THREE, counting a
    workflow world that opens none now — see `platform-db-limits.ts`.
  - `PLATFORM_POOLER_URL` — Supavisor TRANSACTION mode, for the admin pool.
    Refuses a session-mode URL, which multiplexes nothing while looking set.

  There was a THIRD, `APP_DB_POOLER_URL` (SESSION mode, for per-app databases),
  and its rule migrated rather than vanished: it had to be session mode because
  transaction pooling breaks the DevKit three ways — graphile-worker's named
  prepared statements, `world-postgres`'s `LISTEN` with no polling fallback, and
  `workflow-lock-sweep.ts`'s session-scoped advisory lock. The world runs on
  `SUPABASE_DB_URL` now, so that lands on the first bullet and
  `assertSessionModeUrl` enforces it.

  Unset, `PLATFORM_POOLER_URL` means the admin pool is DIRECT and the budget
  understates a replica, so boot announces it.
  `platform-connection-config.test.ts` pins both rules.

  **And the admin pool bounds guest THROUGHPUT, not just connections.**
  `ADMIN_POOL_MAX` reads as a connection budget and is also a concurrency limit,
  because the four guest-called platform routes — the workflow journal, the
  queue, session state, upload records — each run their work on a RESERVATION
  held for the whole request (`_platform-route.ts`'s `withReserved`). So it is
  the number of guest platform calls a replica may have in flight AT ALL, and the
  next one queues on `reserve()`.

  At 4 that was reached by ONE run: a deployed transcription workflow sustained
  ~2 `POST /:slug/workflow-journal` a second at ~840 ms of server time each, on
  a replica also serving Vault, the agents row every broker call needs, and the
  sweeps. It is 16.

  **A reservation logs the wait and then `workMs`, under one trace id** —
  `withReserved`'s doc says why it is two lines.

  **Raising it is a fact about the POOLER.** `MAX_PLATFORM_DB_CONNECTIONS`
  deliberately excludes this pool on the premise that it reaches the instance
  through `PLATFORM_POOLER_URL` in TRANSACTION mode, which multiplexes — a
  reserved-but-idle client connection pins no server backend. Under that premise
  these are cheap client-side slots. Unset, they are DIRECT session-mode
  backends: `unpooledAdminConnections` counts them into the budget and boot warns
  by name, which is what makes widening this safe rather than a landmine. The
  slug-lock pool stays direct and separate — `pg_advisory_lock` needs session
  affinity, which is the one thing that may not be pooled.

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

Two packages, one surface each, composed into a single process. `aai-server`
is the agent surface plus the shared platform core (stores, locks, epochs,
sandbox machinery), a LIBRARY with no entry point and no `build`;
`platform-barrel.ts` is the sanctioned path to its `_`-internal utilities.
`aai-studio-server` is the studio surface AND the composition root, and its
entry is the only one any deployment runs — `pnpm dev:aai-server` included, so
local dev and production are the same composition.

**The composition is documented where the composition ROOT lives, and this
paragraph is deliberately not a second copy of it: see "One deployment, two
packages" in `packages/aai-studio-server/CLAUDE.md`.** The retired split
deployment and what a revival owes, the `alwaysBundle` specifier bug, the
31-subpath shared-core `exports` map, `resolvePublicOrigin`,
`AAI_ALLOWED_ORIGINS`, the agents-row CHANGE STREAM (and why its REJOIN is
itself a signal), retirement vs. termination and the shutdown ordering are all
there.

Two rules from it that a reader of THIS package needs in front of them:

- **A resolved public origin may be used WITHIN the request that asked for it
  and never stored for a later one.** `Host` and `x-forwarded-*` are the
  caller's to write, so a use inside the request is self-directed (a caller who
  lies gets its own lie back) while one that outlives it is an injection — see
  "Durable workflows" below for the shipped instance.
- **Deploy and delete move sandboxes; a secret change does not.** Both write the
  agents row, whose `version` is the one cross-replica invalidation signal
  (`sandbox-invalidate.ts`); the way to apply a secret is to redeploy. A third
  mover, provisioning a database, is gone with per-app databases — and the rule
  it established is why `AgentRows.touch` is kept: a mutation that changes a
  guest's ENVIRONMENT without changing its code has to bump that row, or the
  resident guest keeps the env it was spawned with.

## Modal sandbox notes

**Moved to [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md)**, which already owns the images
and the sandbox backends. This guide was over the 120,000-char cap and that
section is reference — a build recipe — rather than a rule that has to be
resident.

## The local backend is a microVM

`microsandbox-sandbox.ts` boots the guest in a libkrun microVM from the SAME OCI
image production pulls, so the studio agent's `bash`/`run_code` stop running as
the server's uid and in-guest builds resolve production's `/opt/aai` toolchain.
`pnpm build:guest-image --msb` builds and loads it — **a harness edit is not
live until it has run** ("A harness edit needs the IMAGE rebuilt",
`packages/aai-guest/CLAUDE.md`) — and `pnpm --filter aai-server test:scenario`
runs the real-microVM tier, which SKIPS without hardware virtualization
(`AAI_REQUIRE_MICROSANDBOX=1` makes that skip a failure).

**Its four measured traps are in [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md)** —
`.network()` silently discarding an earlier `.port()`, a guest's `127.0.0.1`
being the VM, `isInstalled()` lying, and a name not being released when the
sandbox dies (which is a Modal property `sandbox-directory.ts` rests on and
microsandbox does not share).

## A teardown may not depend on the boot it is tearing down

`createSandbox` returns SYNCHRONOUSLY with a pending `vmReady`, so a spawn's
Modal create, boot writes and readiness probe all run OUTSIDE the slug lock the
broker took: a DELETE landing in that window completes while a guest is still
coming up. (`deleteAgentResources` no longer drops anything external — see "A
delete is one row" in Key files — but the window is the spawn's, not the
delete's, so it is still there for whatever a future teardown removes.) It
reached production as `28P01 password authentication failed for user
"app_<hex>"` out of `@workflow/world-postgres`'s migration, back when a delete
dropped the app's Postgres role first. **28P01 is also what a MISSING role
reports**, so it read as a storage-credential bug and was a lifecycle race.

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

So `GUEST_ROUTE_EXPOSURE` (`packages/aai-server/src/guest-routes.ts`) declares each
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

## Queryable run state is not `workflow_runs`' job

A filterable listing — status, a time range, a cursor, a run's STEPS over HTTP
— goes on a projection updated OFF the write path, never on
`aai_platform.workflow_runs`: that row is what the engine rewrites on every
status transition. [`SCHEMA-CLAUDE.md`](SCHEMA-CLAUDE.md) has the measured
index counts, what DBOS and Temporal each did with the same table, and what
would make this wrong.

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

**Everything below describes the `modal` backend only, so establish the backend
FIRST** — `microsandbox` is a real boundary but not this one, and `subprocess`
has none at all. Which one a run gets, and why the isolation-free one is
unreachable without an explicit declaration, is "Three backends" under "Modal
sandbox notes" above; the boot log names it.

Key properties:

- **Remote isolation**: each sandbox is its own container on Modal — no
  shared kernel surface with the platform host, no shared state between
  agents. The container is the security boundary; the guest runs plain Node
  (no language-runtime permission model).
- **Open egress**: the container is the isolation boundary — a tenant can
  reach the internet, not the platform. Tool code, `ctx.generate`, and
  provider streams dial out from the guest directly (identical to
  `aai dev`); a `DATABASE_URL` in the boot env is the AUTHOR's own (the
  platform provisions none; `ctx.db` is gone) — platform ADMIN credentials
  never enter the guest.
- **Minimal filesystem**: the guest sees the baked harness image — never
  the host filesystem.
- **Resource limits**: the burst range and bounded lifetime above.
- **Sessions live in the guest**: the embedded runtime owns per-session state
  (slot values, history, the resume grace window) exactly as the self-hosted
  runtime does. The host holds no session state; a DURABLE slot value lives in the
  tenant's own schema, on the tenant's own role.

A deployed agent's env is delivered as a boot FILE written into its own sandbox
(scrubbed after reading); per-sandbox tokens ride the exec env, and platform
secrets stay host-side.

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

**Cross-agent isolation:** there is no shared tenant database to isolate — a
database an agent reaches is one its own author configured, and the platform's
own is unreachable from a guest: the durable-state routes are HTTP, gated by the
per-sandbox bearer, and each is scoped by the caller's slug SERVER-side
(`workflow-run-owner.ts` for runs, the primary key for session state). Beyond
that, each sandbox communicates over its own authenticated WebSocket, sessions
are per-sandbox, and there is no shared mutable state between sandboxes.

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

The SERVICE image installs, then builds, with deliberately different cache keys
per half — install inputs (lockfile, workspace manifests, patch files) first, so
a doc change cannot refetch the dependency tree, and the win is COLD START
rather than deploy latency. Four things it costs to get wrong, each having cost
it once: a recipe that reads the filesystem at import crash-loops every
container while `modal deploy` exits 0; the manifests must be NORMALIZED
(`version` moves on every release, i.e. exactly when a deploy happens); a
`patchedDependencies` entry names a file that must be STAGED; and the image
bakes the server's V8 compile cache (~600ms → ~395ms cold start).
`modal-image-inputs.test.ts` pins all four.

**The full account is in [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md) beside this
file** — the four-step recipe, the 2026-08-09 outage where production served
for two hours from a container that predated the deploy, `ship.yml`'s verify
step, and why `INSTALL_MANIFEST_FIELDS` is a whitelist.

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

A deployed guest holds no bucket credential: it runs tenant code and the
bucket is platform-wide, so a service key there is a cross-tenant read of
every agent's uploads AND every agent's worker bundle. So the byte path is a
platform route the guest brokers through
(`aai/host/_upload-blobs-brokered.ts`, selected by the
`AAI_UPLOAD_BROKER_URL` boot key — a SECOND name for
`AAI_PUBLIC_BASE_URL`'s value, because that one is a claim a self-hosted
deployment also makes; `agentBootEnv` carries why). The browser sends each
window here and then tells the agent which one landed, so no upload byte
reaches a guest or a tenant database.

**`upload-handler.ts`'s module doc carries the argument** — the key
derivation, why the route is as public as `/client-config` beside it, and why
reads REDIRECT (a sixty-step fan-out would otherwise move a 200 MB recording
through this process once per run) while writes do not. Read it there; this
guide is the copy at a size cap. `aai/host/_upload-blobs.ts` has what those
bytes cost when they were `bytea` rows in the app's own database.

One thing a reader of THIS package needs in front of them: the key is
composed from the slug Hono matched and never from anything the caller sends,
because the prefix it must never be able to name is `blobs/<hash>`.

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

### Durable workflows — `/:slug/.well-known/workflow/v1/webhook/:token`

The Workflow DevKit runs entirely inside the guest (see
`packages/aai/src/host/workflow-*.ts`); this is the platform's share of the DEVKIT's
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

**`AAI_PUBLIC_ORIGIN` is the ONLY source of that value in production, and boot
is REFUSED without one** — it is baked at spawn, and one sandbox per slug
fleet-wide means a per-request mechanism would buy nothing anyway. It was
OPTIONAL until the same value became half of what a guest needs to install the
platform workflow world, at which point unset meant every durable run silently
ran on the LOCAL world instead. `PLATFORM_TIER_ENV` (`_boot.ts`) carries that
account and why none of the three can be defaulted.

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

### The platform owns the queue — and what the wake sweep had to solve

`workflow-wake.ts` is GONE, with `aai/host/workflow-wake-hint.ts` and
`_workflow-wake-read.ts`. Read this for the constraints: several are properties
of "a run outlives its sandbox" rather than of that design.

**The problem it solved.** A run's queue lived in the app's own database, and
`graphile_worker` is per-DATABASE with no tenant column — so "which of these
jobs is agent X's" was answerable only inside the process whose world it was.
Each guest reduced its whole queue to ONE timestamp, the earliest a job could be
claimed, and upserted it into an `aai_workflow_wake` table in its own database;
the platform read that column per app on a short-lived connection each.

**Why it is gone.** The queue is the platform's now, with the owning slug as a
COLUMN, so "which messages are due, and whose" is one indexed query on a
connection the platform already holds — no hint contract, no per-tenant reads,
no width bound.

**Delivery is NOTIFY-driven now, with the interval as the timer for PARKED
work** — `workflow-queue-sweep.ts`'s module doc owns the argument: why the
interval cannot be removed (a notification is dropped rather than queued), why
the coalescing runner sits behind the NOTIFY trigger, and why the listening
connection is COUNTED in the budget. Two findings to keep: an enqueue
delayed PAST one interval must not notify (a shorter park announces so the pass
can read the deadline and arm one extra look; see `announce`), and an
absence-of-notification spec needs a barrier channel: `vi.waitFor` on an exact
count passes against an unconditional notify.

**A failed delivery spends ONE OF TWO budgets, and which one is the sweep's
decision.** `workflow-queue-failure.ts` owns both and carries the argument. The
short version: `attempt` counted every way a delivery can go wrong, so the
broker answering 503 because a boot is still in flight — literally "up but not
ready" — spent the same attempt as a step that threw, and five of those inside
~380 s dropped the message. The run then waited out `STALL_GRACE_MS` before
reconcile brought it back: sixteen minutes and six sandbox boots for a condition
that was never about the message. So a delivery that sent NO REQUEST throws
`GuestUnreachableError` and spends `unreachable_attempts` on a longer table
instead. Two things not to relitigate: a `fetch` that throws is deliberately NOT
unreachable (the guest may have the message and be running the step), and the
patient budget's total is sized just INSIDE `STALL_GRACE_MS` so reconcile
follows it rather than racing it.

**A TICK is not gated on the previous pass, and that is a fix rather than a
detail.** It was: the coalescing runner sat behind both triggers, and a pass
awaits every delivery it claimed, where one delivery is bounded only by
`QUEUE_DELIVERY_TIMEOUT_MS` (60 s, because a delivery runs a tenant's step
inline). So ONE slow step anywhere on the replica stopped every other tenant's
message from being claimed for as long as it ran — measured by hand against a
dev server on the real platform path at **21.1 s** end to end for a two-step,
wait-free workflow, against **0.5 s** with the replica idle, cross-tenant. What
bounds the work instead is the replica's DELIVERY budget
(`workflow-queue-budget.ts`, which carries the argument): slots taken before the
claim, released one at a time as each delivery settles, and a tick with none
free returns before it reserves a connection. Two consequences to keep: the
claim asks for `min(maxPerTick, free slots)`, because a claim writes `locked_at`
and a message claimed beyond the in-flight bound is hidden from every other
replica for nothing; and a claim that THROWS must give its slots back, or a
replica whose database blips leaks the whole budget and stops claiming for good.
The overlap is safe for the reason the module doc already gave —
`claimDue` re-checks its predicate under the row lock, so concurrent passes take
disjoint sets.

The engine-side half of the same defect — a walk the ceiling could not stop
re-executing steps a sibling had already journaled — is fixed in
`aai-runtime/workflow-replay-step.ts`; see "An attempt is a LEASE, not a tally"
in that package's guide.

**Five properties survive**, each the answer to a way "boot a sandbox on a
schedule" goes wrong, and the queue sweep keeps all five:

- **It cannot resurrect a deleted agent.** Candidates join the agents TABLE, so
  a deleted one is not in the list, and `brokerSessionUrl` answers 404 for a
  slug with no bundle.
- **It cannot fight the blue-green handover**, because waking IS
  `brokerSessionUrl` — the one routing point, which serves a live resident
  as-is, joins a boot in flight, routes to a live PEER rather than duplicating,
  and refuses while draining. The sweep touches no slot itself.
- **A wake LOOP must be bounded three ways** — per slug, per tick, and per
  RUN. A guest that boots and cannot make progress never clears its work, so
  without a backoff it is a sandbox per interval, indefinitely. The first two
  bound a TICK's width and rate and neither bounds how many times ONE run is
  repaired, which for a while meant the pass had no end at all: nothing on the
  platform side writes a terminal status (only the guest's engine calls
  `setStatus`), so a run whose guest can never finish it was re-enqueued every
  `STALL_GRACE_MS` forever, at a sandbox boot each, and stayed a permanent
  resident of the partial index the pass reads. `RECONCILE_MAX_ATTEMPTS`
  (`_reconcile-abandon.ts`) is the third bound: past it the run is moved to
  `failed` with a reason an author can read, by a COMPARE-AND-SET on the live
  statuses — the predicate and that write are two autocommit statements, so a
  `failed` written over a `completed` would destroy real output on a stale
  read. That module carries why the count does not decay and what abandonment
  costs in a platform-wide outage.
- **One replica sweeps per tick**, via a transaction-scoped advisory try-lock on
  the reserved admin connection. Efficiency, not correctness: `brokerSessionUrl`
  is idempotent fleet-wide, which is why a lost lock is a silent skip.
- **The pass width must be a CONSTANT, not a function of the app count.** At a
  width of ONE the pass DURATION was bounded by nothing: a serial pass over a
  few hundred apps outruns a 60s interval, an overrunning pass is skipped, and
  the sweep rate halves on the only mechanism that wakes an undelivered run. The
  queue is one query now, so width bounds DELIVERIES — but that
  `MAX_PLATFORM_DB_CONNECTIONS` cannot bound a tenant-scaled number is why the
  queue is shaped this way at all.

**One thing unchanged.** A step lost with its container stays lost for
graphile-worker's 4-hour job expiry, since no other worker may claim a locked
job before then; any boot for another reason repairs it sooner, because the
world re-enqueues active runs on `start()`.

**The guest half is a lifecycle rule**: in-flight workflow callbacks count as
busy for both the idle window and a drain (`packages/aai-guest/CLAUDE.md`).
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
- **A DELETED agent is a 404 here, not the booting agent's 503**, and the route
  answered 503 at BOTH of its two exits until a user hit it. `guest-bearer.ts`
  now answers the same way for the same condition, and its docstring's defence of
  the 503 — that a 404 would disclose existence — failed twice: the oracle was
  already open one status over (`Bearer x` gives **401** for a slug that exists
  and 503 for one that does not), and the neighbouring routes disclose it
  deliberately. A redeploy cannot reach that branch either, since agent rows are
  written `on conflict (slug) do update`, so `null` only ever means gone. `503 agent
  unavailable, retry shortly` is advice a caller cannot act on once the row is
  gone: every workflow table cascades off it, so there is no run to resume and no
  sandbox that will ever answer, while the sentence spins a client's retry loop.
  It is reachable without any race — `resolveSandbox`'s fast path serves a live
  resident WITHOUT reading the row, so on every replica but the deleting one the
  broker keeps succeeding for the whole time `watchAgentInvalidation`'s Realtime
  event takes to arrive — and again as the FORWARD's own failure, which is how it
  was reported: a delete terminates the resident mid-request and the fetch dies
  with `fetch failed <- aborted`, indistinguishable from a crashed guest except
  by re-reading the row. So the failure path re-reads it (one indexed read, only
  when the forward already failed). **The answer is 404 `notFoundMessage`, never
  410**: a delete leaves no tombstone, so a deleted slug and a slug nobody ever
  deployed are the same absent row, and `Gone` would claim a history the platform
  cannot support. It is also what `brokerSessionUrlOrThrow` and
  `upload-handler.ts`'s `assertAgentExists` already answer — the bug was one
  upload loop being told "gone" by the byte route and "retry" by this one.

### No warm pool — every spawn boots from the snapshot image

There is NO warm sandbox pool (`sandbox-pool.ts`, `SANDBOX_POOL_SIZE`, the
`pool` role and the `setTags` plumbing are deleted — production always ran with
it disabled). Every spawn boots directly from the published content-addressed
harness snapshot image, one code path per backend. Do NOT reintroduce a
host-managed pool to approximate Modal memory snapshots; see
[`MODAL-CLAUDE.md`](MODAL-CLAUDE.md).

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

This replaced `aai_platform.sandbox_registry`, a heartbeated lease table (git
history has it), and the reason a NAME is stronger: it is released when the
sandbox stops, so `fromName` cannot return something that is not running —
where a lease could hand out a dead peer's URL for up to one lease after a
crash.

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

Note what none of these can assert: isolation itself — filesystem, memory,
network and env denial — is Modal's, not host code's, so no test here covers
it.

- `modal-sandbox.test.ts` — Modal spawn flow against an injected fake
  context: sandbox creation, tunnel dial + per-sandbox token, teardown on
  failure.
- `aai-guest/harness.test.ts` — the guest's `run_code`
  executor (console capture, thrown-error reporting, timeout).
- `net.test.ts` / `ssrf-extended.test.ts` — SSRF bypass prevention
  (IPv4-mapped IPv6, cloud metadata, `.internal` domains).

There is deliberately **no load or chaos tier.** `packages/aai-server/src/load/`
and `packages/aai-server/src/adversarial/` (plus the `load-and-adversarial` CI job
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
`Bearer`+`Content-Type` pair was spelled out at ~47 sites across 8 files; they
are converted, and the `Bearer` strings left are all ones where the literal IS
the subject — the bearer gate's own specs
(`_bearer.test.ts`, `guest-bearer.test.ts`), `middleware.test.ts`'s
`resolveBearer` cases, and header ASSERTIONS in the blob-storage /
supabase-auth / warm-harness suites.
`deploy(fetch, { key, body })` is the same idea one level up, for the
`POST /deploy` shape ~40 specs restate; `deployPayload()` is `deployBody()` as
an object, for callers that re-encode it (gzip specs). Drop to a bare
`fetch` only when the REQUEST is the subject — a missing header, a gzipped
body, a raw string — which is why `deployBody` stays.

### A suite over a FLEET-WIDE predicate owns its database

Slugs isolate the rows a test WRITES. They do nothing about the predicate that
READS them, and the queue's predicates are all fleet-wide: `claimDue` takes due
messages for any slug, `WORKFLOW_QUEUE_CHANNEL` carries every tenant's enqueue,
and `findStalledRuns` scans every run under an `order by created_at` and a
`limit`. Two suites over one database therefore corrupt each other's ANSWERS
while each keeps its own rows perfectly, and vitest runs files in parallel.

It was live: full scenario runs failed roughly one time in two, always in
`workflow-queue-store.scenario.test.ts`, never the same cases twice. Two
distinct mechanisms, both measured — seeding ONE stalled run under a foreign
slug fails four of its cases on its own, because `runQueuePass` reconciles that
run and every count then sees a row the suite did not write; and a sibling's
older rows can fill `findStalledRuns`'s `limit` and push a suite's own run out
of the answer, which surfaces as `expected [] to deeply equal [ 'wrun_stalled' ]`
in a suite that did nothing wrong.

`useThrowawayPlatformDb` (`_workflow-queue-test-utils.ts`) is the fix: a private
`create database`, `ensurePlatformTables` over it, `drop database` after. Both
queue suites take one, which is also what lets one of them call the fleet-wide
`reconcileStalledRuns` at all. Three things follow. The schema still comes from
`ensurePlatformTables`, never a hand-written `create table` — that is what keeps
the FOREIGN KEYS and the unique idempotency index the SHIPPED ones. A listener
must dial the fixture's `url()`, not `pgUrl()`, or it waits on a channel nobody
announces to. And this is a different fix from the `aai_test_schema_ready`
sentinel beside it: that one stops parallel suites seeing a half-built SCHEMA,
this one stops them seeing each other's ROWS.

### Gating a suite on a real Postgres

**Fifteen scenario suites need a real Postgres, and without one they SKIP.**
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

### Every line goes through `logger.ts`

`createLogger("<namespace>")` at module scope; nothing here writes to
`console.*`, and `_debug-log.ts` is gone. Built on `aai/runtime`'s published
`Logger` rather than a second interface — **that module's doc carries the
rest**. A spec reaches for `captureLogs()` (`test-utils.ts`), which replaced 25
`spyOn(console, …)` calls whose only job was keeping output quiet; assert THAT a
line was written, not its wording.

### An agent's own output — `GET /:slug/logs`

`agent-logs.ts`, read by the studio's Logs pane and `aai logs`; the ring lives
in the GUEST (see that guide's "Why the buffer lives in the guest" and "The
manage token is derived, not random"). Alone among `/:slug/*` it **never BOOTS a
sandbox** — a diagnostic that starts the thing it diagnoses answers a different
question, and a poll would keep an idle agent billable — hence `running` beside
the lines, and `dropped` reported rather than swallowed.

**The append-only GRANT on the session event log went with its per-app role** —
`grantSessionTables` held that role to `select, insert` because
`ctx.db` ran arbitrary SQL on it. `aai_platform.session_events` is a platform
table under deny-all RLS now, on the admin connection only — so no tool reaches
it. UNCHANGED: `discard` drops slots only, events going to the sweep.
