# Copyright 2026 the AAI authors. MIT license.
"""Deploys the AAI platform server to Modal.

The server is a Node.js app; Modal runs it behind ``@modal.web_server``,
which proxies HTTP *and* WebSocket traffic (voice sessions are long-lived
WebSockets) to the node process listening inside the container.

Agent guest sandboxes are ALSO Modal Sandboxes (see modal-sandbox.ts), created
by the server at runtime under the ``aai-server`` Modal App using the
``MODAL_TOKEN_ID``/``MODAL_TOKEN_SECRET`` from the ``aai-server`` Secret.

This is the ONLY Modal app the platform deploys, and it serves BOTH surfaces
(``AAI_SERVICE=combined``) from one container — see "One app, both surfaces"
below. Studio builds and Publish run inside the tenant's own guest sandbox
through the aai CLI, not in a Modal Function here.

Deploy (from the repo root, with the Python `modal` CLI authed via
`modal token new`):

    supabase db push          # FIRST — see below
    modal deploy packages/aai-server/modal_deploy.py
    # or: pnpm --filter aai-server deploy:modal (same command via pnpm)

The platform schema (``aai_platform``, the Realtime publication and its
``service_role`` grants, the pgmq queue) is declared in
``supabase/migrations`` and must be applied BEFORE the code that queries it.
It used to be created lazily by each store on first use, which needed no
ordering but silently papered over a missing table. A skipped migration now
fails loudly with "relation does not exist" on the first read.

Required Modal Secret named ``aai-server`` with (at least):

- ``MODAL_TOKEN_ID`` / ``MODAL_TOKEN_SECRET`` — for creating guest sandboxes
- ``SUPABASE_STORAGE_BUCKET`` — the Supabase Storage bucket deploy artifacts
  live in. Authenticated with ``SUPABASE_SERVICE_ROLE_KEY`` below, so Storage
  needs no credential of its own. Also the sentinel that distinguishes a
  production boot from local dev (see ``isLocalDev``)
- ``SUPABASE_DB_URL`` — service-role Postgres connection string (Vault
  secrets + per-app databases). Must be the project's own ``postgres`` role:
  a per-app database is created by the Management API as ``postgres``, and
  ``revoke connect on database`` requires ownership of it
- ``SUPABASE_ACCESS_TOKEN`` — Supabase personal access token (``sbp_...``).
  ``create database`` / ``drop database`` for per-app databases go through the
  Supabase Management API and have no SQL fallback, so without this the server
  REFUSES TO BOOT. Optionally ``SUPABASE_PROJECT_REF`` when the project ref
  cannot be derived from ``SUPABASE_DB_URL``
- ``SUPABASE_URL`` / ``SUPABASE_PUBLISHABLE_KEY`` — Supabase Auth (studio
  browser/CLI email login; the publishable ``sb_publishable_...`` key from
  the dashboard's API Keys page). Missing means browser login is disabled
  (a boot warning says so) — raw API-key bearers still work
- ``SUPABASE_SERVICE_ROLE_KEY`` — with ``SUPABASE_URL``, the Supabase
  Realtime change streams (sandbox invalidation, studio preview push) AND
  Storage reads/writes of deploy artifacts
- ``GITHUB_APP_ID`` / ``GITHUB_APP_PRIVATE_KEY`` / ``GITHUB_APP_SLUG`` /
  ``GITHUB_APP_CLIENT_ID`` / ``GITHUB_APP_CLIENT_SECRET`` —
  the studio's "Sync to GitHub" App. The OAuth pair is what the Connect button
  drives — the flow goes through ``/login/oauth/authorize`` rather than the
  App's install page, which does not redirect back once the App is installed —
  and what lets the callback verify the person finishing the flow actually
  administers the installation they are attaching; without it that callback
  accepts any (enumerable) ``installation_id``. Leave **"Request user
  authorization (OAuth) during installation"** enabled as well, so a first-time
  install returns its ``installation_id`` directly. All of them or none: a half-configured App
  is the state where the install link works and every sync fails, so absence
  reads as "not configured" and the studio's GitHub card renders nothing (see
  "Sync to GitHub" in ``packages/aai-studio-server/CLAUDE.md``). The private
  key may be pasted intact, ``\n``-escaped, or base64 — all three normalize
  to one value, which matters because it is also the HMAC key behind the
  install ``state``, so two replicas disagreeing by a newline would reject
  each other's callbacks. The App needs **Contents: read and write** on the
  repositories a user grants it, and its **Callback URL** must be
  ``<origin>/studio/github/callback`` — GitHub sends authorization to the
  first registered callback URL whatever ``redirect_uri`` a client passes, so
  that entry is what the whole flow lands on
- ``PLATFORM_POOLER_URL`` — Supavisor's TRANSACTION-mode URL (port 6543) for
  the admin pool. **Undocumented here for as long as it existed, and unset in
  production**: boot warns that the pool is opening DIRECT connections, which
  cost ``platformDbConnectionsPerReplica()``'s four more per replica than
  ``MAX_PLATFORM_DB_CONNECTIONS`` accounts for — so at ``MAX_CONTAINERS`` the
  fleet is 20 over its own budget. Measured on the live app: ``max_connections``
  is 60 against a declared budget of 40, and two consecutive boots reported
  "4 spare" then "0 spare". Unset is SAFE in the sense that nothing silently
  misbehaves; what it costs is the headroom
  ``platform-db-capacity.ts`` exists to protect
- ``APP_DB_POOLER_URL`` — Supavisor's SESSION-mode URL for app databases.
  Optional: with it unset, ``withPoolerHost`` leaves an app-database URL on
  whatever host ``SUPABASE_DB_URL`` names, which in production is already the
  pooler's. Do not point it at a TRANSACTION-mode pooler — ``appDbPoolerUrl``
  refuses one, because the Workflow DevKit cannot run on transaction pooling at
  all and the failure is silent (the queue looks fine and parked runs stop
  resuming)
- ``AAI_PUBLIC_ORIGIN`` — the origin browsers reach this deployment on
  (``https://<host>``, no trailing slash). **REQUIRED: boot is refused without
  it** (``PLATFORM_TIER_ENV`` in ``_boot.ts``), and this entry used to say the
  opposite — "required for durable workflow webhooks and nothing else … every
  other route is unaffected". That was true when the only reader was
  ``ctx.workflows.publicWebhookUrl()``. It is now the only source of
  ``agentPublicBaseUrl``, which a guest receives as ``AAI_PUBLIC_BASE_URL``,
  which is half of what the guest needs to install the PLATFORM workflow world.
  Unset, every durable run silently ran on the DevKit's local world instead —
  queue in the guest's memory, state in a directory, both gone with the sandbox
  — while the platform's own queue table went unread. The origin is deliberately
  NOT learned from a request: ``Host``/``x-forwarded-host`` are the caller's to
  write and that middleware runs before any auth, so one unauthenticated request
  would otherwise decide the callback URL baked into the next sandbox this
  replica spawns, for any tenant (see ``rememberPublicOrigin``)
- optional: ``ASSEMBLYAI_API_KEY``
- optional: ``AAI_ALLOWED_ORIGINS`` — comma-separated cross-origin callers to
  allow, or ``*``. Unset rejects every cross-origin request, which is right
  here: both surfaces are same-origin by construction and an agent's browser
  client is served by the agent's own origin

"""

import os
import sys
from pathlib import Path

import modal

# The image recipe is shared with the studio app so the two services can never
# run different dependency trees — see scripts/modal_image.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "scripts"))
from modal_image import build_image, install_proxy_noise_filter, run_node  # noqa: E402

PORT = 8080

# ── Region: a FALLBACK LIST, us-east-2 first ─────────────────────────────────
#
# ``REGIONS`` below is passed to the web function. It is a LIST and not a
# single value, and that is the whole design: this service was once pinned to
# a bare ``us-east-2``, which confines an always-warm replica to one region's
# spare capacity — and when that runs dry Modal places NOTHING.
#
# That outage is worth describing, because none of its symptoms name a region:
# the app sits at ``deployed`` with ZERO tasks despite MIN_CONTAINERS=1 below,
# every request hangs until the client times out having received zero bytes,
# and — because no container is ever created — there are NO logs whatsoever,
# not even a crash. ``modal app logs`` replays the last image build and then
# streams silence, which reads as a wedged control plane rather than a
# placement failure. Nothing recovers it: a redeploy or ``modal app rollover``
# only re-asks for a container that still cannot be placed. A second region is
# what makes that state unreachable while still expressing a PREFERENCE, which
# is why the fix for it was never "pin harder" and is not "unpin" either.
#
# ## What changed the answer: the Supabase round trips ARE in a budget now
#
# This block used to end "the Supabase round trips that remain are not inside a
# latency budget", and that premise was retired by durable workflows. A run's
# journal is a platform call per operation, and the engine's are SEQUENTIAL by
# construction — ``claimAttempt`` before a step's body, ``appendStep`` after it
# — so a run's wall clock is a multiple of this container's distance from the
# database. Measured on a deployed ``use-transcript-workflow``, one 300 KB / 4
# second recording, ONE clean walk with no retries:
#
#   14 x POST /:slug/workflow-journal, ~460-666 ms of server time each
#   = ~7.3 s, to move 2.3 KiB of JSON (largest single body: 358 B)
#
# The same 14 calls, same route, same statements, against a local Postgres:
# **31.4 ms total**, ~1-2 ms each in steady state. So ~99% of that time was
# distance, and none of it was the statements, the pool, the bearer check or
# the payload. The database is Supabase ``us-east-2`` (project ``aai``), and
# Modal was placing this container wherever it found capacity — observed as far
# off as another continent and cloud.
#
# ## The spill is the BROAD region, because ``us-east-1`` is not selectable
#
# The spill was written as ``us-east-1`` — ~15 ms from ``us-east-2``, so a
# placement that misses the preference still lands two orders of magnitude
# better than an unpinned one. Modal refused it, and the refusal is a DEPLOY
# failure rather than a placement one, so the app kept serving the previous
# revision and nothing shipped:
#
#   Regions us-east-1 are not supported. See
#   https://modal.com/docs/guide/region-selection for supported regions
#
# Which specific regions a workspace may name is Modal's to decide and is not
# knowable from this file, so the fallback is now the BROAD ``us-east`` — a
# granularity level rather than one datacenter, and the one Modal's own guide
# recommends reaching for, since a wider pool is what improves availability.
# It keeps the property the spill was for: everything under ``us-east`` is
# within tens of milliseconds of the database, i.e. two orders of magnitude
# better than the unpinned placements measured above, and the warm floor can
# always be placed.
#
# Note the list is a SET of acceptable regions rather than an ordered
# preference Modal promises to honour; ``us-east-2`` leads it because that is
# where the database is, and `modal-image-inputs.test.ts` pins that intent so
# a later edit cannot drift the first entry away from Supabase.
#
# ## Guest sandboxes take the SAME list, and they used to take nothing
#
# They are a separate placement site (``MODAL_SANDBOX_REGION``, read by
# modal-sandbox-env.ts), and they were left unpinned on an argument that voice
# is what a hop costs: an agent guest holds no host channel at all — browsers
# dial the sandbox tunnel directly — so a voice turn crosses guest→platform
# zero times.
#
# Durable workflows are what that argument does not cover. A run's journal is
# one ``POST /:slug/workflow-journal`` per operation, made BY THE GUEST, and
# the engine's operations are sequential by construction — so an unpinned
# guest's distance from this service multiplies a run's wall clock exactly the
# way this service's distance from Supabase did. Measured against a deployed
# platform: **~24 ms an operation out of region, ~2 ms in it**, and a walk
# makes a dozen or more.
#
# So they take this same list, exported into the image below — and the LIST is
# the whole reason it is safe to pin them at all. A single region is what once
# broke them: every spawn confined to one region's spare capacity, and a spawn
# Modal cannot schedule inside the ~50 s ``sandbox.tunnels()`` wait fails with
# ``Sandbox operation timed out``, i.e. a studio chat or voice session that
# never starts. That is this file's own zero-container outage one layer down,
# and a spill region is what makes it unreachable while still expressing the
# preference. An operator can still override the variable per environment.
REGIONS = ["us-east-2", "us-east"]

# ── One app, both surfaces ───────────────────────────────────────────────────
#
# ``server`` below runs ``AAI_SERVICE=combined``: one container serving the
# agent surface (voice brokering, the platform API) and the studio surface
# (``/``, ``/studio/*``, ``/studio-assets/*``) behind one path dispatcher, from
# the aai-studio-server entry. That entry is the composition root for both
# apps; this package is a library to it.
#
# A SPLIT deployment used to live here — a second Modal app (``aai-studio-web``)
# for the studio, with this app booting ``AAI_SERVICE=agent`` and
# reverse-proxying the studio surface to it via a ``STUDIO_UPSTREAM_URL`` in
# the Secret. It is removed rather than left dormant: the upstream was never
# wired, so production always took the combined branch and the split half was
# unreachable code that nonetheless constrained the design (a proxy hop that
# had to re-resolve the public origin, forward SSE gracefully, and keep a
# studio-path predicate agreeing with the combined dispatcher).
#
# The reason to bring it back would be that the two workloads want different
# autoscaling — studio chat turns are LLM-bound and bursty, agent brokering is
# light and latency-sensitive. Git history has the whole thing (the proxy,
# ``gracefulEventStream``, the agent-only entry). Note that reviving it means
# ONE public origin again: agent pages set ``X-Frame-Options: SAMEORIGIN``, so
# the studio must share their origin or the preview iframe breaks.

# ── Web-service autoscaling ──────────────────────────────────────────────────
#
# The server holds no cross-request state (coordination lives in Supabase —
# see CLAUDE.md "Stateless server"), so replicas are interchangeable:
# scale-out is safe, and on scale-in/redeploy the node process's SIGTERM
# handler RETIRES the replica's agent guests (one drain request each — the
# guests finish their calls and exit on their own clock) and disposes the
# studio broker. Voice sessions live in the guest sandboxes (browsers dial
# the sandbox tunnel directly), so a replica going down cuts nothing;
# clients auto-reconnect (?sessionId) and re-broker.
#
# Each in-flight HTTP request counts as one input. Voice sessions never pass
# through this process (browsers dial the sandbox tunnel directly, and
# `/:slug/websocket` upgrades are instant handshake redirects), so inputs are
# short HTTP traffic, the studio proxy's SSE streams, and one PLATFORM SOCKET
# per running agent guest:
#
# - A deployed guest opens `WS /:slug/platform-socket` once and carries every
#   platform call (session state, upload records, the workflow journal, its key
#   index, an enqueue) down it — `platform-socket-handler.ts` here,
#   `aai-runtime/platform-socket.ts` at the other end. A WebSocket is ONE input
#   for its whole lifetime, so that is one long-lived input per live guest where
#   the same traffic used to be short requests any replica could serve.
# - MAX_INPUTS below is therefore the cap that matters: at 400 a replica holds
#   400 guests' sockets plus its SSE streams and its ordinary requests, and
#   sockets are the only one of the three that does not drain on its own. Two
#   things bound it — the server idle-reaps a socket after 90 s with no frame
#   (PLATFORM_SOCKET_IDLE_MS) and a draining replica REFUSES a new one — and one
#   thing makes exhaustion survivable: a guest with no socket falls back to plain
#   POSTs, so the ceiling costs latency rather than availability.
#
# - TARGET_INPUTS is the autoscaler's set point: Modal adds containers once
#   per-container concurrency crosses it.
# - MAX_INPUTS caps what one container absorbs while scale-up is in flight.
MIN_CONTAINERS = 1  # always-warm floor: session brokering is latency-sensitive
# Cost guard AND the multiplier on the platform's direct-connection budget:
# MAX_CONTAINERS x platformDbConnectionsPerReplica() must fit
# MAX_PLATFORM_DB_CONNECTIONS, which `platform-db-budget.test.ts` asserts.
# 3 x 4 = 12. Raise deliberately, not by incident, and check the instance's real
# `max_connections` first — the failure at the ceiling is every platform read
# failing at once, not degradation (see that constant).
#
# It was 10, then 5, and lowering it RAISES capacity — a paradox only if the two
# limits are conflated. A replica is cheap in the scarce resource and expensive
# in nothing: it costs 4 direct connections and serves hundreds of concurrent
# inputs, so the fleet's serving capacity is set by the per-container input caps
# below, never by this number. The connections given back are the only headroom
# per-app databases have — they are session-mode pooled, i.e. one real backend
# each, and they are what actually scales with TENANTS (see
# MAX_ACTIVE_APP_DATABASES). This does NOT bound how many AGENTS run: guest
# sandboxes are Modal Sandboxes under a different Modal app
# (DEFAULT_MODAL_APP_NAME in modal-context.ts), not containers of this function.
#
# 5 -> 3 MEASURED, which is what took it off "plausible". One replica's broker
# held **23,000 rps at p99 22ms with 256 concurrent and zero errors**, flat from
# 32 concurrent upward — it saturates one event loop and stays there. So five
# replicas was availability sizing, never throughput sizing, and two of them were
# costing 8 of the 40 connections that per-app databases divide.
#
# The claim is UNCHANGED at 40; the 8 move from a term that does not grow to one
# that does (APP_DB_CONNECTION_ALLOWANCE, 20 -> 28), so this buys tenants and not
# margin. Margin needs a bigger instance: the budget plus Supabase's own ~17
# workers is 57 of the 60 this `t3a.micro` has, before and after.
#
# What it COSTS is fleet-wide concurrent inputs: MAX_CONTAINERS x MAX_INPUTS goes
# 2000 -> 1200. Those are short HTTP requests plus the studio's SSE streams (one
# per open tab), one replica held 2000 streams in testing with request p50
# unchanged, and MIN_CONTAINERS keeps the steady state at one container anyway —
# so 1200 is far above real use. Raise this back before that stops being true,
# and give the allowance back when you do.
MAX_CONTAINERS = 3
BUFFER_CONTAINERS = 0  # no pre-warmed spare; bursts wait on container cold start
# Measured, not guessed — one replica, 2,000 concurrent SSE streams held open:
# zero refusals, ~100 KB of RSS each (292 MB total), CPU ~0%, and a fresh
# request's p50 unchanged (1 ms /health, 3 ms /studio/projects). Those streams
# also cost ZERO extra database connections: they are fed by Realtime change
# events, not by polling, so a held stream acquires nothing from a pool. The
# previous 75/150 pair was therefore ~13x under what a replica can hold, which
# mattered because SSE streams are long-lived INPUTS — one per open studio tab.
#
# 400 keeps ~5x headroom against that measurement, deliberately, because the
# cap also covers short DB-backed requests whose latency does grow with
# concurrency (measured: p99 49 ms at 200 concurrent, 92 ms at 400, 246 ms at
# 800) and because the measurement was taken on a multi-core dev machine while
# this function runs at cpu=1. Re-measure on a real container before raising.
TARGET_INPUTS = 200  # scale-out set point
MAX_INPUTS = 400  # concurrent-input cap per container (SSE streams included)

# ── Input timeout ────────────────────────────────────────────────────────────
#
# A WebSocket is ONE Modal input for its whole lifetime, so the function
# timeout bounds CALL DURATION, not request latency — and Modal's default is
# 300s. Unset, that silently severed every in-process voice session (the old
# `?host=1` host mode, since removed) at exactly five minutes, mid-word,
# surfacing to the client as a bare "not connected" with nothing logged
# server-side. Sessions still never run in this process — browsers dial the
# guest sandbox's tunnel directly, and `/:slug/websocket` upgrades are
# handshake redirects — but the studio proxy's SSE streams and the guests'
# PLATFORM SOCKETS sit under the same cap, so it stays pinned rather than
# inherited. A platform socket really does live for hours, which is what makes
# this value load-bearing rather than precautionary now: at Modal's default it
# would cut every deployed guest's transport every five minutes. Same trap the
# sandbox layer documents in modal-sandbox-env.ts, matched to the same 4h value.
FUNCTION_TIMEOUT_SECS = 4 * 60 * 60

# ── Guest-sandbox resources ──────────────────────────────────────────────────
#
# One sandbox per slug per replica (per-slug horizontal scaling was deleted
# for simplicity — see sandbox-resolve.ts). If sessions stutter at load, the
# playback stats (concealedSamples per turn) are the signal.
#
# Reservation and cap are deliberately DIFFERENT numbers, because a guest's
# load is bimodal. It idles as a voice session (~250 MB, a few % of a core),
# then a `test_agent` or Publish build spends seconds in the aai CLI's
# bundler, which peaks near 1.7 GB and wants several cores. Sizing one number
# for both is a choice between an unaffordable idle sandbox and a build that
# cannot run: pinned at 1 GiB / 1 core, guests wedged at the cgroup ceiling in
# permanent direct-reclaim — a core burned on full GCs that can never free
# rolldown's *native* Rust allocations. That presents as a hung build, not an
# OOM, and it hits Publish too: the cap is on the cgroup, so spawning the
# bundler as a child process does not escape it.
#
# So: reserve the idle shape, cap the build shape. The cap only has to clear
# the bundler's peak with headroom for a co-resident session. 4096 MiB is
# also the ceiling modal-sandbox-env.ts clamps to.
SANDBOX_CPU = 1  # per-guest core reservation (Modal cpu)
SANDBOX_CPU_LIMIT = 4  # hard per-guest core cap, for builds (Modal cpuLimit)
SANDBOX_MEMORY_MB = 1024  # per-guest memory reservation (Modal memoryMiB)
SANDBOX_MEMORY_LIMIT_MB = 4096  # hard per-guest memory cap (Modal memoryLimitMiB)

# The studio service has no deploy recipe of its own: it is composed into THIS
# process (see "Two packages, ONE deployment" in CLAUDE.md), so the autoscaler
# numbers above govern the studio surface too. This comment used to point at
# `packages/aai-studio-server/modal_deploy.py`, which does not exist — a
# leftover from when the two were separate deployments, and misleading in the
# one way that costs real time: it sends a reader looking for a second set of
# these knobs.

image = build_image(
    port=PORT,
    extra_env={
        # A cap without its reservation throws at spawn (Modal rejects a bare
        # cap), so these four move together — see modal-sandbox-env.ts.
        "SANDBOX_CPU": str(SANDBOX_CPU),
        "SANDBOX_CPU_LIMIT": str(SANDBOX_CPU_LIMIT),
        "SANDBOX_MEMORY_MB": str(SANDBOX_MEMORY_MB),
        "SANDBOX_MEMORY_LIMIT_MB": str(SANDBOX_MEMORY_LIMIT_MB),
        # Guest sandboxes are placed by the SAME preference list this function
        # is pinned to — see "Guest sandboxes take the SAME list" above for the
        # per-operation measurement, and modal-sandbox-env.ts for the parser.
        # Comma-separated because that is what an operator setting this by hand
        # writes, and the spill entry is not optional: a single region is what
        # produced `Sandbox operation timed out` under load.
        "MODAL_SANDBOX_REGION": ",".join(REGIONS),
        # The autoscaler ceiling, readable by the process it bounds. It is the
        # MULTIPLIER on every per-replica pool, so the boot-time capacity check
        # cannot state the fleet's claim without it (platform-db-capacity.ts) —
        # and it went unstated: boot printed "capacity ok — 0 spare" on an
        # instance the claim overran by 20, the line above it naming the very
        # connections the budget was not counting. Exported rather than copied
        # into TypeScript so this stays the one place the number is decided;
        # `platform-db-budget.test.ts` reads it from here too.
        "MAX_CONTAINERS": str(MAX_CONTAINERS),
    },
)

app = modal.App("aai-server-web")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aai-server")],
    # A PREFERENCE with a fallback, never a single region — see "Region: a
    # FALLBACK LIST, us-east-2 first" above for the measurement that justifies
    # the preference and the outage that forbids dropping the fallback.
    region=REGIONS,
    cpu=1,
    memory=2048,
    # Autoscaler bounds — see the "Web-service autoscaling" block above.
    min_containers=MIN_CONTAINERS,
    max_containers=MAX_CONTAINERS,
    buffer_containers=BUFFER_CONTAINERS,
    # Shutdown is retire-and-exit (no session-drain wait): the node SIGTERM
    # handler delivers one drain request per agent guest, disposes the studio
    # broker, and exits — seconds, well inside this grace period. Modal
    # signals this Python runtime, not the node child — `run_node` below
    # forwards the stop signal and waits, which is the only reason the node
    # SIGTERM handler runs at all on scale-in/redeploy.
    scaledown_window=300,
    # Bounds one WebSocket's lifetime — see "Input timeout" above.
    timeout=FUNCTION_TIMEOUT_SECS,
)
@modal.concurrent(max_inputs=MAX_INPUTS, target_inputs=TARGET_INPUTS)
@modal.web_server(port=PORT, startup_timeout=180)
def server() -> None:
    # Before the port opens, so no request can outrun it. Modal's ASGI proxy
    # runs in THIS process and logs a full traceback every time a browser walks
    # away from an SSE stream — see install_proxy_noise_filter.
    install_proxy_noise_filter()
    env = os.environ.copy()
    # Modal injects MODAL_SERVER_URL into its containers pointing at an
    # internal Unix socket (/run/modal.sock) for the Python task runtime.
    # The node server's `modal` JS SDK prefers that variable over the public
    # API endpoint, so every guest-sandbox spawn would try to gRPC a socket
    # that doesn't serve it ("connect ENOENT /run/modal.sock"). Strip it so
    # the SDK uses api.modal.com with the tokens from the aai-server Secret.
    env.pop("MODAL_SERVER_URL", None)
    # Both surfaces in one process — see "One app, both surfaces" above. The
    # entry lives in aai-studio-server because that package is the composition
    # root for both apps; this one ships no entry of its own.
    env["AAI_SERVICE"] = "combined"
    # run_node (not a bare Popen) so container stop signals reach the node
    # process — its SIGTERM handler is what retires this replica's guest
    # sandboxes (see modal_image.run_node).
    run_node("packages/aai-studio-server/dist/index.mjs", env)
