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
  two backends), `describeBundle` (deploy-time bundle inspection as a
  ONE-SHOT describe-mode exec — no channel), and the studio-side
  `spawnWarmHarness` control-channel machinery
- `sandbox-backend.ts` — backend selection policy (`SANDBOX_BACKEND` override,
  production → `modal`, local dev → `subprocess`) plus the reason string
  the boot log prints, so "which backend am I on, and why" is one log line
- `warm-harness.ts` — backend-independent guest wiring shared by both backends:
  dial-with-retry, stdio draining, free-port allocation, `WarmHarness` exit and
  cleanup semantics
- `sandbox-slots.ts` — the per-slug slot cache: `{ slug, version?, sandbox? }`
  plus the slug lock. NO idle machinery — idleness is the guest's own job
  (agent-mode self-exit), and its exit detaches the slot via `onSandboxLost`
- `modal-sandbox.ts` — Modal Sandbox backend: creates remote sandboxes from
  a harness-baked snapshot image (built once per harness version, published
  under a content-addressed tag), execs the Node harness with a per-sandbox
  bearer token, and dials its WebSocket through the sandbox's Modal tunnel
- `packages/aai-guest/` — the guest the two backends spawn; its own private
  workspace package, resolved here only as a built artifact
  (`aai-guest/harness` → `dist/harness.mjs`). See
  `packages/aai-guest/CLAUDE.md`
- `modal_deploy.py` — Modal deployment of the agent service
  (`@modal.web_server` wrapping the node process);
  `pnpm --filter aai-server deploy:modal`
- `platform-lock.ts` — cross-replica per-slug mutation lock (see "Stateless
  server" below): a Postgres ADVISORY lock on a reserved connection in
  production, the in-process keyed lock in dev/tests
- `agent-store.ts` — the agents table (`aai_platform.agents`; memory in
  dev/tests): one row per agent — slug, credential hashes, the bundle's
  self-described config, content hashes of the worker/client blobs, and a
  deploy `version` that doubles as the cross-replica invalidation signal
  (see "Split services" below)
- `sandbox-resolve.ts` — slot-based slug→sandbox resolution +
  `watchAgentInvalidation`, the event-driven sandbox invalidation (split
  from sandbox.ts, which owns one sandbox's lifecycle)
- `sandbox-broker.ts` — `brokerSessionUrl`: slug → the public session URL a
  client dials, with the one failure taxonomy `GET /:slug/client-config` and
  the `/:slug/websocket` upgrade share. The platform's ONLY routing point
- `sandbox-directory.ts` / `sandbox-peers.ts` — the fleet-wide answer to "is
  some replica already serving this deploy?", which is a Modal sandbox NAME
  (`agent-<hash(slug)>-v<version>`) rather than a lease table — see "No
  horizontal sandbox scaling" below
- `platform-events.ts` — `PlatformEvents`: cross-replica change
  notifications (`watchAgents`, `watchWorkspace`, `watchChat`,
  `watchScopeProjects`) as SIGNALS (handlers re-read rows, never trust
  payloads); memory emitter + store decorators for dev/tests
- `realtime-events.ts` — the production `PlatformEvents`: Supabase Realtime
  `postgres_changes` on `aai_platform.agents` / `studio_workspaces` /
  `studio_chats` over `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, plus
  the boot-time `supabase_realtime` publication setup
- `pg-cron.ts` — janitorial sweeps as pg_cron jobs (dead rate-limit windows,
  orphaned `-preview` agents + their app database schema/role and Vault
  secrets), installed idempotently at boot. `cron.schedule` upserts by name,
  so a job DELETED from `PLATFORM_CRON_JOBS` keeps firing on any database that
  already has it — and `guarded()` makes that silent. Boot therefore DIFFS:
  every `aai-sweep-*` job in `cron.job` that the code no longer declares is
  unscheduled, so `PLATFORM_CRON_JOBS` is the whole truth about what the
  platform runs and retiring one cannot be forgotten (the hand-maintained
  retired list this replaced had exactly one failure mode — omission)
- `studio-proxy.ts` / `app-middleware.ts` — the split deployment (see
  "Split services" below): the agent service's reverse proxy to the studio
  service, and the apps' shared base middleware
- `rpc-transport.ts` — WebSocket JSON-RPC transport for host↔guest RPC.
  Connections are typed by a per-direction method map (`RpcSchema`); the
  sandbox link's concrete map is `GuestRpcSchema` in `rpc-schemas.ts`, so
  method names and outgoing request params are compile-checked at every
  call site while results/incoming params stay `unknown` (untrusted wire
  data — Zod at the receiving site is the contract)
- `transport-websocket.ts` — WebSocket transport layer
- `auth.ts` — authentication/authorization
- `credentials.ts` — credential derivation
- `bundle-store.ts` — deploy persistence: content-addressed, immutable
  blobs (`blobs/<sha256>` — worker + client files) committed
  by the agents-row upsert, which is the deploy's ATOMIC publish point.
- `blob-storage.ts` — where those blobs live: Supabase Storage through
  `@supabase/storage-js` in production (authenticated with the SAME
  `SUPABASE_SERVICE_ROLE_KEY` as Realtime — Storage has no credential of its
  own), memory in dev/tests. The surface is deliberately `getItem`/`setItem`
  and nothing else. It replaced unstorage's generic S3 driver plus a local
  override of that driver's `getKeys` (which lists the whole bucket and reads
  only the first 1000-key page): once workspaces moved to Postgres NOTHING
  lists keys, so the override guarded a call no longer made, and the
  `SUPABASE_S3_*` endpoint/region/key set was a third credential for a
  project already reachable two other ways. A miss (404) MUST resolve `null`
  while any other failure throws — the bundle store caches misses under a
  sentinel and retries failures, so conflating them makes a live deploy read
  as absent.

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
  Orphan blobs from superseded/deleted deploys are accepted (content
  dedupes; a shared blob must not die with one referrer).
- `deploy.ts` / `delete.ts` — deployment lifecycle
- `secret-handler.ts` — secret management
- `secret-store.ts` — `SecretStore` interface: Supabase Vault
  (`createVaultSecretStore`, over the `SUPABASE_DB_URL` Postgres
  connection) in production, in-memory for local dev/tests. Holds agent
  env (`agent-env:<slug>`) and app-database credentials (`app-db:<slug>`)
- `app-database.ts` — per-app Postgres schema/role provisioning in the
  platform Supabase database (`provisionAppDatabase`,
  `deprovisionAppDatabase`, `openAppDb`)
- `storage-handler.ts` — `GET/POST/DELETE /:slug/storage` (owner-auth'd)
  toggling the app's database

## Stateless server

The platform server holds no cross-request durable or coordination state in
process — any replica can serve any request, and a replica restart loses
nothing but live control-channel connections (voice sessions don't pass
through it at all). Everything durable lives in Supabase (bundles and
client files in Storage, agent env + app-db credentials in Vault, studio
workspaces/chats and per-app data in Postgres), and cross-replica
coordination lives in the same Postgres over `SUPABASE_DB_URL`.

**The schema is DECLARED, in `supabase/migrations`** — not created lazily by
the store that reads it. Every `aai_platform` store used to call a memoized
`create schema/table if not exists` on first use (`pg-ensure.ts`), which is
why pg_cron sweep bodies were wrapped in `to_regclass` guards: on a fresh
database a job could fire before its table existed. Migrations delete both,
plus the boot-time publication/grant setup. The trade is deploy ORDERING —
`supabase db push` before the deploy — and a missed migration now fails
loudly with "relation does not exist" instead of being papered over by a lazy
create that runs on whichever connection first noticed.
`platform-schema.test.ts` is the guard in both directions: every
`aai_platform.<table>` the source queries must be declared in a migration,
and the store suites assert that no store issues DDL:

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
- **Studio rate limits** (`aai-studio-server/studio-rate-limit.ts`): the
  chat and project-create windows are rows in
  `aai_platform.studio_rate_limits` (`createPgRateLimiter`, one atomic
  upsert per check), so the limit holds platform-wide instead of
  multiplying by the replica count. Fail-closed: a database error
  propagates rather than silently unmetering the LLM-proxy route. Expired
  rows are swept by pg_cron (`aai-server/pg-cron.ts`), not in-process.
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

## Split services (aai-server / aai-studio-server)

Two packages, one surface each. `aai-server` is the AGENT service plus the
shared platform core (stores, locks, epochs, sandbox machinery);
`platform-barrel.ts` is the sanctioned path to its `_`-internal utilities.
`aai-studio-server` is the
STUDIO service; its entry also hosts the `combined` composition
(`AAI_SERVICE` combined|studio — a path dispatcher over both apps, which is
what `pnpm dev:aai-server` and pre-split deployments run). Deploys are
per-service Modal apps (`aai-server-web`, `aai-studio-web`, each package's
`modal_deploy.py`). The split exists because the two workloads scale
differently — studio chat turns are LLM-bound and bursty, the agent
service's control work is light — and one container served both badly.

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

- **One public origin.** Browsers only ever talk to the agent service; in
  `agent` mode it reverse-proxies `/`, `/favicon.ico`, `/studio-assets/*`,
  and `/studio/*` to `STUDIO_UPSTREAM_URL` (`studio-proxy.ts` — streaming
  passthrough, SSE included). This is what keeps the preview iframe working:
  agent pages are served `X-Frame-Options: SAMEORIGIN`, so the studio must
  share their origin. The proxy forwards identity-encoded (drops
  `accept-encoding`) because undici's fetch decompresses bodies but leaves
  `content-encoding` headers in place. Shared base middleware lives in
  `app-middleware.ts` so the two apps can't drift on CORS/framing policy.
- **Never derive the public scheme from the request URL** — use
  `resolvePublicOrigin` (`aai-server/public-origin.ts`). Modal terminates TLS
  at its edge and forwards plain HTTP to the container (its ASGI proxy adds
  only `X-Forwarded-For`, never `X-Forwarded-Proto`), so `new URL(c.req.url)`
  is **always** `http:` in a handler, whatever the browser used. Resolution
  order: `AAI_PUBLIC_ORIGIN` → `x-forwarded-host`/`-proto` (a real proxy in
  front, including this platform's own studio proxy, which sets both *from
  this resolver*) → infer, loopback being the only `http`.

  Both places that had rolled their own cost real outages. Studio **Publish
  died on `401 Missing Authorization header` from its own platform**: the
  guest was handed `http://<public host>`, its `aai deploy` POST was
  308-redirected to `https://`, and `fetch` strips `Authorization` across a
  scheme change (different origin per the Fetch spec). The request arrived
  unauthenticated, so the CLI reported an invalid API key it had in fact sent
  correctly — and the studio proxy's own `x-forwarded-proto: http` propagated
  the same wrong answer into split mode. The bare-slug redirect
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

  **Deploy and delete are the ONLY mutations that move sandboxes.** Secret
  and storage changes write Vault and bump nothing — they take effect on
  the agent's next deploy (or whenever its sandbox is next rebuilt). That
  trade deleted the whole secret-invalidation mechanism (the old
  `aai_platform.slug_epochs` table); the documented way to apply a secret
  now is to redeploy.

  **Supabase setup this depends on lives in `supabase/migrations`**, applied
  with `supabase db push` BEFORE the code that queries it: the `aai_platform`
  schema and its tables, the watched tables' membership in the
  `supabase_realtime` publication, the `service_role` SELECT grants, and the
  `pg_cron`/`pgmq` extensions. Realtime validates channel filter columns (and
  gates row visibility) against what the subscriber's claimed role can SELECT,
  and the app-created `aai_platform` schema gets none of Supabase's default
  `public` grants, so without those grants every filtered subscribe fails with
  `invalid column for filter <col>`. Only the pg_cron SCHEDULING stays at boot
  (`schedulePlatformSweeps` via `bootstrapPlatformDb`), because the sweep
  bodies are defined in TypeScript and change with the code that owns them.
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
  `test_agent`/config extraction.
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
  replica scale-in. Both ends of the hop register: the studio's SSE pusher
  (`studio-sse.ts`) and the agent service's PROXIED passthrough of it
  (`gracefulEventStream` in `studio-proxy.ts` — `text/event-stream` only, so
  assets and JSON stay zero-copy). Ending them is also what lets
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
    seconds at best, unbounded when a guest is unreachable. Modal SIGKILLs the
    container when its stop grace lapses, so ending them *after* the teardown
    made the graceful end contingent on sandbox teardown finishing in time.
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
  bounds CALL DURATION** — not request latency. Both services therefore set it
  explicitly (`FUNCTION_TIMEOUT_SECS` = 4h on the agent app, matching
  `DEFAULT_SANDBOX_TIMEOUT_MS`; 30 min on the studio app, whose longest input
  is a cold-sandbox Publish). Left unset, Modal's default is **300s**, and it
  severed every in-process session (the old `?host=1` host mode, since
  removed) at exactly five minutes, mid-word — the client saw a bare "not
  connected" and the server logged nothing, because nothing in our code did
  it. No session runs in the server process anymore — browser voice sessions
  dial the guest sandbox's tunnel directly, and `/:slug/websocket` upgrades
  are handshake redirects — but SSE streams through the studio proxy sit
  under the same cap, so it stays pinned rather than inherited. The sandbox
  layer hit the same trap first and documents it in `modal-sandbox-env.ts`.

  **`STUDIO_FUNCTION_TIMEOUT_SECS` (30 min) is a latent split-mode hazard, not
  a live one.** It was reasoned as headroom for a cold-sandbox Publish, on the
  premise that "nothing here is long-lived by design" — true of WebSockets
  (chat streams browser→guest directly) and false of the event streams a
  browser holds open for as long as a project is on screen, which did not exist
  when the value was set. Both `GET /studio/events` and
  `GET /studio/projects/:project/events` are open for hours. It does not bite
  today only because production runs `combined`, so those routes are served by
  the agent app under its 4h. Deploying split without raising it would start
  reaping them.

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

  **Capping the streams' own lifetime was considered and rejected.** It cannot
  reduce the above — a tab close still aborts whatever stream is open — while
  `projectPayload` carries `files: workspace.files`, so every forced recycle
  re-sends the whole workspace file map to every open tab. If split mode ever
  ships, raise the ceiling rather than adding a cap under it.

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

- **The harness AND the build toolchain are baked into a snapshot image**,
  not written per spawn, in two halves that cache differently. The
  TOOLCHAIN is a native image LAYER (`toolchainImage`: a
  `dockerfileCommands` `RUN npm install` into `/opt/aai/node_modules` — the
  aai CLI bundlers plus the workspace-facing packages), so Modal's own
  layer cache serves it and a harness rebuild — every
  server code change — no longer reinstalls ~15 packages. The HARNESS needs a
  throwaway builder sandbox, because the JS SDK's `dockerfileCommands` takes
  commands with no build context and there is nothing to `COPY` a ~13 MB local
  bundle from: a sandbox started from the layer writes it, its filesystem is
  snapshotted (`snapshotFilesystem`), and the image is `publish`ed under a
  content-addressed tag
  (`aai-guest-harness:<hash(base image, harness, toolchain)>`), so every
  later spawn — and every other replica, across restarts — resolves it with
  one `images.fromName` call. A new harness build, base-image change, or
  toolchain bump mints a new tag. This is the only harness-delivery path; a
  failed build fails the spawn loudly (memo cleared, next spawn retries).
  DEPLOYED AGENTS spawn from the tag recorded on their agents row at deploy
  time (`harness_image_tag` — per-deploy pinning, so a platform upgrade
  never changes the environment under an already-deployed bundle). An
  unresolvable pin FAILS the spawn loudly — silently substituting the
  current image is exactly the untested-environment drift pinning exists to
  prevent; the operator kill switch `SANDBOX_IGNORE_IMAGE_PINS=1` forces
  the current image for every spawn when a registry loss makes that trade
  explicitly. Studio/inspect sandboxes always run the current image.
- **The harness's V8 COMPILE CACHE is baked into the same snapshot.** The
  harness is one ~13 MB bundle and every sandbox boots it cold, so V8 paid the
  same parse+compile on every spawn. The builder sandbox now runs the harness
  once in **warm-up mode** (`AAI_GUEST_WARMUP=1` — evaluates the module, opens
  nothing, exits 0) under `NODE_COMPILE_CACHE`, before `snapshotFilesystem()`,
  and `guestExecBaseEnv()` points every guest exec at the resulting
  `/opt/aai/.compile-cache`. Measured on the real bundle: **~570ms → ~345ms**,
  i.e. ~200ms off every cold voice session, studio broker call, and
  `describeBundle`, for ~1.5 MB in the image. Three things make it safe: a
  missing or stale entry is a silent MISS (the cache keys on Node version +
  file content, so a bumped base image simply misses), the warm-up is
  best-effort (a failure logs and still publishes — the cache is an
  optimization, and failing the build would take all spawning down for a
  perf tweak), and it is Modal-only, since the cache is a property of the
  baked image and the subprocess backend has no image.

  **Warm-up is a DECLARED mode, and both halves are tested, because the
  failure is invisible.** A warm-up that stops compiling the harness leaves a
  cache that is merely empty: the image builds, every guest boots, and the
  200ms comes back forever with nothing reporting it. It relied on the
  `AAI_GUEST_TOKEN` check to exit for us at first — true by accident, and it
  would silently rot the moment that check moved. So the mode is checked
  before every other mode in `main()`, and `modal-harness-image.test.ts`
  pins BOTH sides: the host asks for the warm-up before snapshotting (fake
  Modal), and the real built harness honours it with no token (real spawn).
  Note the fake sandbox had no `exec` at all when this landed, so the
  host-side assertion had to be added with it — without `exec` the warm-up
  threw into its own best-effort catch and every test stayed green.

- **The guest toolchain is LOCKED, and the lock is committed**
  (`packages/aai-guest/toolchain/{package.json,package-lock.json}`, regenerated
  by `pnpm sync:guest-toolchain`, gated by `pnpm check:guest-toolchain` in
  `scripts/check.sh` AND the CI check job). Without it the resolved tree is a
  function of WHEN the layer was built, while the published tag and Modal's
  layer cache both key on the install command's TEXT — so one
  `harness_image_tag` could mean two different trees, the exact opposite of
  the per-deploy environment pinning the tag exists for. The install is
  therefore two steps, and the split is forced:
  - **Third-party packages: `npm ci` against the committed lockfile.** Their
    versions and integrity hashes are known at commit time, and this is where
    nearly all the transitive surface lives (vite/rolldown, typescript,
    vitest, react, tailwind). `npm ci` also refuses to run when the manifest
    and lockfile disagree, so a hand-edited manifest fails the BUILD.
  - **`@alexkroman1/*`: `npm install` at exact resolved versions.** These
    CANNOT be locked here — their versions change every release, and a
    lockfile entry needs an integrity hash that only exists once the version
    is PUBLISHED, which happens after the commit that bumps it. Their own
    dependencies (the provider SDKs) therefore still resolve at install time;
    closing that residual gap needs a post-publish regeneration step, not a
    lockfile in this repo.

  Both files are written by the RUN itself, gzipped and base64'd (~20 KB), for
  the same reason the harness cannot be `COPY`'d: `dockerfileCommands` carries
  no build context. The image TAG hashes the lockfile's content, not the
  manifest's — the manifest names direct versions, the lockfile names the whole
  tree, so a purely transitive change still mints a new tag.
  Only the Modal backend needs this: the subprocess backend's harness runs
  from `packages/aai-guest/dist/` and resolves the toolchain through
  aai-guest's own `node_modules` — the same walk-up shape as `/opt/aai`, with
  nothing to build or mount. The `workspace-build-integration.test.ts` suite
  keeps the path covered on any runner by spawning the harness there directly
  and publishing through the real CLI to a real listening orchestrator.
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

  **BOTH Modal apps set the burst range in their image env** — the agent
  app's guest-sandbox resources block (`aai-server/modal_deploy.py`) and
  the studio app's (`aai-studio-server/modal_deploy.py`). The studio spawns
  its own sandboxes (coding-agent sessions, Publish, config extraction),
  whose `test_agent`/Publish builds are exactly the workload the cap exists
  for — for a while only the agent app set the range, so studio-spawned
  sandboxes ran on Modal defaults. Keep the two blocks' values in lockstep
  unless the divergence is deliberate.
- **Every sandbox is tagged with a `role`** (`sandbox-role.ts`: `agent`,
  `preview`, `studio`, `studio-publish`, `inspect`) plus the `slug`
  (studio sandboxes carry the project name), so the Modal dashboard can tell
  a production voice agent from a preview deploy, a studio coding-agent
  session, or a bundle inspection. Every spawn knows its identity at
  creation. Observability only: nothing
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
  (`prewarmModal(harnessPath)` in modal-sandbox.ts, called from
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
  (`GUEST_READINESS_PROBE` in modal-sandbox.ts): every guest sandbox is
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
- **Transport**: STUDIO/INSPECT guests get a WebSocket control channel the
  host dials through the sandbox's Modal tunnel (`encryptedPorts: [8080]`;
  JSON-RPC on `/ws`) once the probe reports ready — the dial's retry
  (`GUEST_DIAL_TIMEOUT_MS`) stays as a backstop rather than the discovery
  mechanism. AGENT guests get NO channel — readiness is the probe, and the
  host probes `/manage/*` over plain HTTPS. Both are authenticated by a
  per-sandbox bearer token minted at
  spawn and delivered via the EXEC's env (never the sandbox's). The tunnel
  URL is public; the token is what keeps the managed surfaces from being an
  open door.
- **Guest sandboxes are NOT region-pinned — capacity beats locality.**
  `MODAL_SANDBOX_REGION` (comma-separated for multiple) still pins placement
  via Modal's `regions` create param, but it is an operator override that
  production leaves unset; `build_image` (scripts/modal_image.py) deliberately
  bakes no value, and each app's `REGION` constant now pins only its own
  containers.

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
- **Orphan cleanup differs per mode.** STUDIO/INSPECT guests: the host's
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

## Deploy-time credential preflight

**`missingCredentials` in `deploy.ts`.** The classic dev/prod credential
failure — an agent that ran locally on shell-exported keys dies at first
session start after deploy with what looks like a provider outage — is caught
at the deploy boundary instead. The required key set is derived from the
bundle's
self-described config (never from anything a client sent):
`requiredProviderEnvVars` over the stt/llm/tts/s2s descriptors (the same
registry-backed derivation the runtime resolves keys with) plus the agent's
declared `requiredEnv` (an `agent()` field for custom keys tools read from
`ctx.env`, which no static derivation can see). A key whose merged stored
value is absent or empty fails `POST /deploy` with a 400 naming the keys
(`credentialPolicy: "require"`, the default). The studio deploys with
`credentialPolicy: "warn"` instead — it has no secrets UI, so a hard failure
would leave its user with no path to publish at all; the warning rides back
on the deploy response. The check runs before any side effect, so a rejected
deploy leaves the live sandbox untouched.

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

### Platform sandbox

Agent code runs in **per-agent Modal Sandboxes**. Key files:
`packages/aai-server/sandbox.ts`, `sandbox-vm.ts`, `modal-sandbox.ts`,
`aai-guest/harness.ts`, `rpc-transport.ts`.

**Isolation layers:**

- **Filesystem**: the baked harness image. No host filesystem access.
- **Network**: open egress (the container is the boundary); ctx.db connects
  directly on the app's own scoped role — platform admin credentials stay
  host-side.
- **Memory/CPU**: Modal per-sandbox limits; separate container per sandbox.
- **Env vars**: a deployed agent's env is delivered as a boot FILE written
  into its own sandbox (scrubbed after reading); per-sandbox tokens ride
  the exec env. Platform secrets stay host-side.

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

**`run_code` built-in tool (`aai-guest/trial.ts`):**

- Executes **only inside the guest sandbox** (Modal/Node): the harness wires
  its in-sandbox executor into the runtime as `RuntimeOptions.runCode`
  (`run_code` is in `SANDBOX_ONLY_BUILTINS`). The old host-side `node:vm`
  execution was removed — `node:vm` is not a security boundary; the Modal
  container is.
- The host-side `execute` (`builtin-run-code.ts`) is a guard for the
  self-hosted path (`aai dev`), which has no sandbox — it refuses rather
  than evaluating attacker-influenceable code in the host process.
- The executor is a bare `new Function` async wrapper: code runs with the
  **same authority as the rest of the sandboxed agent** — open egress,
  filesystem, env, child processes — and nothing more. There is deliberately
  no in-process capability stripping; the container is the whole boundary.
  (This is why the tool description promises only "output from console.log",
  not "no network/filesystem" — that claim would be false now.)
- 5-second execution timeout (enforced in the guest).

**SSRF protection (aai/host/ssrf.ts):**

- Lives in the SDK, not `aai-server`, so both the platform's guest-fetch proxy
  and the SDK's own network builtins resolve one implementation.
- `resolveAndAssertPublic()` uses the `bogon` library for private IP ranges.
- Handles IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`).
- Blocks `.internal`, `.local`, cloud metadata hostnames, and non-HTTP(S)
  protocols.
- Re-validates every redirect hop and strips credential headers once a redirect
  leaves the original origin.
- Pins the validated IP with an undici dispatcher `lookup` rather than
  rewriting the URL hostname. Rewriting broke TLS — SNI and cert verification
  use the URL, not the `Host` header — so every `https://` request failed. Keep
  the URL intact when touching this.
- **The dispatcher and the `fetch` it is handed to must come from the same
  undici.** `pinnedDispatcher` builds an `Agent` from this package's `undici`
  dependency, while `globalThis.fetch` is backed by the copy bundled into the
  Node runtime (`process.versions.undici`) — a different major. undici 8
  reworked the dispatch-handler interface, so a v8 `Agent` rejects the v7-style
  handler Node's internal fetch builds, with `InvalidArgumentError: invalid
  onRequestStart method` surfacing as a bare `TypeError: fetch failed`. A
  dispatcher is attached to *every* hostname request, so the mismatch takes out
  all SSRF-guarded egress at once — `web_search`, `visit_webpage`,
  `get_page_design`, and `fetch_json`. `safeFetch` therefore routes through
  `pinnedFetch`, undici's own `fetch`; never reintroduce `globalThis.fetch`
  there. Guarded by `ssrf-dispatcher.test.ts` — the rest of the SSRF suite
  injects a fake fetch and never builds a real dispatcher, which is why this
  shipped unnoticed. Two rules survived the (since-removed) tool-egress
  guard that first hit this: **the caller may not name a fetch
  implementation** (leave `fetchFn` unset — it exists for tests — so the
  pinned default applies), and the guard test has to cover the *call site*,
  not just `pinnedFetch` in isolation.

  **The request *body* crosses the same seam, and `FormData` does not survive
  it.** undici 8's `extractBody` brand-checks each body type with an
  `instanceof` against **its own** class, so a `globalThis.FormData` (an
  instance of Node's *internal* undici's class) matches no branch, falls
  through to the string conversion, and goes out as `Content-Type: text/plain`
  with the 17-byte body `[object FormData]` — the server answers
  `415 Unsupported Media Type` and the caller sees an opaque HTTP failure.

  The rule that generalizes: **never hand a `FormData`, `Blob`, `File`,
  `Headers`, or `Request` to a `fetch` that might not be the one your realm's
  global came from** — pass bytes.
- The network builtins (`web_search`, `visit_webpage`, `get_page_design`,
  `fetch_json`) take a
  model-controlled URL and **default** to this via `safeFetch` in
  `builtin-tools.ts`. Protection is not opt-in per caller; only tests override
  the `fetch` option.

**Auth:**

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
- **Browser sessions are Supabase Auth** (`supabase-auth.ts`): GitHub
  OAuth sign-in via supabase-js (`signInWithOAuth`) in the studio client;
  the server verifies
  access tokens by asking Supabase (`GET /auth/v1/user` — no JWT
  secret/JWKS handling), TTL-cached by SHA-256(token). Configured by
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
  base36 suffix, v0-style (`contact-form-x7k2mq`). A slugless CLI deploy
  seeds the base from the agent's own `name` (its bundle-described config);
  studio project creation seeds it from the creating chat prompt
  (`projectBaseFromPrompt`); an unusable base falls back to `human-id`
  words. Clients never generate names — creation always hits the server.

### No warm pool — every spawn boots from the snapshot image

There is NO warm sandbox pool (`sandbox-pool.ts`, `SANDBOX_POOL_SIZE`, the
`pool` role, and the `setTags` retag plumbing were all deleted). Production
always ran with the pool disabled, so it was pure complexity: every spawn —
agent, studio, inspect — now boots directly from the published
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
