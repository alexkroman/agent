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
    env = os.environ.copy()
    # Modal injects MODAL_SERVER_URL into its containers pointing at an
    # internal Unix socket (/run/modal.sock) for the Python task runtime.
    # The node server's `modal` JS SDK prefers that variable over the public
    # API endpoint, so every guest-sandbox spawn would try to gRPC a socket
    # that doesn't serve it ("connect ENOENT /run/modal.sock"). Strip it so
    # the SDK uses api.modal.com with the tokens from the aai-server Secret.
    env.pop("MODAL_SERVER_URL", None)
    subprocess.Popen(["node", "packages/aai-server/dist/index.mjs"], cwd="/app", env=env)


# The studio build worker. The web server ships each studio build here (see
# studio/studio-build-runner.ts) so Vite/Rollup over untrusted workspace
# trees never competes with live voice sessions for the web container's CPU
# — and never runs in the process that holds platform credentials.
# Deliberately **no secrets attached**: a build needs the image's
# node_modules and nothing else. Same image as the server, so the build sees
# exactly the dependency tree the in-process path used.
@app.function(image=image, cpu=2, memory=2048, timeout=300)
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
