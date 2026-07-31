# Platform & third-party usage audit — scaling readiness

Goal of this audit: enumerate every platform and third-party dependency,
identify which ones scale hands-free as usage grows, and rank what would
require operator work (or would silently break) on the way to "grow and
scale infinitely without any work on my side."

Audited on the current `main` (`df753ce`). All file references are
repo-relative with line numbers as of that commit.

---

## 1. Dependency inventory

### Infrastructure (platform-owned, single account each)

| Service | Used for | Key/config | Elasticity today |
| --- | --- | --- | --- |
| **Modal** (app `aai-server-web`) | The platform web server itself (`modal_deploy.py:104-128`) | `MODAL_TOKEN_ID/SECRET` in one Modal Secret | `min_containers=1`, **no `max_containers`**, `cpu=1`, `memory=2048`, `@modal.concurrent(max_inputs=200)` |
| **Modal** (app `aai-server`) | Guest sandboxes — one per active agent slug per replica (`sandbox.ts:357-412`), plus one per studio chat request (`studio/studio-sandbox.ts:59-77`) and one throwaway per publish (`sandbox-vm.ts:158-189`) | Same tokens | Fully elastic per-sandbox; **no cap on count**, 4 h lifetime / 15 min idle reaper |
| **Modal** (`studio_build` fn) | Out-of-process studio builds (`modal_deploy.py:138-168`) | none (deliberately secretless) | Elastic, cold-start per build |
| **Supabase Postgres** | Vault secrets, studio workspaces/chats, per-app tenant schemas+roles (`index.ts:88-112`, `app-database.ts`) | `SUPABASE_DB_URL` (service role) | **One project, vertical only.** 4-connection admin pool per replica + 2 per resident app slot |
| **Supabase Storage (S3)** | Agent bundles (`bundle-store.ts`, `s3-storage.ts`) | `SUPABASE_S3_*` | Elastic; 10 MB/worker cap, no object-count concerns |
| **Pinecone** | Default vector store for every agent that doesn't BYO, namespaced by slug (`index.ts:114-121`) | Platform `PINECONE_API_KEY` + `PINECONE_INDEX` | One shared index and quota for all tenants |

### Third-party APIs (voice/LLM/tools)

| Service | Called | Key owner | Connection style |
| --- | --- | --- | --- |
| AssemblyAI S2S (`wss://agents.assemblyai.com`) | per S2S session | **tenant** (agent env) | 1 WS/session, ≤5 no-backoff resumes (`s2s-transport.ts:185-198`) |
| AssemblyAI streaming STT / TTS | per pipeline session | **tenant** | 1 WS each/session; TTS reconnects once per barge-in, unbounded, no backoff (`tts/assemblyai.ts:349-378`) |
| AssemblyAI LLM Gateway | per turn (pipeline LLM, `ctx.generate`) | **tenant** | HTTP streaming |
| AssemblyAI LLM Gateway / Anthropic | **studio chat**, up to 16 LLM steps/request (`studio-agent.ts:43`) | **platform** (`studio-llm.ts:129-175`) | HTTP streaming |
| Deepgram / ElevenLabs / Soniox (STT), Cartesia / Rime (TTS), OpenAI Realtime | per session when declared | tenant | 1 WS/session, single connect attempt, no retry (`_utils.ts:120-131`) |
| Anthropic / OpenAI / Google / Mistral / xAI / Groq / OpenRouter / Vercel gateway | per turn when declared | tenant | HTTP; AI-SDK default retry (3 attempts) |
| Brave Search | per `web_search` tool call | **platform** for studio (`studio-web.ts:31-43`); tenant for deployed agents | HTTP, no retry, 429 opaque to the model (`builtin-tools.ts:87-89`) |
| Arbitrary web (`visit_webpage`, `fetch_json`, `get_page_design`, guest `fetch`) | per tool call | n/a (SSRF-guarded `safeFetch`) | HTTP, 15 s/30 s timeouts, 4 MB response cap |

**Credential model is a genuine strength.** Provider resolution reads the
agent's own env only, never `process.env` (`resolve.ts:86-102`), so tenant
voice traffic bills to tenant keys — the deploy path seeds the caller's own
AssemblyAI key (`studio-deploy.ts:140`, `aai-cli/deploy.ts:31-34`). Per-tenant
provider cost therefore already scales to zero platform work. The
platform-shared quotas are only: studio chat LLM, studio Brave search, the
default Pinecone index, and Modal itself.

---

## 2. What already scales with no work

- **Guest compute.** Every agent's tool code runs in remote Modal sandboxes
  with `blockNetwork: true`; count is unbounded and Modal autoscales them.
  Studio Vite builds are also off-box (`studio-build-runner.ts`). Nothing
  tenant-CPU-shaped runs in the web container.
- **Tenant provider spend** bills to tenant keys (see above).
- **Bundle storage** is S3-compatible object storage with sane size caps
  (10 MB worker, 64 KB env, 40 MB inflated deploy body) and a fixed
  `getKeys` pagination bug already patched (`s3-storage.ts:6-18`).
- **Orphan cleanup is self-healing** (heartbeat + guest orphan watchdog +
  Modal idle reaper) after this failed in production once
  (`modal-sandbox-env.ts:18-44`, `guest/limits.ts:41-49`).
- **Backpressure on the audio path** is thorough: 4 MB client WS buffer
  kill, bounded audio pacer lead, 1 MB frame caps, STT send-gates
  (`ws-client-sink.ts:70-84`, `audio-pacer.ts`).
- **Graceful drain** on scaledown: 503 on `/health` and upgrades, 120 s
  drain, sandbox teardown, all inside Modal's 300 s scaledown window
  (`index.ts:206-256`).

---

## 3. Ranked risks — what breaks or demands work as you grow

### P0 — the server is architected single-replica, and nothing says so

Every piece of coordination state is process-local; there is no Redis, no
advisory lock, no shared cache anywhere. Today this works because
`min_containers=1` and load rarely forces a second container. The moment
Modal scales out (or you set `max_containers > 1`), the following degrade
**silently**:

1. **Session resume loses `ctx.state`.** Resume (`?sessionId=`) depends on
   in-RAM `stateMap` with a 120 s grace (`session-state-sweeps.ts:35-45`).
   A reconnect landing on another replica gets fresh state with no error —
   the exact bug the grace window was built to fix comes back.
2. **Secret/storage changes don't propagate.** `restartSlotSandbox`
   (`sandbox-slots.ts:72-82`) restarts the local slot only; other replicas
   serve the old env for up to 5–10 min (slot idle + worker-code TTL).
   Deploy invalidation is local too — up to **10 min of stale bundle**
   cross-replica, by documented design (`bundle-store.ts:44-49`).
3. **Per-slug locks stop excluding.** `withSlugLock`, the studio workspace
   lock, and `manifestLock` are in-process (`_keyed-lock.ts`); concurrent
   deploy/delete on two replicas is unserialized, and studio's optimistic
   versioning tolerates exactly **one** cross-replica conflict retry
   (`studio-workspace.ts:179-193`).
4. **Sandboxes duplicate.** One Modal sandbox per slug **per replica** —
   N replicas means N× guest cost for every hot agent, with N separate
   guest states.
5. **Rate limits and connection caps multiply by N.** Studio chat's
   30/5 min LLM-spend guard and `MAX_CONNECTIONS=100` are per-process
   counters (`studio-rate-limit.ts:36`, `orchestrator-ws.ts:54`).

**Direction:** either pin the fleet to one replica explicitly (set
`max_containers=1` and treat vertical sizing as the lever), or externalize
the small set of shared state (session state, slug locks, cache
invalidation bus, rate-limit counters) before allowing scale-out. Doing
neither means scale-out happens by autoscaler surprise.

### P0 — capacity of the one web container is unknown and almost certainly overstated

`cpu=1 / memory=2048` serves every session's audio pacing, JSON/Zod
parsing, NDJSON RPC, and argon2 auth. `MAX_CONNECTIONS=100` is a guess:
the two big caches alone (128 MB worker code, `bundle-store.ts:53`; 64 MB
studio builds, `studio-build-cache.ts:24-25`) plus Node heap eat a
meaningful share of 2 GB, and per-session memory footprint is unmeasured.
Modal is willing to route 200 inputs (`max_inputs=200`) while the process
RSTs everything past 100 (`orchestrator-ws.ts:76-80`) — so overload
manifests as connection resets, not scale-out.

**Direction:** load-test to find the real per-session ceiling, set
`MAX_CONNECTIONS` and `max_inputs` to match, and set `max_containers`
deliberately.

### P1 — zero observability

No metrics, no tracing, no telemetry dependency at all; a `/metrics`
endpoint existed and was removed (`schemas.test.ts:159`, dangling
references in `_boot.ts:52` and `docs/performance-audit.md`). Logging is
bare `console.*`; sandbox lifecycle logs are behind an off-by-default
debug flag. `/health` reports only ok/draining.

Concurrent sessions, sandbox count/spawn latency, pool hit rate, argon2
cache hit rate, per-tenant usage, drain durations — **none observable**.
"Scale without work" requires at minimum knowing when you're near a limit;
today the first signal is user-facing RSTs. The environment already has
Datadog credential injection available; a thin stats emitter + a restored
`/metrics` would unblock every capacity decision in this document.

### P1 — no usage metering or per-tenant quotas

There is no metering, billing hook, token-usage capture, or per-tenant
accounting anywhere (verified by sweep). Consequences at growth:

- One slug can consume all connection slots (no per-slug session cap,
  `sandbox-slots.ts:112-120`).
- `POST /deploy` and the `/:slug/secret|storage|vector` routes have **no
  rate limit** — each deploy is up to 40 MB inflated + an argon2 verify
  (19 MiB, ~30-60 ms) on 1 vCPU; an attacker with invalid keys forces one
  full argon2 run per request (`secrets.ts:17-21`, no limiter in front).
- Studio auth accepts any non-empty bearer; only the in-process 30/5 min
  window stands between the public internet and platform-billed LLM calls
  (`studio-rate-limit.ts:5-9`).
- The platform Pinecone index is shared by all tenants with no per-slug
  quota; token usage from `streamText` is never even captured.

**Direction:** rate-limit the non-studio authenticated routes, add a
per-slug concurrent-session cap, and start recording per-tenant counters
(sessions, minutes, LLM tokens on platform keys) even before enforcing
anything — you can't add plans or abuse controls later without the data.

### P1 — Postgres is the narrowest shared pipe

- **One 4-connection admin pool per replica, no statement timeout**, shared
  by Vault reads, studio stores, and DDL (`index.ts:104`,
  `postgres-db.ts:37`). One slow query starves auth-adjacent reads,
  studio, and provisioning simultaneously; the pool is never closed on
  shutdown.
- **Connections scale with resident slots**: 2 per app slot, slot cache
  uncapped → worst case ~200+ app connections per replica against one
  Supabase project.
- **Per-app roles/schemas grow unbounded** with no quota on tables/disk
  (`grant create on schema`, `app-database.ts:231-256`), and delete
  cleanup is warning-only — a transient failure orphans a schema+role
  with its credentials already deleted (`delete.ts:19-27`).
- **No migration system** — stores issue lazy `create table if not exists`
  at first use per process (`workspace-store.ts:85-95`); N replicas
  booting cold contend on DDL.
- `provisionAppDatabase` rotates the role password on **every** call
  (`app-database.ts:233`), so racing enables (or replays) invalidate live
  handles.

### P2 — retry/backoff gaps at the provider edges

- Non-AssemblyAI STT/TTS providers get one connect attempt, no retry;
  only AssemblyAI STT has an owned budget (`STT_CONNECT_*`,
  `sdk/constants.ts:425-427`).
- S2S resume and AssemblyAI-TTS barge-in reconnects have **no backoff**
  (immediate, and unbounded in the TTS case) — under a provider brownout
  these amplify load against the provider.
- No 429 handling anywhere outside the AI SDK's default 3 attempts;
  Brave 429s are returned to the model as an opaque error string.
- The provider-outage UX fallback (`DEFAULT_ERROR_PHRASE`) is good, but
  nothing records that it fired.

### P2 — configuration drift and pinning

- Guest image is `denoland/deno:latest`, unpinned in prod
  (`modal-sandbox.ts:82`; `modal_deploy.py` never sets
  `MODAL_SANDBOX_IMAGE`) — every new sandbox may pull a different Deno.
- **The warm pool is likely off in production**: `SANDBOX_POOL_SIZE` is not
  set in `modal_deploy.py`'s image env (only listed as an optional Secret
  key, line 31), so every first-session-per-slug pays a full cold Modal
  spawn. Verify the Secret; if unset, every cold start today is avoidable
  latency. Pool max is 16 (`sandbox-pool.ts:79`); it also does not
  self-replenish while idle.
- Guest memory/CPU limits (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`)
  are unset → Modal defaults, uncapped by us.
- Single region (`us-east-2`) hardcoded (`modal_deploy.py:52`);
  `SUPABASE_S3_REGION` separately defaults to `us-east-1`
  (`index.ts:69`). Multi-region is a project, not a knob.
- All capacity tuning is env vars that nothing sets and no metric informs.
- Secret rotation (one Modal Secret holding every platform credential,
  `modal_deploy.py:22-31`) is manual and requires a redeploy.

### P2 — unbounded growth with no janitor

Monotonic accumulators with no cleanup job: studio workspaces/chat rows
(no per-scope project quota beyond 60 creates/hr with caller-chosen
scopes), orphaned S3 objects on partial delete, orphaned Vault entries and
`app_*` schemas on half-failed deletes, Pinecone namespaces on agent
delete, and the in-memory vector fallback — a module-global map that is
silently active whenever `PINECONE_*` is unset and never evicted
(`memory-vector.ts:22`).

---

## 4. Recommended sequence

Cheap config, this week:

1. Set `max_containers=1` explicitly (make the single-replica assumption a
   decision, not an accident) and align `max_inputs` with `MAX_CONNECTIONS`.
2. Pin the guest image; set `SANDBOX_MEMORY_LIMIT_MB`/`SANDBOX_CPU_LIMIT`;
   confirm/enable `SANDBOX_POOL_SIZE` in the Modal Secret.
3. Add a statement/connect timeout to the admin Postgres pool and close it
   on shutdown.

Small code, high leverage:

1. Restore `/metrics` (sessions, sandboxes, pool hits, auth cache hits,
   drain state) and ship logs/metrics somewhere queryable.
2. Rate-limit `POST /deploy` and the `/:slug/*` owner routes; add a
   per-slug concurrent-session cap.
3. Start per-tenant usage counters (sessions, session-minutes, platform-key
   LLM tokens) — record first, enforce later.
4. Backoff on S2S resume and AssemblyAI-TTS reconnect; cap the latter.

Structural, before real scale-out:

1. Externalize resume state + slug locks + cache invalidation (one small
   Redis or Postgres-advisory-lock layer), or commit to vertical scaling
   and document it.
2. Real migrations for `aai_platform`; reconciliation sweeps for orphaned
   schemas/secrets/S3 objects/Pinecone namespaces.
3. Load-test per-session CPU/memory on the web container and size
    `MAX_CONNECTIONS` from data.

The one-sentence summary: **tenant-facing cost and compute already scale
hands-free (tenant keys + Modal sandboxes); the control plane does not —
it is a single 1-vCPU Node process with all coordination state in RAM, no
metrics, no quotas, and a 4-connection Postgres pool behind everything.**
The path to "infinite scale, zero work" runs through observability first,
per-tenant limits second, and shared-state externalization last.
