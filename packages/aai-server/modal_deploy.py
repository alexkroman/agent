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
- optional: ``PINECONE_API_KEY`` / ``PINECONE_INDEX``, ``ASSEMBLYAI_API_KEY``,
  ``BRAVE_API_KEY``, ``SANDBOX_POOL_SIZE``
"""

import os
import subprocess
import sys
from pathlib import Path

import modal

# The image recipe is shared with the studio app so the two services can never
# run different dependency trees — see scripts/modal_image.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "scripts"))
from modal_image import build_image  # noqa: E402

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
# Supabase Postgres (locks, epochs, rate limits, workspaces), and a studio
# Publish reaches the agent service's resident sandboxes via slug epochs.

# ── Web-service autoscaling ──────────────────────────────────────────────────
#
# The server holds no cross-request state (coordination and session-resume
# state live in Supabase — see CLAUDE.md "Stateless server"), so replicas are
# interchangeable: scale-out is safe, and scale-in/redeploys drain via the
# node process's SIGTERM handler, with live sessions persisting their resume
# state and clients auto-reconnecting (?sessionId) onto surviving replicas.
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
    # grace period — the node process handles SIGTERM itself, persisting live
    # sessions' resume state before exiting (see sandbox.ts shutdown).
    scaledown_window=300,
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
    subprocess.Popen(["node", entry], cwd="/app", env=env)
