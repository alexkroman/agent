# Copyright 2026 the AAI authors. MIT license.
"""Deploys the AAI STUDIO service to Modal — its own app, its own scaling.

The studio is the browser coding agent (chat + workspace editor + publish).
It shares the monorepo image recipe with the agent service but deploys as a
separate Modal app so CI can ship each service independently: the deploy
workflow (.github/workflows/deploy.yml) redeploys an app only when its
package's version changed, i.e. when a changeset touched it.

Wiring: deploy this app, copy the printed web URL into the ``aai-server``
Modal Secret as ``STUDIO_UPSTREAM_URL``, and redeploy the agent app — its
``server`` function then boots in agent mode and reverse-proxies the studio
surface here, keeping one public origin. Studio builds run in this app's
``studio_build`` function (STUDIO_BUILD_MODAL_APP env overrides): the build
entry's code lives in this package, so a changeset touching it ships both
— see DEFAULT_BUILD_APP in studio-build-runner.ts.

    modal deploy packages/aai-studio-server/modal_deploy.py
    # or: pnpm --filter aai-studio-server deploy:modal
"""

import os
import subprocess
import tempfile
from pathlib import Path

import modal

PORT = 8080
PNPM_VERSION = "10.29.3"
REGION = "us-east-2"  # co-located with the agent app and guest sandboxes

# Chat turns are bounded HTTP/SSE requests — heavier per request than a voice
# relay but with no per-connection pinning, so the studio scales on fewer,
# busier inputs and can idle to zero.
STUDIO_MIN_CONTAINERS = 0
STUDIO_MAX_CONTAINERS = 5
STUDIO_TARGET_INPUTS = 20
STUDIO_MAX_INPUTS = 40

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Mirrors the agent app's image (packages/aai-server/modal_deploy.py) — same
# clean-tree install + workspace build, so both services run the exact
# dependency tree the tests exercised.
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
    modal.Image.from_registry("node:24-slim", add_python="3.13")
    .apt_install("ca-certificates")
    .run_commands(f"corepack enable && corepack prepare pnpm@{PNPM_VERSION} --activate")
    .add_local_dir(REPO_ROOT, remote_path="/app", copy=True, ignore=BUILD_IGNORE)
    .workdir("/app")
    .run_commands(
        "pnpm install --frozen-lockfile --ignore-scripts --prod=false",
        "pnpm --filter aai build"
        " && pnpm --filter aai-ui build"
        " && pnpm --filter @alexkroman1/aai-cli build"
        " && pnpm --filter aai-studio-client build"
        " && pnpm --filter aai-server build"
        " && pnpm --filter aai-studio-server build",
    )
    .env(
        {
            "NODE_ENV": "production",
            "PORT": str(PORT),
            "GUEST_HARNESS_PATH": "/app/packages/aai-server/dist/guest/deno-harness.mjs",
            "STUDIO_BUILD_BACKEND": "modal",
            "MODAL_SANDBOX_REGION": REGION,
        }
    )
)

app = modal.App("aai-studio-web")


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
    env.pop("MODAL_SERVER_URL", None)  # same JS-SDK footgun as the agent app
    env["AAI_SERVICE"] = "studio"
    subprocess.Popen(
        ["node", "packages/aai-studio-server/dist/index.mjs"], cwd="/app", env=env
    )


# The studio build worker. Both services ship each studio build here (see
# studio-build-runner.ts) so Vite/Rollup over untrusted workspace trees
# never competes with live voice sessions for a web container's CPU — and
# never runs in a process that holds platform credentials. Deliberately
# **no secrets attached**: a build needs the image's node_modules and
# nothing else. Same image as the services, so the build sees exactly the
# dependency tree they run on.
@app.function(image=image, region=REGION, cpu=2, memory=2048, timeout=300)
def studio_build(request: str) -> str:
    """Run one studio workspace build (worker and/or client) out of process.

    ``request``/return value are the JSON wire format defined in
    studio-build-protocol.ts. Build failures come back as data in the
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
                "packages/aai-studio-server/dist/studio-build-entry.mjs",
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
