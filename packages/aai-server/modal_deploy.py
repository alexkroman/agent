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
  secrets + per-app databases)
- ``SUPABASE_URL`` / ``SUPABASE_PUBLISHABLE_KEY`` — Supabase Auth (studio
  browser/CLI email login; the publishable ``sb_publishable_...`` key from
  the dashboard's API Keys page). Missing means browser login is disabled
  (a boot warning says so) — raw API-key bearers still work
- ``SUPABASE_SERVICE_ROLE_KEY`` — with ``SUPABASE_URL``, the Supabase
  Realtime change streams (sandbox invalidation, studio preview push) AND
  Storage reads/writes of deploy artifacts
- optional: ``ASSEMBLYAI_API_KEY``

"""

import os
import sys
from pathlib import Path

import modal

# The image recipe is shared with the studio app so the two services can never
# run different dependency trees — see scripts/modal_image.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "scripts"))
from modal_image import build_image, run_node  # noqa: E402

PORT = 8080

# ── Region: deliberately UNPINNED ────────────────────────────────────────────
#
# The web server is placed by Modal for CAPACITY, the same trade guest
# sandboxes already make (see build_image in scripts/modal_image.py). It was
# pinned to ``us-east-2``, which confines an always-warm replica to one
# region's spare capacity — and when that runs dry Modal places NOTHING.
#
# That outage is worth describing, because none of its symptoms name a region:
# the app sits at ``deployed`` with ZERO tasks despite MIN_CONTAINERS=1 below,
# every request hangs until the client times out having received zero bytes,
# and — because no container is ever created — there are NO logs whatsoever,
# not even a crash. ``modal app logs`` replays the last image build and then
# streams silence, which reads as a wedged control plane rather than a
# placement failure. Nothing recovers it: a redeploy or ``modal app rollover``
# only re-asks for a container that still cannot be placed.
#
# The locality this cost is small and shrinking: voice clients dial the guest
# sandbox's tunnel directly, so no session traffic passes through here at all,
# and the Supabase round trips that remain are not inside a latency budget.
# Re-pin per environment (Modal's ``region`` takes a list, so prefer a
# FALLBACK list over a single value) if a measurement ever justifies it — but
# never for a service holding a warm floor.

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
# short HTTP traffic plus the studio proxy's SSE streams:
#
# - TARGET_INPUTS is the autoscaler's set point: Modal adds containers once
#   per-container concurrency crosses it.
# - MAX_INPUTS caps what one container absorbs while scale-up is in flight.
MIN_CONTAINERS = 1  # always-warm floor: session brokering is latency-sensitive
MAX_CONTAINERS = 10  # cost guard; raise deliberately, not by incident
BUFFER_CONTAINERS = 0  # no pre-warmed spare; bursts wait on container cold start
TARGET_INPUTS = 75  # scale-out set point
MAX_INPUTS = 150  # concurrent-request cap per container

# ── Input timeout ────────────────────────────────────────────────────────────
#
# A WebSocket is ONE Modal input for its whole lifetime, so the function
# timeout bounds CALL DURATION, not request latency — and Modal's default is
# 300s. Unset, that silently severed every in-process voice session (the old
# `?host=1` host mode, since removed) at exactly five minutes, mid-word,
# surfacing to the client as a bare "not connected" with nothing logged
# server-side. Sessions now never run in this process — browsers dial the
# guest sandbox's tunnel directly, and `/:slug/websocket` upgrades are
# handshake redirects — but the studio proxy's SSE streams and any future
# long-lived input sit under the same cap, so it stays pinned rather than
# inherited. Same trap the sandbox layer documents in modal-sandbox-env.ts,
# matched to the same 4h value.
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

# The studio service deploys as its OWN Modal app from its own package —
# see packages/aai-studio-server/modal_deploy.py. CI deploys each app only
# when its package version changed (changeset-driven).

image = build_image(
    port=PORT,
    extra_env={
        # A cap without its reservation throws at spawn (Modal rejects a bare
        # cap), so these four move together — see modal-sandbox-env.ts.
        "SANDBOX_CPU": str(SANDBOX_CPU),
        "SANDBOX_CPU_LIMIT": str(SANDBOX_CPU_LIMIT),
        "SANDBOX_MEMORY_MB": str(SANDBOX_MEMORY_MB),
        "SANDBOX_MEMORY_LIMIT_MB": str(SANDBOX_MEMORY_LIMIT_MB),
    },
)

app = modal.App("aai-server-web")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aai-server")],
    # No region= — see "Region: deliberately UNPINNED" above.
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
