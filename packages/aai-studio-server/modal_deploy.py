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
import sys
from pathlib import Path

import modal

# The image recipe is shared with the agent app so the two services can never
# run different dependency trees — see scripts/modal_image.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "scripts"))
from modal_image import build_image, run_node  # noqa: E402

PORT = 8080
REGION = "us-east-2"  # co-located with the agent app and guest sandboxes

# Chat turns are bounded HTTP/SSE requests — heavier per request than a voice
# relay but with no per-connection pinning, so the studio scales on fewer,
# busier inputs and can idle to zero.
STUDIO_MIN_CONTAINERS = 0
STUDIO_MAX_CONTAINERS = 5
STUDIO_TARGET_INPUTS = 20
STUDIO_MAX_INPUTS = 40

# Modal's default function timeout (300s) bounds each input, and a long-lived
# response is ONE input for its whole lifetime — so this bounds CALL DURATION,
# not request latency (the trap the agent app documents at FUNCTION_TIMEOUT_SECS
# and modal-sandbox-env.ts documents for sandboxes).
#
# Two kinds of input run long here. Publish can boot a cold guest sandbox and
# run a full in-guest `aai deploy` (typecheck, bundle, upload) inside one
# request. And — contrary to what this comment used to claim — the studio DOES
# serve long-lived responses: `GET /studio/events` and
# `GET /studio/projects/<x>/events` are SSE streams a browser holds open for as
# long as a project is on screen. (Only WebSockets were ruled out; chat streams
# browser→guest directly, but these do not.) An SSE stream reaped at this
# ceiling is cut mid-body, which surfaces as the ASGI proxy's
# `ClientPayloadError: ... TransferEncodingError`.
#
# The streams are bounded server-side instead, well under this value, and end
# themselves gracefully so the client resubscribes — see SSE_MAX_STREAM_MS in
# studio-sse.ts. This must stay comfortably ABOVE that cap; lowering it below
# would put the truncation back.
STUDIO_FUNCTION_TIMEOUT_SECS = 30 * 60

# ── Guest-sandbox resources ──────────────────────────────────────────────────
#
# The studio spawns its OWN guest sandboxes (per-project coding-agent
# sessions, Publish's ephemeral deploy sandboxes, config extraction), and
# their load is even more build-heavy than the agent app's: `test_agent` and
# Publish run the aai CLI's bundler in-guest, which peaks near 1.7 GB across
# several cores. These are the same burst-range numbers as the agent app's
# guest-sandbox block (packages/aai-server/modal_deploy.py — see the full
# rationale there): reserve the idle shape, cap the build shape. Without
# them, a pinned 1 GiB / 1 core guest wedges at its cgroup ceiling in
# permanent direct-reclaim mid-build — it reads as a hung build, not an OOM.
# Keep the two apps' values in lockstep unless the divergence is deliberate.
#
# No SANDBOX_MAX_SESSIONS / SANDBOX_MAX_REPLICAS here: per-slug session
# scaling is the agent broker's knob — studio sandboxes are one coding-agent
# session per (scope, project).
SANDBOX_CPU = 1  # per-guest core reservation (Modal cpu)
SANDBOX_CPU_LIMIT = 4  # hard per-guest core cap, for builds (Modal cpuLimit)
SANDBOX_MEMORY_MB = 1024  # per-guest memory reservation (Modal memoryMiB)
SANDBOX_MEMORY_LIMIT_MB = 4096  # hard per-guest memory cap (Modal memoryLimitMiB)

# Byte-for-byte the agent app's image (see scripts/modal_image.py): the same
# clean-tree install and workspace build, so both services run the exact
# dependency tree the tests exercised.
image = build_image(
    port=PORT,
    region=REGION,
    extra_env={
        # Guest-sandbox burst range — see the block above. Values in the
        # aai-server Secret override these (secrets layer over image env).
        # A cap without its reservation throws at spawn (Modal rejects a bare
        # cap), so these four move together — see modal-sandbox-env.ts.
        "SANDBOX_CPU": str(SANDBOX_CPU),
        "SANDBOX_CPU_LIMIT": str(SANDBOX_CPU_LIMIT),
        "SANDBOX_MEMORY_MB": str(SANDBOX_MEMORY_MB),
        "SANDBOX_MEMORY_LIMIT_MB": str(SANDBOX_MEMORY_LIMIT_MB),
    },
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
    # Per-input ceiling — see "STUDIO_FUNCTION_TIMEOUT_SECS" above.
    timeout=STUDIO_FUNCTION_TIMEOUT_SECS,
)
@modal.concurrent(max_inputs=STUDIO_MAX_INPUTS, target_inputs=STUDIO_TARGET_INPUTS)
@modal.web_server(port=PORT, startup_timeout=180)
def studio() -> None:
    env = os.environ.copy()
    env.pop("MODAL_SERVER_URL", None)  # same JS-SDK footgun as the agent app
    env["AAI_SERVICE"] = "studio"
    # run_node (not a bare Popen) so container stop signals reach the node
    # process — its shutdown handler is what disposes the session broker's
    # per-project coding-agent sandboxes (see modal_image.run_node).
    run_node("packages/aai-studio-server/dist/index.mjs", env)
