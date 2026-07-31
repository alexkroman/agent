# Copyright 2026 the AAI authors. MIT license.
"""Deploys the AAI platform server to Modal.

The server is a Node.js app; Modal runs it behind ``@modal.web_server``,
which proxies HTTP *and* WebSocket traffic (voice sessions are long-lived
WebSockets) to the node process listening inside the container.

Agent guest sandboxes are ALSO Modal Sandboxes (see modal-sandbox.ts), created
by the server at runtime under the ``aai-server`` Modal App using the
``MODAL_TOKEN_ID``/``MODAL_TOKEN_SECRET`` from the ``aai-server`` Secret.

Studio builds run in the ``studio_build`` function below (same app, same
image, separate containers, no secrets) — the web server invokes it per
build via the Modal JS SDK (see studio/studio-build-runner.ts).

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
import tempfile
from pathlib import Path

import modal

PORT = 8080
PNPM_VERSION = "10.29.3"

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

# Studio service scaling: requests are bounded HTTP/SSE (chat turns, file
# edits, builds shipped to studio_build) — heavier per request than a voice
# relay but with no per-connection pinning, so it scales on fewer, busier
# inputs and can idle to zero.
STUDIO_MIN_CONTAINERS = 0
STUDIO_MAX_CONTAINERS = 5
STUDIO_TARGET_INPUTS = 20
STUDIO_MAX_INPUTS = 40

# One region for the web server AND the guest sandboxes it creates. Left
# unpinned, Modal placed the server in us-east-1 (AWS) and guest sandboxes in
# uk-london-1 (OCI), so every host<->guest RPC (ctx.db, Vector, guest fetch
# proxy, bundle/load) paid a transatlantic RTT inside latency-budgeted voice
# turns. The server functions pin ``region=REGION`` and the image exports the
# same value as ``MODAL_SANDBOX_REGION``, which modal-sandbox.ts passes to
# every ``sandboxes.create`` — co-location holds by construction, and moving
# the deployment is a one-line change here.
REGION = "us-east-2"

# Repo root (this file lives at packages/aai-server/modal_deploy.py).
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Build artifacts and local state must not leak into the image build context —
# the image installs and builds from a clean tree.
BUILD_IGNORE = [
    "**/node_modules",
    "**/dist",
    "**/.turbo",
    ".git",
    ".tsbuildinfo",
    "**/*.local",
    "**/.env",
    "**/.env.*",
]

image = (
    # ``add_python`` layers the Modal runtime's Python next to Node — the
    # container entrypoint is Modal's Python runtime, which then spawns node.
    modal.Image.from_registry("node:24-slim", add_python="3.13")
    .apt_install("ca-certificates")
    .run_commands(f"corepack enable && corepack prepare pnpm@{PNPM_VERSION} --activate")
    .add_local_dir(REPO_ROOT, remote_path="/app", copy=True, ignore=BUILD_IGNORE)
    .workdir("/app")
    .run_commands(
        "pnpm install --frozen-lockfile --ignore-scripts --prod=false",
        # SDK + UI (default client) + CLI (client bundler) + studio client + server
        "pnpm --filter aai build"
        " && pnpm --filter aai-ui build"
        " && pnpm --filter @alexkroman1/aai-cli build"
        " && pnpm --filter aai-studio-client build"
        " && pnpm --filter aai-server build",
    )
    .env(
        {
            "NODE_ENV": "production",
            "PORT": str(PORT),
            "GUEST_HARNESS_PATH": "/app/packages/aai-server/dist/guest/deno-harness.mjs",
            # Studio builds run in the studio_build function below, not in the
            # web server's process (see studio/studio-build-runner.ts).
            "STUDIO_BUILD_BACKEND": "modal",
            # Guest sandboxes are pinned to the web server's region (above).
            "MODAL_SANDBOX_REGION": REGION,
            # Per-replica WebSocket cap, kept in lockstep with the autoscaler
            # numbers above (TARGET_INPUTS / MAX_INPUTS) — the server refuses
            # upgrades past it, so Modal must scale out before it is reached.
            "MAX_CONNECTIONS": str(MAX_CONNECTIONS),
        }
    )
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
    # above); combined otherwise, so a fresh deployment works pre-wiring.
    env.setdefault("AAI_SERVICE", "agent" if env.get("STUDIO_UPSTREAM_URL") else "combined")
    subprocess.Popen(["node", "packages/aai-server/dist/index.mjs"], cwd="/app", env=env)


# The standalone studio service — see "Split services" above. Same image and
# Secret as the agent service (it deploys bundles, runs test_agent sandboxes,
# and invokes studio_build), but its own containers and scaling policy, so
# LLM-bound chat turns never compete with live voice sessions for CPU.
@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aai-server")],
    region=REGION,
    cpu=1,
    memory=2048,
    min_containers=STUDIO_MIN_CONTAINERS,
    max_containers=STUDIO_MAX_CONTAINERS,
    # Chat turns are bounded requests (no session drain); the window only
    # needs to outlast in-flight turns.
    scaledown_window=120,
)
@modal.concurrent(max_inputs=STUDIO_MAX_INPUTS, target_inputs=STUDIO_TARGET_INPUTS)
@modal.web_server(port=PORT, startup_timeout=180)
def studio() -> None:
    env = os.environ.copy()
    env.pop("MODAL_SERVER_URL", None)  # same JS-SDK footgun as `server`
    env["AAI_SERVICE"] = "studio"
    subprocess.Popen(["node", "packages/aai-server/dist/index.mjs"], cwd="/app", env=env)


# The studio build worker. The web server ships each studio build here (see
# studio/studio-build-runner.ts) so Vite/Rollup over untrusted workspace
# trees never competes with live voice sessions for the web container's CPU
# — and never runs in the process that holds platform credentials.
# Deliberately **no secrets attached**: a build needs the image's
# node_modules and nothing else. Same image as the server, so the build sees
# exactly the dependency tree the in-process path used.
@app.function(image=image, region=REGION, cpu=2, memory=2048, timeout=300)
def studio_build(request: str) -> str:
    """Run one studio workspace build (worker and/or client) out of process.

    ``request``/return value are the JSON wire format defined in
    studio/studio-build-protocol.ts. Build failures come back as data in the
    response (the coding agent acts on them); a raised error here means the
    build entry itself broke.
    """
    with tempfile.TemporaryDirectory() as td:
        request_path = Path(td) / "request.json"
        response_path = Path(td) / "response.json"
        request_path.write_text(request)
        proc = subprocess.run(
            [
                "node",
                "packages/aai-server/dist/studio/studio-build-entry.mjs",
                str(request_path),
                str(response_path),
            ],
            cwd="/app",
            capture_output=True,
            text=True,
            timeout=280,
        )
        if response_path.exists():
            return response_path.read_text()
        raise RuntimeError(
            f"studio build entry wrote no response (exit {proc.returncode}): "
            f"{proc.stderr[-2000:]}"
        )
