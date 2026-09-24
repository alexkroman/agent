---
summary: >-
  Platform: sandboxes + Modal backends, stateless server, security
  architecture, auth, telephony, durable-workflow routes, stores/locks
read_when: >-
  working on the platform server, its auth, stores, or a route a guest calls
---

# packages/aai-server — platform guide

The agent service plus the shared platform core (private package, a LIBRARY
with no entry point). Repo-wide conventions are in the root `AGENTS.md`; the
guest side of every sandbox is `packages/aai-guest/CLAUDE.md`; the studio
service and the composition root are `packages/aai-studio-server/CLAUDE.md`.

## Directory guides

- [`src/platform/CLAUDE.md`](src/platform/CLAUDE.md) — the per-slug mutation
  lock, connection budget and pool routing, admin pool, PlatformEvents rules.
- [`src/sandbox/CLAUDE.md`](src/sandbox/CLAUDE.md) — backend selection, slots,
  the broker, one sandbox per slug fleet-wide, the teardown rule.
- [`src/guest/CLAUDE.md`](src/guest/CLAUDE.md) — the platform→guest forward,
  route exposure, the bearer gate.

Reference siblings (read on demand): [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md)
(images, backends, microsandbox traps), [`SCHEMA-CLAUDE.md`](SCHEMA-CLAUDE.md)
(table write budget, retention), [`TRACING-CLAUDE.md`](TRACING-CLAUDE.md),
[`PLATFORM-SOCKET-CLAUDE.md`](PLATFORM-SOCKET-CLAUDE.md).

## Layout

`src/platform/` (the platform's own tables, locks, routes), `src/sandbox/`
(backend-independent lifecycle), `src/modal/` and `src/microsandbox/` (the two
contained backends), `src/guest/` (the platform's view of a guest),
`src/guest-handlers/` (every guest-called platform route — konsistent's
`guest-called-platform-routes`). At the root: the seven `*-barrel.ts` files
(this package's published surface), the handlers, the stores, and
`subprocess-sandbox.ts` (deliberately not a contained backend).

**Moving a file breaks three kinds of path reference the compiler cannot see**:
a spec reading a sibling by bare filename (`join(import.meta.dirname, "x.ts")`),
a path based on another variable rather than the file's own directory, and an
`import.meta.glob` wildcard. Grep for them after a move.

## Key files

- `orchestrator.ts` — HTTP + WebSocket routing. `orchestrator-ws.ts` answers a
  `/:slug/websocket` upgrade with a 302 to the live sandbox.
- `sandbox.ts` — one agent sandbox's lifecycle: `sessionUrl()`,
  `drain(deadlineMs?)`, `shutdown()`.
- `warm-harness.ts` — guest wiring shared by all three backends: dial-with-retry,
  stdio draining, free-port allocation, `WarmHarness` exit/cleanup.
- `modal/context.ts` — the memoized Modal client, App, harness-baked snapshot
  image (content-addressed tag) and harness bytes; a spawn racing the boot-time
  prewarm joins it. `modal/sandbox.ts` is the control-channel (studio) spawn;
  `modal/agent-sandbox.ts` the deployed-agent spawn.
- `packages/aai-guest/` — resolved here only as a built artifact
  (`aai-guest/harness` → `dist/harness.mjs`); never import guest source.
- `modal_deploy.py` — Modal deployment of this service
  (`pnpm --filter aai-server deploy:modal`); the image recipe is
  `scripts/modal_image.py` (see [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md)).
- `agent-store.ts` — `aai_platform.agents`: slug, credential hashes, worker/client
  blob hashes, and a deploy `version` that is the cross-replica invalidation
  signal. No agent description (see "The platform stores no agent config").
- `realtime-events.ts` — production `PlatformEvents` (Supabase Realtime
  `postgres_changes` on `agents` / `studio_workspaces` / `studio_chats`, plus
  the boot-time publication setup). **A channel that is DOWN is counted, not
  narrated**: `realtime-subscription-monitor.ts` tracks up/down per topic
  (drop-after-join warns, a rejoin reports the gap, down past `JOIN_BUDGET_MS`
  escalates once). `PlatformEvents.health()` reports it in `/health`'s BODY,
  never as a 503 — the causes are project-wide and every replica would leave
  rotation at once. Track *currently* down, not a high-water `joined` flag.
- `studio-paths.ts` — `isStudioPath`, the studio/agent boundary; must agree with
  `RESERVED_SLUGS`.
- `app-middleware.ts` — both apps' shared base middleware (CORS/framing).
- `rpc-transport.ts` — host↔guest JSON-RPC over WebSocket, typed per direction
  (`RpcSchema`; the sandbox link's map is `GuestRpcSchema` in `rpc-schemas.ts`).
  Results and incoming params stay `unknown`: Zod at the receiving site is the
  contract.
- `transport-websocket.ts` — also the agent's client surface (`GET /:slug/`,
  `/:slug/assets/*`, `/:slug/favicon.ico`). **The shell is `no-store`; hashed
  assets are `immutable`** — a redeploy replaces `client_files`, so a cached
  shell would reference assets that now 404, and this surface has no
  stale-build reload.
- `rate-limit.ts` — the shared fixed-window limiter (memory + Postgres, one
  atomic upsert per check, so a limit holds platform-wide). Mechanism only;
  every window is the studio's (`aai-studio-server/src/CLAUDE.md`, "Rate limits").
- `client-ip.ts` — the rate-limit key reads the **last** `X-Forwarded-For` entry
  (our proxy's hop); the leftmost is client-supplied. `public-origin.ts` reads
  the FIRST entry and is right to — it wants what the browser saw.
- `_semaphore.ts` — counting semaphore with a bounded wait; caps concurrent
  deploy-body buffering (`DEPLOY_BODY_CONCURRENCY`, sized in `constants.ts`).
- `tracing.ts` — OTLP export ([`TRACING-CLAUDE.md`](TRACING-CLAUDE.md)).
- Workflow queue, webhook, workflow API, telephony, auth and upload modules are
  covered under "Security architecture" below.

## Stores, blobs and sweeps

- **`bundle-store.ts`** — content-addressed immutable blobs
  (`blobs/<sha256>`, worker + client files) committed by the agents-row upsert,
  the deploy's ATOMIC publish point. Blob reads and writes retry transients
  (content-hash key + `upsert` makes a retry byte-identical).
  - Writes overlap with a width we choose (`DEPLOY_BLOB_CONCURRENCY`, a worker
    pool) — not an unbounded `Promise.all`, and not `_semaphore.ts`, whose
    bounded wait would silently skip a blob the row is about to reference.
  - Caches are read-through, and cold-replica bursts are collapsed by
    `createSingleFlight` (`_memo.ts`), which retains nothing. `invalidate`
    **drops the row and version flights** so a post-mutation caller never joins
    a pre-mutation read. The release runs **out of band** (`then(release,
    release)`, never an awaited `.finally`) — an extra microtask is observable
    by `sandbox/resolve.test.ts`'s fixed drain.
- **`blob-storage.ts`** — Supabase Storage via `@supabase/storage-js` in
  production (same `SUPABASE_SERVICE_ROLE_KEY` as Realtime), memory in
  dev/tests. Surface is `getItem`/`setItem`/`signedUrl` only. **A 404 MUST
  resolve `null` and any other failure throw** — the bundle store caches misses
  and retries failures, so conflating them makes a live deploy read as absent.
  - **`SUPABASE_SERVICE_ROLE_KEY` must be a secret key (`sb_secret_…`)**; boot
    refuses an anon-authority one (`assertServiceRoleKey` in `_boot.ts`, called
    once from `buildServiceConfig`; its doc has why).
    `SUPABASE_PUBLISHABLE_KEY` (browser sign-in) is separate and stays
    publishable.
  - **`assertBucketPrivate` refuses boot on a misconfigured bucket and only
    warns on an unreachable one** — the bucket lives in the dashboard, not in
    migrations, but failing boot on a Storage blip would stop every container.
  - **No referrer may delete a blob; the SET of referrers may.**
    `aai-sweep-blob-gc` (pg-cron) mark-and-sweeps: the live set is every
    `worker_hash` plus every `client_files` value.
- **`upload-bytes.ts` / `upload-handler.ts`** —
  `PUT/GET/HEAD /:slug/uploads/:id/:offset`, one window of a workflow upload, in
  the same bucket under `uploads/`. This is safe only because the blob GC's
  first arm filters `name like 'blobs/%'`; **anything else put in this bucket
  owes the same check.** A second arm reclaims `uploads/%` whose
  `(slug, id)` has no `workflow_uploads` row: it deletes only fully-parsed keys,
  has its own empty-table guard, and waits `UPLOAD_ORPHAN_GRACE` (3 days,
  because `create` writes bytes before the row). The table cascades on agent
  delete, so `deleteAgent` does not grow a step.
- **`deploy.ts` / `delete.ts`** — a delete is `deleteAgentResources`: a slug lock
  around `store.deleteAgent(slug)` (agents row + `agent-env:<slug>` secret).
  **A delete whose external step fails must FAIL (503), never warn and
  continue** — keep this for any future external teardown step.
- **`secret-store.ts`** — `SecretStore`: Supabase Vault
  (`createVaultSecretStore` over `SUPABASE_DB_URL`) in production, memory in
  dev/tests. Holds `agent-env:<slug>` and `PLATFORM_STORAGE_KEY_SECRET`
  (legacy `app-db:<slug>` rows are written and swept by nothing). **`put`
  absorbs a lost create race**: a `23505` is retried as an update exactly once
  (account paths are not slug-locked). Read the SQLSTATE, never the message.
  Vault encrypts at rest; there is deliberately no app-layer encryption.
- **`pg-cron.ts`** — janitorial sweeps as pg_cron jobs, installed idempotently
  at boot. Rules:
  - **Boot DIFFS**: every `aai-sweep-*` job in `cron.job` that
    `platformCronJobs()` no longer declares is unscheduled (`cron.schedule`
    upserts by name, so a deleted job would otherwise keep firing).
    `platformCronJobs()` is the whole truth.
  - Per-app jobs use `cron.schedule_in_database`, and their name prefix must
    stay **disjoint** from `aai-sweep-*` or boot unschedules them
    (`_session-state-sweep.ts`).
  - The orphan-preview reap takes **the same advisory lock a deploy takes**
    (`pg_try_advisory_xact_lock` shares `withSlugLock`'s lock space), and its
    duplicated delete path is guarded by `pg-cron-delete-parity.test.ts`, which
    fails if `deleteAgent` grows a step the SQL body lacks.
  - The blob GC deletes through the Storage API via `pg_net` (deleting the
    `storage.objects` row orphans the object), with the credential read from
    Vault at run time, never interpolated into the job command. **It refuses
    to run when `aai_platform.agents` is EMPTY**, and its grace window is a day
    (past the drain and the signed URL TTL).
  - `pg-cron.scenario.test.ts` executes every sweep body against a real
    database; `pg-cron.test.ts` only checks the string reached `cron.schedule`.
  - `dblink` and the `aai_admin` schema are dropped
    (`20260827030000_drop_dblink_admin.sql`); do not re-add an unused
    capability that can connect to any reachable Postgres.

## The platform provisions no tenant database

**A tenant gets no database from the platform.** An author who wants one sets
`DATABASE_URL` in their own secrets; `sandbox/resolve.ts` overlays nothing.
The durable state is the platform's, reached over HTTP with the sandbox's own
bearer: workflow runs (queue, storage, streamer as `aai_platform` tables; the
guest world is `workflow/platform-world.ts`), turn-level durability
(`session_slots` / `session_events`), and upload records (`workflow_uploads`,
`platform/uploads.ts`). **A guest keeps nothing durable on disk** — scratch
only; `platform/uploads.ts` has the account and its tripwire.

If a Postgres tenant boundary is ever needed again, the shape is a database per
app with a per-app login role and `CONNECT` revoked from `PUBLIC`. The DevKit
needs `workflow` and `graphile_worker` as database-level schemas, which is why
the platform world runs them on the PLATFORM's database. Legacy app databases
and `app-db:<slug>` secrets are NOT dropped automatically — an operator's call
with a backup; never delete the secret while the database survives
(`20260827030000_drop_dblink_admin.sql`).

## Two questions, two sentinels

**`SUPABASE_DB_URL` decides where platform state lives; `AAI_LOCAL_DEV=1`
decides whether tenant code gets a real boundary.** They are independent.

| Question | Sentinel | Set | Unset |
| --- | --- | --- | --- |
| Where is platform state? | `SUPABASE_DB_URL` (`hasPlatformDb`) | Postgres/Vault/Realtime/Storage, companions REQUIRED | memory, everywhere |
| Is this a local run? | `AAI_LOCAL_DEV=1` (`isLocalDev`) | `microsandbox` backend, key verification optional, origin retained | production defaults |

- **There is no third tier** (memory stores beside real Postgres state): with a
  platform database every store is Supabase's, and `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` are required —
  half-configured is refused at boot.
- **The safe branch is the default**: an empty env gets isolation and key
  verification (`sandbox/backend.test.ts` asserts `{}`).
- **Local is no excuse**: `assertSessionModeUrl` and `assertServiceRoleKey` run
  on every tier, and dev auth is refused once a platform database is
  configured (`createStudioAuthFromEnv`).

`scripts/dev-server.mjs` supplies both for `pnpm dev:aai-server` (resolving the
stack from `supabase status -o env`, under a repo-root `.env` and the shell).
`supabase/README.md` is the setup walkthrough.

## Stateless server

No cross-request durable or coordination state lives in process — any replica
serves any request, and a restart loses only live control-channel connections
(voice sessions never pass through it). Durable state is in Supabase (Storage,
Vault, Postgres); coordination is in the same Postgres. Stateless does not mean
every byte flows through a replica: the guest fetches its own bundle from a
signed URL. Platform-table traffic from guests does cross a replica, bounded in
`platform/_route.ts`. The lock, connection budget and pools are in
[`src/platform/CLAUDE.md`](src/platform/CLAUDE.md).

**Where we differ from Supabase's own recommendations** (`postgres_changes`
over Broadcast, deny-all RLS on an ungranted schema, IPv4/IPv6 and legacy key
forms) is in `supabase/README.md`. Read it before adding a watched table, a
table without RLS, or a publication column list.

Session resume needs no cross-replica store: a `?sessionId=` reconnect
re-brokers via `GET /:slug/client-config`, and a replacement guest recovers slot
state from the platform tables; `_session-state-sweep.ts` reclaims a dead
guest's leftovers.

Deliberately in-process: the slot cache and resident sandboxes (an
accelerator; the agents change stream keeps them correct), TTL-bounded or
content-hash-keyed caches (staleness documented at each site), and the
in-process workspace/slug mutexes kept *under* the distributed ones.

### Two arms per store contract, and the stack is the only real one

Memory/Postgres equivalence is asserted: one case list per contract in
`store-conformance-cases.ts` (registry `store-conformance.ts`), run over the
memory arm in unit suites and over the local Supabase stack in the
`*store-conformance.scenario.test.ts` files (`describeWithStack`,
`pnpm test:pg`).

- An arm is legitimate only if something really runs on it: memory and the
  stack are; a stock Postgres is not (no Vault, pg_cron, walrus).
- The fake `SqlExec` is a recorder with its own spec, not an arm.
- A case is arm-independent: fresh keys from `uniqueKeys`, never literals.
- **A case REMOVES what it wrote**, per case (a claimed queue job is invisible
  to a suite-level drain and would be delivered later by a dev server).
- **Register the pair or the gate fails**: `store-conformance-registry.test.ts`
  (a text scan) refuses an unregistered `createPg*`/`createMemory*` pair, a
  stale name, or a contract not run from BOTH a unit and a scenario file;
  `conformance: false` must say why.
- `ensurePlatformTables` verifies a CLI-built database against
  `supabase_migrations.schema_migrations` and names the pending files.

## Two packages, ONE deployment (aai-server / aai-studio-server)

`aai-server` is the agent surface plus the shared core; `aai-studio-server` is
the studio surface AND the composition root, whose entry every deployment runs
(`pnpm dev:aai-server` included). The composition is documented in
`packages/aai-studio-server/CLAUDE.md`, "One deployment, two packages".

**Not merging, deliberately — defend the SEVEN barrels** (`./stores`,
`./sandbox`, `./platform`, `./http`, `./config`, `./logger`, `./test-utils`).
`platform/surface.test.ts` fails on an entry nobody imports and on a module the
studio reaches that no entry names. Widening the surface is a deliberate
`package.json` edit; if the map starts growing for convenience, the answer is
the merge, not an eighth barrel. (This package uses vitest **forks**; the
studio uses threads.)

- **A resolved public origin may be used WITHIN the request that asked for it
  and never stored for a later one** — `Host` / `x-forwarded-*` are
  caller-written ("Durable workflows" has the shipped instance).
- **Deploy and delete move sandboxes; a secret change does not** — see
  `src/sandbox/CLAUDE.md`.

## The local backend is a microVM

`microsandbox/sandbox.ts` boots the guest in a libkrun microVM from the SAME OCI
image production pulls. `pnpm build:guest-image --msb` builds it — **a harness
edit is not live until that has run** (`packages/aai-guest/CLAUDE.md`).
`pnpm --filter aai-server test:scenario` runs the real-microVM tier, which
skips without hardware virtualization (`AAI_REQUIRE_MICROSANDBOX=1` fails
instead). Its traps are in [`MODAL-CLAUDE.md`](MODAL-CLAUDE.md).

## A new guest route must declare how the PLATFORM exposes it

Use the `expose-guest-route` skill (`.claude/skills/expose-guest-route/`): the
four exposure kinds in `GUEST_ROUTE_EXPOSURE` (`src/guest/routes.ts`), the
`guest/routes.test.ts` parity test, `guard-invariants` rule 12 and the
`guest-route-exposure` konsistent convention. Exposure is decided by WHO CALLS
the route.

## The platform stores no agent config

**The deploy boundary learns NOTHING about a bundle.** `POST /deploy` takes
artifacts (worker, client files, env) and ownership (the caller's key); no
config is extracted, validated or stored, and no name is read. A slugless
deploy gets `human-id` words plus a random suffix; a caller wanting a readable
URL requests the slug. `DeployBodySchema` has no config or name field.

- The credential preflight and the import smoke test live in the CLI
  (`aai-cli/_preflight.ts`, `packages/aai-cli/CLAUDE.md`); the preflight WARNS
  because the CLI cannot see secrets already stored against the slug.
- **Re-adding a host-side view of what an agent is means re-adding trusted
  extraction** (a bundle can forge its own self-description). Decide that
  before any quota, provider block or agents list. A new column would also
  need a backfill story: existing agents carry nothing until redeployed.
- **Contract migrations go through the `RETIRED_COLUMNS` ledger** in
  `platform/schema.test.ts` (empty now — keep the mechanism). A drop cannot ride
  the release of its own expand (`supabase db push` runs before old containers
  stop), so record the owed drop there: each entry asserts no source writes the
  column and the column still exists, and is deleted in the drop's commit.

## Queryable run state is not `workflow_runs`' job

A filterable listing (status, time range, cursor, a run's steps) goes on a
projection updated OFF the write path, never on `aai_platform.workflow_runs`,
which the engine rewrites on every transition. See
[`SCHEMA-CLAUDE.md`](SCHEMA-CLAUDE.md).

## Security architecture

**The Modal container is the security boundary** — no in-process capability
stripping is relied on anywhere.

### Modal sandbox isolation

Each agent runs in its own Modal Sandbox executing the COMPLETE agent (the
runtime ships inside the worker bundle; `packages/aai-guest/CLAUDE.md`,
"User-shipped runtime"). Clients connect directly to the sandbox's `/session`
tunnel; host↔guest control is JSON-RPC over `/ws`, bearer-authenticated per
sandbox. **This describes the `modal` backend only** — `microsandbox` is a
different boundary and `subprocess` has none; the boot log names the backend.

- **Remote isolation**: no shared kernel with the host, no shared state between
  agents; the guest runs plain Node.
- **Open egress**: a tenant can reach the internet, not the platform. A
  `DATABASE_URL` in the boot env is the author's own; platform admin
  credentials never enter the guest.
- **Minimal filesystem**: the baked harness image, never the host filesystem.
- **Sessions live in the guest**; the host holds no session state.
- A deployed agent's env is a boot FILE written into its sandbox (scrubbed after
  reading); per-sandbox tokens ride the exec env; platform secrets stay
  host-side.

**Credential separation**: each agent provides its own `ASSEMBLYAI_API_KEY`
(`.env` locally, `aai secret put` in production) — **there is no
platform-owned key**. `SandboxOptions` keeps `apiKey` (host-only) apart from
`agentEnv` (forwarded). What a guest may hold, why resolution never reads
`process.env`, and the `HostCredentialEnv` brand are in
`packages/aai-guest/CLAUDE.md`, "Credential separation, and what reaches a
guest".

**Cross-agent isolation**: no shared tenant database; the platform's durable
state is reachable only via HTTP routes gated by the per-sandbox bearer and
scoped by the caller's slug SERVER-side (`workflow-run-owner.ts`, the session
state primary key, `guestSlug`). No shared mutable state between sandboxes.

**`run_code`** executes only inside the guest ("The `run_code` executor",
`packages/aai-guest/CLAUDE.md`). **SSRF**: `aai/host/ssrf.ts`; policy and
traps in `packages/aai-guest/CLAUDE.md`, "Guest network access".

### Auth

- **A raw bearer is VERIFIED against AssemblyAI before it means anything**
  (`api-key-verify.ts`, from `resolveBearer`) — the only absolute check.
  `verifySlugOwner` is relative, and `POST /deploy` plus the studio's
  project-create and session-broker have no row to check against. Rules:
  - **Ambiguity is never "valid"**: only 401/403 means "not a key"; 5xx,
    timeout, DNS or proxy errors THROW and the caller answers 503. Never fail
    open.
  - **Negatives are cached**, or the check is a traffic amplifier.
  - **Switching it off is a declaration only** (`AAI_LOCAL_DEV=1` or
    `AAI_VERIFY_API_KEYS=0`); never inferred from where state lives. Endpoint
    overridable via `AAI_KEY_VERIFY_URL`.
  - **The browser path is verified at STORAGE** (`PUT /studio/account/key`).
- **Two bearer forms, one resolution point** (`resolveBearer` in
  `middleware.ts`): raw API keys pass through; JWT-shaped bearers (browser
  sessions) are verified by the auth backend and mapped to the user's stored
  key (`user-key:<uid>`). `isJwtShaped` only routes; the backend's answer is the
  verification. A raw key also resolves a `userId` via the
  `key-user:<sha256(key)>` mapping (TTL-cached, negatives included), landing a
  linked CLI in the browser account's scope.
  - Two routes write that mapping: `PUT /studio/account/key` (onboarding,
    rotation) and `POST /studio/cli-link/approve`, which BACKFILLS it before
    storing the grant (accounts onboarded before the mapping existed otherwise
    link "successfully" into an empty key-derived scope).
  - **Neither route may REBIND a key another account holds** — whoever writes
    the mapping decides where that CLI pushes. The PUT 409s on a foreign owner;
    the approval leaves a foreign mapping alone and links anyway. Same-uid
    re-saves stay idempotent.
- **Browser sessions are Supabase Auth**, and `aai login` links an
  already-signed-in account (device-link grant). Documented with the studio:
  `packages/aai-studio-server/src/CLAUDE.md`, "Studio auth".
- **Every AssemblyAI key is user-provided**; the browser holds only a ~1h
  session token, the key stays in Vault.
- Ownership hashes are plain SHA-256 (`sha256:<hex>`, `secrets.ts`),
  constant-time compared — deliberately not a password hash (keys are
  high-entropy). No legacy hash fallbacks.
- Deploys go through `POST /deploy` only (slug in the body) and check ownership
  whether the slug was requested or generated — a generated collision is 409,
  never an overwrite.
- **Server-generated names come from one generator** (`slug-generate.ts`):
  readable base + random base36 suffix. Only studio project creation supplies a
  base (`projectBaseFromPrompt`); clients never generate names.
  **Normalization is `slugifyName` in `@alexkroman1/aai/slugify`**, shared by
  CLI, studio and server — do not add a local slugifier.

### The guest fetches its own bundle (signed Storage URL)

A cold spawn never moves the worker bundle through this process:
`BlobStorage.signedUrl` → `BundleStore.getWorkerUrl` → `WorkerSource`
(`sandbox/vm.ts`) → `AAI_BUNDLE_URL`, and the guest hash-verifies against
`worker_hash`. The boot contract (the hash is the security argument, `null`
means "cannot sign", `guestUnderstandsBundleUrl` for pinned older guests) is
"Fetching its own bundle" in `packages/aai-guest/src/harness/CLAUDE.md`.

### A workflow upload's bytes are the PLATFORM's

A guest holds no bucket credential (a service key there is a cross-tenant read
of every upload and bundle). Bytes go through a platform route the guest brokers
(`aai/host/_upload-blobs-brokered.ts`, selected by `AAI_UPLOAD_BROKER_URL`;
`agentBootEnv` has why it is a second name). `upload-handler.ts`'s module doc
carries the argument (key derivation, public posture, reads REDIRECT, writes do
not). **The key is composed from the slug Hono matched, never from caller
input** — it must never be able to name `blobs/<hash>`.

### Telephony — `GET/POST /:slug/phone`

The route brokers the sandbox and answers with TwiML/TeXML telling the carrier
to open a media stream at the sandbox's own `/phone`; the carrier then talks to
the guest directly. Carriers do not follow WebSocket redirects, which is why
this exists instead of `/:slug/websocket`. The guest half is
`aai/host/telephony/`.

- **Whether the guest answers is the agent's declaration**
  (`agent({ telephony: [...] })`); this route never reads config to pre-empt it.
- **Cold start is answered with MARKUP, not a held request**: carriers time out
  at ~15s, so a booting agent gets `<Pause>` + `<Redirect>` within
  `PHONE_READY_TIMEOUT_MS` (8s), bounded so a broken agent hangs up.
- **Verification is enabled by the agent's own secret** (`TWILIO_AUTH_TOKEN`
  HMAC-SHA1, or `TELNYX_PUBLIC_KEY` Ed25519 with a freshness bound); an agent
  with neither is as open as `/client-config`.
- **Enablement is per AGENT, never per CARRIER** — `?carrier=` is
  caller-chosen. Once ANY carrier secret is set, an unverifiable request is
  refused, including one naming a carrier whose secret is absent.
- **The signed URL is the PUBLIC one**, composed from `resolvePublicOrigin`,
  never `c.req.url`.

### Durable workflows — `/:slug/.well-known/workflow/v1/webhook/:token`

The DevKit runs inside the guest. Of its three routes, `flow`/`step` are
`guest-internal` (loopback is their only gate; never add a platform route
without an authenticity check) and **`webhook` is proxied** because its URL
leaves the system and must outlive the sandbox.

- `workflow-webhook-handler.ts` brokers a sandbox like `/client-config` (run
  state is in platform tables, so a fresh guest resumes). A booting sandbox is
  **503 + `Retry-After`** — senders have retry loops. A forward, never a
  redirect. Auth is the token only; the body is capped
  (`MAX_WEBHOOK_BODY_BYTES`) before buffering.
- **The SDK mints the public URL**: the DevKit's `hook.url` is
  guest-local, so `agentBootEnv` sets **`AAI_PUBLIC_BASE_URL`**
  (`agentPublicBaseUrl` in `public-origin.ts`) and
  `ctx.workflows.publicWebhookUrl(token)` composes from
  `WORKFLOW_WEBHOOK_PREFIX`. Do not repoint `WORKFLOW_LOCAL_BASE_URL` — it
  steers queue dispatch and would 404 `flow`/`step`.
- **`AAI_PUBLIC_ORIGIN` is the only production source, and boot is refused
  without it** (`PLATFORM_TIER_ENV` in `_boot.ts`). An OBSERVED origin
  (`rememberPublicOrigin`) is kept in LOCAL DEV only: it comes from
  caller-written headers before auth, and storing it let one forged `Host`
  redirect another tenant's payment callbacks.

### The platform owns the queue

The queue is `aai_platform` tables with the owning slug as a column, so "which
messages are due, and whose" is one indexed query. Module docs own the
arguments; the rules:

- **Delivery is NOTIFY-driven with the interval as the timer for parked work**
  (`workflow-queue-sweep.ts`): the interval cannot go (notifications drop), an
  enqueue delayed past one interval must not notify (`announce`), and the
  listener is counted in the budget. An absence-of-notification spec needs a
  barrier channel — `vi.waitFor` on an exact count passes against an
  unconditional notify.
- **A failed delivery spends one of two budgets** (`workflow-queue-failure.ts`):
  a delivery that sent NO request throws `GuestUnreachableError` and spends
  `unreachable_attempts`; a `fetch` that throws is NOT unreachable (the guest
  may be running the step). The patient budget totals just inside
  `STALL_GRACE_MS` so reconcile follows it.
- **A tick is not gated on the previous pass** — one slow tenant step would
  stall every tenant. The bound is the replica's delivery budget
  (`workflow-queue-budget.ts`): slots taken before the claim, released per
  delivery; the claim asks for `min(maxPerTick, free slots)`; a claim that
  THROWS returns its slots. `claimDue` re-checks under the row lock, so
  overlapping passes take disjoint sets.
- Waking a sandbox on a schedule must:
  - **not resurrect a deleted agent** (candidates join the agents table;
    `brokerSessionUrl` 404s);
  - **not fight the blue-green handover** (waking IS `brokerSessionUrl`; the
    sweep touches no slot);
  - **bound wake loops per slug, per tick and per RUN** —
    `RECONCILE_MAX_ATTEMPTS` (`_reconcile-abandon.ts`) moves a run to `failed`
    via a COMPARE-AND-SET on live statuses, never over `completed`;
  - **run on one replica per tick** (transaction-scoped advisory try-lock;
    a lost lock is a silent skip);
  - **keep the pass width a constant**, not a function of app count.
- In-flight workflow callbacks count as busy for the guest's idle window and
  drain (`packages/aai-guest/src/harness/CLAUDE.md`). The engine-side lease
  rule is in `packages/aai-runtime/JOURNAL-CLAUDE.md`, "An attempt is a LEASE,
  and it EXPIRES".

### The workflow API is brokered too — `/:slug/workflows/*`

`workflow-handler.ts` (module doc has the argument). A workflow app's page
builds URLs from `location`, so its calls land here; `createWorkflowApi` has no
broker step and must not.

- Serves every method in `GUEST_ROUTE_EXPOSURE.workflows` (PUT and DELETE
  included).
- The timeout bounds response HEADERS, not the body (`GET /runs/:id/events`
  streams for minutes and registers with `live-streams.ts`).
- Per-IP limits run BEFORE the handler, with a tighter extra limit on
  `POST /runs`.
- **A deleted agent is 404 `notFoundMessage`, never 503 or 410** — including
  when the FORWARD fails (a resident on another replica can outlive the delete
  until the Realtime event arrives), so the failure path re-reads the row. See
  `src/guest/CLAUDE.md`.

### No host mode on deployed agents

Host mode (`?host=1`) is an `aai dev` feature only. Every platform session runs
the bundle's own SDK in its sandbox; `/:slug/websocket` is a pure redirect and
the platform process terminates no sessions. **Don't reintroduce an in-process
session surface** — if platform host mode returns, run it in the guest on the
bundle's runtime.

### Testing security boundaries

Isolation itself (filesystem, memory, network, env) is Modal's; no test here
covers it. `modal/sandbox.test.ts` covers the spawn flow against a fake
context; `aai-guest/harness.test.ts` the `run_code` executor; `net.test.ts` /
`ssrf-extended.test.ts` SSRF bypasses.

There is deliberately **no load or chaos tier**. If one is reintroduced:
**the hostile code must actually execute** (at the bundle's top level),
thresholds must tie to constants the server reads, it stays outside the merge
gate, and an open `/session` socket proves nothing (a guest whose runtime
failed accepts then closes 1011).

## Testing this package

### Building a platform request in a test

**Build requests with `authFetch` / `deploy(fetch, { key, body })` from
`test-utils.ts`, never a `Bearer` header literal**; `deployPayload()` is
`deployBody()` as an object. Use a bare `fetch` only when the REQUEST is the
subject (bearer-gate specs, `resolveBearer` cases, header assertions, gzip or
raw bodies).

### A suite over a FLEET-WIDE predicate owns its database

Unique slugs isolate the rows a test writes, not predicates that read every
slug (`claimDue`, `WORKFLOW_QUEUE_CHANNEL`, `findStalledRuns`). Such a suite
takes `useThrowawayPlatformDb` (`_workflow-queue-test-utils.ts`): a private
database built by `ensurePlatformTables` (never hand-written DDL, so FKs and
indexes are the shipped ones). A listener must dial the fixture's `url()`, not
`pgUrl()`. This is distinct from the `aai_test_schema_ready` sentinel (which
guards a half-built schema).

### Gating a suite on a real Postgres

Scenario suites needing Postgres SKIP without one, and a silent skip hides
driver-level bugs.

- `pnpm test:pg` resolves a database (stack on 54322, server on 5432, or
  `AAI_TEST_PG_URL`); with the stack up it also exports the Supabase trio. It
  starts nothing.
- Gate with `describeWithPg` / `describeWithStack` from `_pg-test-utils.ts` —
  never a hand-rolled `PG_URL ? describe : describe.skip`. A skip announces
  itself.
- `AAI_REQUIRE_PG` / `AAI_REQUIRE_STACK` turn a skip into a failure; both must
  stay declared in `check:scenario`'s `env` in `turbo.json` (strict env mode
  strips undeclared vars). `AAI_REQUIRE_REGISTRY` is the same for `check:e2e`
  (`packages/aai-cli/CLAUDE.md`).
- **Read `pgUrl()` inside a hook or test, never at the top of a gated
  `describe` body** — vitest executes skipped `describe` callbacks during
  collection, so it would fail the file instead of skipping.

### Every line goes through `logger.ts`

`createLogger("<namespace>")` at module scope; nothing writes to `console.*`.
It is built on the SDK's `Logger` (konsistent `platform-logger`). Specs use
`captureLogs()` (`test-utils.ts`) and assert THAT a line was written, not its
wording.

### An agent's own output — `GET /:slug/logs`

`agent-logs.ts`, read by the studio Logs pane and `aai logs`; the ring lives in
the guest. Alone among `/:slug/*` it **never boots a sandbox** (hence `running`
beside the lines, and `dropped` reported). `aai_platform.session_events` is a
platform table under deny-all RLS on the admin connection only; `discard` drops
slots only, events going to the sweep.
