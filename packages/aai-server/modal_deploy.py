# Copyright 2026 the AAI authors. MIT license.
"""Deploys the AAI platform server to Modal.

The server is a Node.js app; Modal runs it behind ``@modal.web_server``,
which proxies HTTP *and* WebSocket traffic (voice sessions are long-lived
WebSockets) to the node process listening inside the container.

Agent guest sandboxes are ALSO Modal Sandboxes (see modal-sandbox.ts), created
by the server at runtime under the ``aai-server`` Modal App using the
``MODAL_TOKEN_ID``/``MODAL_TOKEN_SECRET`` from the ``aai-server`` Secret.

Studio builds run in the STUDIO app's ``studio_build`` function (see
packages/aai-studio-server/modal_deploy.py) — deployed with the package
that owns the build-entry code, so the two can't skew. In combined mode
(no ``STUDIO_UPSTREAM_URL``) this server invokes it there too, so the
studio app must be deployed alongside this one.

Deploy (from the repo root, with the Python `modal` CLI authed via
`modal token new`):

    modal deploy packages/aai-server/modal_deploy.py
    # or: pnpm --filter aai-server deploy:modal (same command via pnpm)

Required Modal Secret named ``aai-server`` with (at least):

- ``MODAL_TOKEN_ID`` / ``MODAL_TOKEN_SECRET`` — for creating guest sandboxes
- ``SUPABASE_S3_ENDPOINT`` / ``SUPABASE_S3_ACCESS_KEY_ID`` /
  ``SUPABASE_S3_SECRET_ACCESS_KEY`` / ``SUPABASE_STORAGE_BUCKET`` — Supabase
  Storage (S3-compatible); optional ``SUPABASE_S3_REGION``
- ``SUPABASE_DB_URL`` — service-role Postgres connection string (Vault
  secrets + per-app databases)
- ``SUPABASE_URL`` / ``SUPABASE_PUBLISHABLE_KEY`` — Supabase Auth (studio
  browser/CLI email login; the publishable ``sb_publishable_...`` key from
  the dashboard's API Keys page). Missing means browser login is disabled
  (a boot warning says so) — raw API-key bearers still work
- ``SUPABASE_SERVICE_ROLE_KEY`` — with ``SUPABASE_URL``, the Supabase
  Realtime change streams (sandbox invalidation, studio preview push)
- optional: ``ASSEMBLYAI_API_KEY``

Do NOT set ``SANDBOX_POOL_SIZE`` in the Secret: the warm sandbox pool is
deliberately disabled in production (``SANDBOX_POOL_SIZE=0`` in the image
env below), and a Secret value would override the image env and re-enable
it — two idle billed guests per replica, per service.
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

# One region for the web server AND the guest sandboxes it creates (see the
# co-location rationale in CLAUDE.md's Modal notes). The studio app pins the
# same value in its own modal_deploy.py.
REGION = "us-east-2"

# ── Split services ───────────────────────────────────────────────────────────
#
# The node app serves one of three surfaces (AAI_SERVICE): the agent backend,
# the studio backend, or both combined. This deployment runs the split:
#
# - ``server`` (below) is the AGENT service and the single public origin.
#   When ``STUDIO_UPSTREAM_URL`` is present in the ``aai-server`` Secret it
#   boots as ``AAI_SERVICE=agent`` and reverse-proxies the studio surface
#   (``/``, ``/studio/*``, ``/studio-assets/*``) to that URL; when absent it
#   boots combined — same behavior as before the split, so a fresh
#   deployment works before the operator wires the studio URL.
# - ``studio`` (below) is the STUDIO service. After the first deploy, copy
#   its printed web URL into the Secret as ``STUDIO_UPSTREAM_URL`` and
#   redeploy — one-time setup. It is internal-only in spirit (browsers go
#   through the agent origin), scaled for bursty LLM-bound chat turns
#   rather than long-lived voice sessions.
#
# Cross-service coordination needs no wiring here: both services share the
# Supabase Postgres (locks, rate limits, workspaces), and a studio Publish
# reaches the agent service's resident sandboxes via the agents row's
# Supabase Realtime change stream (see sandbox-resolve.ts).

# ── Web-service autoscaling ──────────────────────────────────────────────────
#
# The server holds no cross-request state (coordination lives in Supabase —
# see CLAUDE.md "Stateless server"), so replicas are interchangeable:
# scale-out is safe, and scale-in/redeploys drain via the node process's
# SIGTERM handler. Voice sessions live in the guest sandboxes (browsers dial
# the sandbox tunnel directly), so a replica going down only costs the
# sandboxes it owns; clients auto-reconnect (?sessionId) and re-broker.
#
# Each in-flight HTTP request and each open WebSocket counts as one input, so
# the numbers below are coupled to the node server's own per-replica
# WebSocket cap (MAX_CONNECTIONS, exported in the image env — the server
# rejects upgrade #N+1 itself, as a load-shed backstop):
#
# - TARGET_INPUTS is the autoscaler's set point: Modal adds containers once
#   per-container concurrency crosses it. Set below MAX_CONNECTIONS so new
#   capacity is warming BEFORE any replica starts refusing sessions.
# - MAX_INPUTS caps what one container absorbs while scale-up is in flight:
#   MAX_CONNECTIONS long-lived sessions plus headroom for short HTTP traffic
#   (health checks, studio API, deploys).
MIN_CONTAINERS = 1  # always-warm floor: voice sessions are latency-sensitive
MAX_CONTAINERS = 10  # cost guard; raise deliberately, not by incident
BUFFER_CONTAINERS = 1  # one pre-warmed spare while active, so bursts land warm
MAX_CONNECTIONS = 100  # per-replica WebSocket cap (node server enforces it)
TARGET_INPUTS = 75  # scale-out set point (~75% of the session cap)
MAX_INPUTS = 150  # sessions at cap + short-request headroom

# ── Input timeout ────────────────────────────────────────────────────────────
#
# A WebSocket is ONE Modal input for its whole lifetime, so the function
# timeout bounds CALL DURATION, not request latency — and Modal's default is
# 300s. Unset, that silently severed every host-mode voice session at exactly
# five minutes, mid-word, surfacing to the client as a bare "not connected"
# with nothing logged server-side. (Browser sessions dial the guest sandbox's
# tunnel directly and never touch this path; `?host=1` sessions run IN this
# process, which is what puts them under the cap.) Same trap the sandbox layer
# already documents in modal-sandbox-env.ts, matched to the same 4h value.
#
# This is a backstop, not the idle policy: session-core's own watchdog
# (`idleTimeoutMs`, 5 min) reaps quiet sessions and closes their sockets, and
# unlike a wall-clock cap it re-arms on every inbound audio frame.
FUNCTION_TIMEOUT_SECS = 4 * 60 * 60

# ── Guest-sandbox autoscaling ────────────────────────────────────────────────
#
# Horizontal per-slug sandbox scaling (sandbox-scale.ts): the broker routes
# each new session to the least-loaded of a slug's sandboxes and spawns an
# overflow replica when all are at SANDBOX_MAX_SESSIONS. The session cap only
# makes sense against pinned resources, so the two go together — unset, a
# guest runs on Modal's sandbox defaults (0.125 core / 128 MiB reserved,
# burstable), which is not a denominator you can size a cap against.
#
# 8 sessions on 1 core budgets ~5% core per session for the audio relay path
# and leaves ~half the core for tool-call spikes (tool code shares the guest's
# one event loop with every co-resident session — same-tenant only, since
# scaling is per slug). Broker counts are sampled, not reserved, so the cap
# needs that slack: simultaneous brokers can land a session or two past it.
# 1 GiB covers the ~250 MB harness+bundle baseline plus sessions with ~3×
# headroom. With SANDBOX_MAX_REPLICAS=4 this is 32 sessions per slug per web
# replica — saturating well inside MAX_CONNECTIONS above. If sessions stutter
# at load, the playback stats (concealedSamples per turn) are the signal to
# lower the cap; raise it only off those same measurements.
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
# So: reserve the idle shape, cap the build shape. The session cap above is
# sized against the RESERVATION (the resources a guest always has), while the
# cap only has to clear the bundler's peak with headroom for a co-resident
# session. 4096 MiB is also the ceiling modal-sandbox-env.ts clamps to.
SANDBOX_MAX_SESSIONS = 8  # live sessions per guest sandbox before scale-out
SANDBOX_MAX_REPLICAS = 4  # sandboxes per slug (primary included) per replica
SANDBOX_CPU = 1  # per-guest core reservation (Modal cpu)
SANDBOX_CPU_LIMIT = 4  # hard per-guest core cap, for builds (Modal cpuLimit)
SANDBOX_MEMORY_MB = 1024  # per-guest memory reservation (Modal memoryMiB)
SANDBOX_MEMORY_LIMIT_MB = 4096  # hard per-guest memory cap (Modal memoryLimitMiB)

# The studio service deploys as its OWN Modal app from its own package —
# see packages/aai-studio-server/modal_deploy.py. CI deploys each app only
# when its package version changed (changeset-driven).

image = build_image(
    port=PORT,
    # Guest sandboxes are pinned to the web server's region (above).
    region=REGION,
    extra_env={
        # Per-replica WebSocket cap, kept in lockstep with the autoscaler
        # numbers above (TARGET_INPUTS / MAX_INPUTS) — the server refuses
        # upgrades past it, so Modal must scale out before it is reached.
        "MAX_CONNECTIONS": str(MAX_CONNECTIONS),
        # Guest-sandbox autoscaling — see the block above. Values in the
        # aai-server Secret override these (secrets layer over image env).
        "SANDBOX_MAX_SESSIONS": str(SANDBOX_MAX_SESSIONS),
        "SANDBOX_MAX_REPLICAS": str(SANDBOX_MAX_REPLICAS),
        # A cap without its reservation throws at spawn (Modal rejects a bare
        # cap), so these four move together — see modal-sandbox-env.ts.
        "SANDBOX_CPU": str(SANDBOX_CPU),
        "SANDBOX_CPU_LIMIT": str(SANDBOX_CPU_LIMIT),
        "SANDBOX_MEMORY_MB": str(SANDBOX_MEMORY_MB),
        "SANDBOX_MEMORY_LIMIT_MB": str(SANDBOX_MEMORY_LIMIT_MB),
        # Warm sandbox pool: keep at ZERO. "0" disables the pool (see
        # resolvePoolSize in _boot.ts) — pre-warmed guests are idle billed
        # sandboxes per replica, and cold starts go through the warm-pool
        # fallback path anyway. NOTE: the aai-server Secret overrides image
        # env, so this only holds while the Secret does not set it.
        "SANDBOX_POOL_SIZE": "0",
    },
)

app = modal.App("aai-server-web")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aai-server")],
    region=REGION,
    cpu=1,
    memory=2048,
    # Autoscaler bounds — see the "Web-service autoscaling" block above.
    min_containers=MIN_CONTAINERS,
    max_containers=MAX_CONTAINERS,
    buffer_containers=BUFFER_CONTAINERS,
    # SHUTDOWN_DRAIN_MS (120s) + sandbox teardown must fit in the container's
    # grace period. Modal signals this Python runtime, not the node child —
    # `run_node` below forwards the stop signal and waits, which is the only
    # reason the node SIGTERM handler (drain + guest-sandbox teardown) runs
    # at all on scale-in/redeploy.
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
    # Agent service when the studio upstream is wired (see "Split services"
    # above); the combined single-process entry (aai-studio-server package)
    # otherwise, so a fresh deployment works pre-wiring.
    if env.get("STUDIO_UPSTREAM_URL"):
        entry = "packages/aai-server/dist/index.mjs"
    else:
        env["AAI_SERVICE"] = "combined"
        entry = "packages/aai-studio-server/dist/index.mjs"
    # run_node (not a bare Popen) so container stop signals reach the node
    # process — its SIGTERM handler is what drains sessions and terminates
    # this replica's guest sandboxes (see modal_image.run_node).
    run_node(entry, env)
