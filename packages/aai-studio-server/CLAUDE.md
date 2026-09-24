---
summary: >-
  Browser studio service and the deployment's composition root: package layout,
  the one-deployment/two-packages composition (bundling, the shared-core
  exports map, public origin, cross-service invalidation, retirement and
  shutdown), dev serving, and the studio's eval and fuzz suites
read_when: >-
  working on the studio service or its deployment composition
---

# packages/aai-studio-server — studio guide

The studio service (private package): the browser-based coding agent,
workspaces, previews and Publish — and the composition root every deployment
runs. Its front-end is `packages/aai-studio-client/CLAUDE.md`; the guest the
coding agent runs in is `packages/aai-guest/CLAUDE.md` and
`packages/aai-guest-studio/CLAUDE.md`.

## Directory guides

- [`src/CLAUDE.md`](src/CLAUDE.md) — every studio feature rule: workspaces, the
  CLI round-trip, sessions and the fleet-wide sandbox, previews, event streams,
  secrets, agent logs, Publish, LLM selection, auth, rate limits.
- [`src/prompts/CLAUDE.md`](src/prompts/CLAUDE.md) — the coding agent's system
  prompt, the project kind, and what the prompt must say.

Reference siblings, read on demand: [`GITHUB-SYNC-CLAUDE.md`](GITHUB-SYNC-CLAUDE.md)
(Sync to GitHub), [`SSE-CLAUDE.md`](SSE-CLAUDE.md) (the long-lived event
streams), [`STARTER-EVAL-CLAUDE.md`](STARTER-EVAL-CLAUDE.md) (the starter eval).

## Key files

- `studio-routes.ts` — the HTTP surface: broker, auth/scope middleware, and
  every route that is not the project document.
- `studio-project-routes.ts` — project CRUD, the two file routes, `aai push`'s
  `PUT …/source`.
- `studio-session-broker.ts` (collaborators, per-project lock, public
  surface), `studio-session-ensure.ts` (reuse → adopt → spawn, all under that
  lock), `studio-session-idle.ts` (teardown, idle eviction),
  `studio-session-registry.ts` (the fleet-wide row), `studio-session-adopt.ts`
  (installing into a PEER's guest over HTTP), `studio-session-publish.ts`
  (`buildWorkspace` for Publish).
- `studio-workspace.ts` (file store), `studio-deploy.ts` (guest build →
  validate config → deploy), `studio-llm.ts` (gateway model; the key is always
  the caller's), `studio-project-kind.ts` (voice agent vs workflow app),
  `studio-static.ts` (serves the built client).
- `prompts/` — prompt text, and only prompt text.
- `index.ts` — the service entry; see below.

## One deployment, two packages (aai-studio-server / aai-server)

`aai-server` is the agent surface plus the shared platform core (stores, locks,
epochs, sandbox machinery). It ships **no entry point and no `build`**: a
library consumed through its `exports` map, whose subpaths resolve to `.ts`
source. `platform-barrel.ts` is the sanctioned path to its `_`-internal
utilities.

`aai-studio-server` is the studio surface AND the composition root. Its entry
is the only one any deployment runs (`pnpm dev:aai-server` included): studio
paths (`isStudioPath`, `aai-server/studio-paths.ts`) go to the studio app,
everything else — `/health` and WebSocket upgrades included — to the agent
orchestrator. Both share one `ServiceConfig`, so they share the slot cache and
stores. There is ONE Modal app, `aai-server-web`, deployed by
`packages/aai-server/modal_deploy.py` (the deploy script lives in the package
that does not provide the entry) and launching
`packages/aai-studio-server/dist/index.mjs`.

There is no split deployment; `modal_deploy.py`'s "One app, both surfaces"
block records what reviving one would cost. Two constraints survive any
revival: **one public origin** (below), and the studio's event streams need the
raised function timeout (`SSE-CLAUDE.md`).

### Bundling

- **aai-server is COMPILED IN, and the pattern must match its SUBPATHS.**
  `tsdown.config.ts` lists it under `deps.alwaysBundle`, which matches the
  SPECIFIER, and every import is a subpath (`aai-server/orchestrator`, …). An
  externalized entry still builds and runs, but every cold start then compiles
  ~72 TypeScript modules. `bundled-deps.test.ts` holds the pattern to the
  specifiers the entry imports.
- **The module's own location is no longer where its source lives.**
  `createRequire(import.meta.url)` resolves from this package's `dist/`, which
  has no `aai-guest` above it — hence `guestPackageDir`'s fallback
  (modal/harness-image.ts). Anything else that resolves a workspace sibling by
  module location owes the same fallback.
- **So aai-server may not resolve a sibling package at all — this root does
  and passes it in.** `createOrchestrator` takes a REQUIRED `clientDir`, passed
  `defaultClientDir()` from `index.ts` (the package that declares
  `@alexkroman1/aai-ui`). Required with no fallback, `Omit`ted from
  `ServiceConfig` (everything there comes from env), and resolved eagerly so a
  missing aai-ui fails the boot. `bundled-deps.test.ts` holds every workspace
  package aai-server's shipped source imports to this manifest.
- **The npm half is a baseline.** `modal` and `microsandbox` are `external` in
  tsdown.config.ts (they resolve files relative to their own package; native
  addons). `check:bundled-deps` baselines the remaining inlined pure-JS
  dependencies, so a new one is a decision; `bundled-deps.test.ts` holds the
  config to `deps.alwaysBundle` (`onlyBundle` would externalize aai-server
  itself).
- **The shared core is the `exports` map and nothing else** — an explicit
  subpath list grouped by role. `platform/surface.test.ts` holds it to real
  imports in both directions. Widen it by editing package.json; when a coupling
  goes away, delete the entry (ratchets down only).

### Origin and CORS

- **One public origin** — both surfaces are served by one process on one
  hostname. Agent pages are `X-Frame-Options: SAMEORIGIN`, so the preview
  iframe needs the studio on their origin.
- **Never derive the public scheme from the request URL** — use
  `resolvePublicOrigin` (`aai-server/public-origin.ts`). Modal terminates TLS
  and forwards plain HTTP without `X-Forwarded-Proto`, so `new URL(c.req.url)`
  is always `http:`; a guest handed an `http://` origin gets 308'd and `fetch`
  drops `Authorization` across the scheme change. Order: `AAI_PUBLIC_ORIGIN` →
  `x-forwarded-host`/`-proto` → infer (only loopback is `http`). Redirects use
  relative `Location`s.
- **A resolved origin is used WITHIN its request and never stored** — `Host` and
  `x-forwarded-*` are caller-written, so persisting one is an injection (see
  "Durable workflows" in `packages/aai-server/CLAUDE.md`).
- **Cross-origin callers come from `AAI_ALLOWED_ORIGINS`; unset means none**
  (comma-separated or `*`, read in `app-middleware.ts` for both surfaces; an
  explicit `allowedOrigins` argument wins).

### Cross-service invalidation

- **The agents row's CHANGE STREAM is the only invalidation**
  (`agent-store.ts`; `platform/events.ts` / `realtime-events.ts`;
  `watchAgentInvalidation` in `sandbox/resolve.ts`). Mutations ONLY write the
  row; every replica reacts to the Realtime event by dropping bundle-store row
  caches, re-reading the version (events are signals, never payloads), and
  retiring a resident at a different version — terminating it on a deleted
  row. The version comparison under the slug lock makes duplicate or reordered
  events harmless; an unreadable version logs and leaves the resident alone.
  There is no second detection path: `resolveSandbox` serves any live resident
  and the idle sweep is about idleness only.
- **The REJOIN is a signal**: changes during a join or a socket drop reach
  nobody. `watchAgents` takes a separate slug-less `onResync` (not a nullable
  slug), which `watchAgentInvalidation` answers by reconciling every resident
  (one single-flighted, 1s-cached read each; none on a replica with none).
  Register before `ensureAgentsChannel()`. The subscription monitor
  (`createSubscriptionMonitor`, `/health`) surfaces a channel that never joins;
  it cannot repair a silent drop.
- **A SECRET change moves no sandbox** — it writes Vault and takes effect on the
  next deploy or rebuild. Deploy and delete do move sandboxes.
- **Supabase setup lives in `supabase/migrations`**, applied with
  `supabase db push` BEFORE the code that queries it: the `aai_platform` schema,
  the watched tables' `supabase_realtime` membership, `service_role` SELECT
  grants (without them every filtered subscribe fails with
  `invalid column for filter <col>`), workspace-child foreign keys,
  `studio_workspaces.preview_slug` generated column + index, and the
  `pg_cron`/`pgmq`/`pg_net` extensions. Only pg_cron SCHEDULING runs at boot
  (`schedulePlatformSweeps` via `bootstrapPlatformDb`). Production also needs
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` beside `SUPABASE_DB_URL`.

### Retirement and shutdown

- **A superseded sandbox is RETIRED, not terminated** (`sandbox/retire.ts`).
  `retireSlot` detaches it from the slot synchronously (no await between), then
  fire-and-forgets one deadline-carrying `POST /manage/drain`; the guest
  (`harness/agent-mode.ts`) refuses new sessions and exits at its last session
  or at `SANDBOX_RETIRE_DRAIN_MS` (10 min; 0 terminates). The host keeps no
  drain state; an unreachable guest is terminated on the spot. A failed VM, an
  exited guest, or a DELETED agent stays on `terminateSlot`. Process teardown
  does not chase retired guests.
- **The studio holds an always-empty slot cache** — local teardowns are no-ops
  there; the deploy's row-version bump does the work.
- **The web service autoscales** (`MIN_CONTAINERS`/`MAX_CONTAINERS` in
  `modal_deploy.py`). A replica going down retires its agent guests
  (`teardownSandboxes`); live calls finish in the guests. Studio guests go down
  with it (`dispose()`).
- **Shutdown stops BOOTING sandboxes before it stops serving**:
  `brokerSessionUrl` refuses a new sandbox when `isDraining` (503 → client
  re-brokers) while still serving a live resident, and `teardownSandboxes`
  waits `SHUTDOWN_GRACE_MS` (3s) before emptying slots. The studio-only path
  passes 0.
- **Shutdown is bounded at two levels** — `SANDBOX_TEARDOWN_READY_MS` caps the
  readiness wait, `SHUTDOWN_TEARDOWN_TIMEOUT_MS` nets the whole teardown. Read
  their budget arithmetic in `constants.ts` before changing `SHUTDOWN_GRACE_MS`.
  Tests record settlement on a `vi.fn()` rather than awaiting, so a lost budget
  fails fast instead of hanging.
- **Shutdown ends long-lived responses, and any new one owes registration** in
  `live-streams.ts`; the function timeout bounds call duration. Both are in
  [`SSE-CLAUDE.md`](SSE-CLAUDE.md).

## Serving a current studio client in dev

`predev` ends with `pnpm --filter aai-studio-client build`, so
`pnpm dev:aai-server` always serves a current client. `studio-static.ts` serves
whatever is in that package's `dist/` without checking its age, so a stale
bundle looks like nothing changed. Unconditional, not staleness-gated: the
build is sub-second.

## Long-lived responses (SSE)

**In [`SSE-CLAUDE.md`](SSE-CLAUDE.md)** — read it before touching either event
stream or the lifecycle under them.

## Studio starter evals

`src/studio-starter.eval.test.ts` and the `studio-starter-*` modules beside it
drive the studio's REAL surface (create project, broker a session, stream a
turn to the guest) on `aai-evals`' runner:

```sh
pnpm dev:aai-server                                       # in another shell
pnpm --filter aai-studio-server test:eval                 # every starter
AAI_EVAL_ONLY=pizza AAI_EVAL_REPEAT=3 pnpm --filter aai-studio-server test:eval
```

It spends real tokens on the caller's key, so it is not in CI.
[`STARTER-EVAL-CLAUDE.md`](STARTER-EVAL-CLAUDE.md) is the reference;
`packages/aai-evals/CLAUDE.md` owns the runner.

- The primary verdict is **capability coverage** against the PROMPT's
  enumerated capabilities (`studio-starter-expectations.ts`), checked on the
  loaded config and `agent.ts` — not "the agent's own tests passed", which it
  can satisfy by weakening them.
- It also reports cost (tool calls, repair rounds = failed `test_agent` runs,
  wall clock) and a failure taxonomy: never-verified / verified-broken /
  missing capability / step-capped.
- **One run cannot adjudicate a prompt change** — variance is the size of most
  prompt effects. Use `AAI_EVAL_REPEAT=3` and compare arms; a non-unanimous
  assertion decides nothing.
- Resemblance to a hand-written template is not checked.

## Randomized interleaving tests

`studio-concurrency-fuzz.test.ts` (and `studio-sse-fuzz.test.ts`) are property
suites over the preview queue and the SSE streams, asserting preview
convergence, one deploy per project at a time, no write into an ended stream,
frame order, and no live-stream registry leak.

- **Wrap the resumption INSIDE the deploy body** (`s.schedule`), never the
  whole deploy function (`s.scheduleFunction`) — `fc.scheduler` runs tasks one
  at a time, which would make the no-concurrent-deploy invariant unfalsifiable.
- **Assert the invariant, not the mechanism** (a failed build stamping
  `previewError` is SETTLED, not unconverged).
- **Check that an asserted state is reachable.** A property a random walk
  never reaches is vacuous; the attempt-cap boundary has its own targeted
  property for that reason.
