# Copyright 2026 the AAI authors. MIT license.
"""Deploys the AAI platform server to Modal.

The server is a Node.js app; Modal runs it behind ``@modal.web_server``,
which proxies HTTP *and* WebSocket traffic (voice sessions are long-lived
WebSockets) to the node process listening inside the container.

Agent guest sandboxes are ALSO Modal Sandboxes (see modal-sandbox.ts), created
by the server at runtime under the ``aai-server`` Modal App using the
``MODAL_TOKEN_ID``/``MODAL_TOKEN_SECRET`` from the ``aai-server`` Secret.

Deploy:

    pnpm --filter aai-server deploy:modal
    # equivalent to: modal deploy packages/aai-server/modal_deploy.py

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
import shlex
import subprocess
from pathlib import Path

import modal

PORT = 8080
PNPM_VERSION = "10.29.3"

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
        }
    )
)

app = modal.App("aai-server-web")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aai-server")],
    cpu=1,
    memory=2048,
    # One always-warm replica: voice sessions are latency-sensitive and the
    # server pre-warms guest sandboxes at boot.
    min_containers=1,
    # SHUTDOWN_DRAIN_MS (120s) + sandbox teardown must fit in the container's
    # grace period — the node process handles SIGTERM itself.
    scaledown_window=300,
)
@modal.concurrent(max_inputs=200)
@modal.web_server(port=PORT, startup_timeout=180)
def server() -> None:
    cmd = "node packages/aai-server/dist/index.mjs"
    subprocess.Popen(shlex.split(cmd), cwd="/app", env=os.environ.copy())
