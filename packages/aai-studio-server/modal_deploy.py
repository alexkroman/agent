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
surface here, keeping one public origin. Studio builds run INSIDE each
project's guest sandbox through the aai CLI's own bundlers (see
aai-guest/studio-build.ts) — there is no build function or build backend
anymore.

    modal deploy packages/aai-studio-server/modal_deploy.py
    # or: pnpm --filter aai-studio-server deploy:modal
"""

import os
import subprocess
import sys
from pathlib import Path

import modal

# The image recipe is shared with the agent app so the two services can never
# run different dependency trees — see scripts/modal_image.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "scripts"))
from modal_image import build_image  # noqa: E402

PORT = 8080
REGION = "us-east-2"  # co-located with the agent app and guest sandboxes

# Chat turns are bounded HTTP/SSE requests — heavier per request than a voice
# relay but with no per-connection pinning, so the studio scales on fewer,
# busier inputs and can idle to zero.
STUDIO_MIN_CONTAINERS = 0
STUDIO_MAX_CONTAINERS = 5
STUDIO_TARGET_INPUTS = 20
STUDIO_MAX_INPUTS = 40

# Byte-for-byte the agent app's image (see scripts/modal_image.py): the same
# clean-tree install and workspace build, so both services run the exact
# dependency tree the tests exercised.
image = build_image(port=PORT, region=REGION)

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
