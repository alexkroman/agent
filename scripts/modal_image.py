# Copyright 2026 the AAI authors. MIT license.
"""The monorepo container image, shared by both service deployments.

The agent app (packages/aai-server/modal_deploy.py) and the studio app
(packages/aai-studio-server/modal_deploy.py) must run the EXACT same
dependency tree — the same clean-tree install and the same workspace build the
tests exercised. That invariant used to be asserted by a comment in the studio
script ("Mirrors the agent app's image") and enforced by nothing: the build
command enumerates seven workspace packages, so adding one meant editing two
Python files, and a miss produced two services running different trees with no
build failure to catch it.

What stays per-app is the deploy *policy* — Modal app name, autoscaling
numbers, region, and any extra env — because that is precisely what the split
into two services exists to let diverge.
"""

import atexit
import contextlib
import os
import signal
import subprocess
from pathlib import Path

import modal

# Repo root (this file lives at scripts/modal_image.py).
REPO_ROOT = Path(__file__).resolve().parent.parent

PNPM_VERSION = "10.29.3"

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

# SDK + UI (default client) + CLI (client bundler) + guest harness + studio
# client + both servers. Order matters: each depends on the ones before it.
BUILD_COMMAND = (
    "pnpm --filter aai build"
    " && pnpm --filter aai-ui build"
    " && pnpm --filter @alexkroman1/aai-cli build"
    " && pnpm --filter aai-guest build"
    " && pnpm --filter aai-studio-client build"
    " && pnpm --filter aai-server build"
    " && pnpm --filter aai-studio-server build"
)

GUEST_HARNESS_PATH = "/app/packages/aai-guest/dist/harness.mjs"

# How long a container stop waits for the node child to finish its own
# shutdown before force-killing it. Sized to cover the node server's session
# drain (SHUTDOWN_DRAIN_MS, default 120s) plus guest-sandbox teardown slack;
# Modal's SIGKILL backstop still bounds the container's real grace period.
NODE_STOP_TIMEOUT_SECS = 150


def run_node(entry: str, env: dict[str, str]) -> subprocess.Popen:
    """Spawn the node server and hand container stop signals to it.

    Modal stops a container by signaling this Python runtime process — a
    child spawned with a bare ``subprocess.Popen`` receives nothing of its
    own. That meant the node server's SIGTERM handler — the session drain
    plus ``teardownSandboxes`` (packages/aai-server/teardown-sandboxes.ts),
    the only thing that terminates the replica's warm-pool and resident
    guest sandboxes — never ran on a scale-in or redeploy. Every guest the
    replica owned was orphaned: its harness self-exits after the 5-minute
    orphan timeout, and the sandbox then lingers as a 2-3 MiB
    ``sleep infinity`` shell until Modal's 15-minute idle timer reaps it —
    ~20 minutes of billed zombie per guest, on every deploy.

    Two hooks, because neither alone is reliable:

    - a SIGTERM/SIGINT handler (chained to whatever was installed before it)
      forwards the signal to node and waits for it to exit — but
      ``signal.signal`` only works on the main thread, and Modal may run
      this off it;
    - an ``atexit`` fallback catches the runtime handling the signal itself
      and exiting normally.

    Both paths funnel into one memoized ``stop()``, and the node shutdown
    handler is idempotent, so double delivery is harmless.
    """
    proc = subprocess.Popen(["node", entry], cwd="/app", env=env)
    stopped = False

    def stop() -> None:
        nonlocal stopped
        if stopped or proc.poll() is not None:
            return
        stopped = True
        with contextlib.suppress(ProcessLookupError):
            proc.send_signal(signal.SIGTERM)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=NODE_STOP_TIMEOUT_SECS)
        if proc.poll() is None:
            proc.kill()

    def install_forwarder(signum: int) -> None:
        previous = signal.getsignal(signum)

        def handler(sig: int, frame: object) -> None:
            stop()
            if callable(previous):
                previous(sig, frame)
            elif previous == signal.SIG_DFL:
                # Re-deliver with the default disposition so the runtime
                # still dies the way the platform expects.
                signal.signal(sig, signal.SIG_DFL)
                os.kill(os.getpid(), sig)

        signal.signal(signum, handler)

    for signum in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(ValueError):  # not the main thread
            install_forwarder(signum)

    atexit.register(stop)
    return proc


def build_image(*, port: int, region: str, extra_env: dict[str, str] | None = None):
    """The shared image, parameterized only by per-app env.

    ``region`` is baked in as ``MODAL_SANDBOX_REGION`` so guest sandboxes are
    co-located with the service that spawns them (an unpinned sandbox once
    landed on another continent, putting a transatlantic RTT inside voice
    turns).
    """
    return (
        # ``add_python`` layers the Modal runtime's Python next to Node — the
        # container entrypoint is Modal's Python runtime, which spawns node.
        modal.Image.from_registry("node:24-slim", add_python="3.13")
        .apt_install("ca-certificates")
        .run_commands(f"corepack enable && corepack prepare pnpm@{PNPM_VERSION} --activate")
        .add_local_dir(REPO_ROOT, remote_path="/app", copy=True, ignore=BUILD_IGNORE)
        .workdir("/app")
        .run_commands(
            "pnpm install --frozen-lockfile --ignore-scripts --prod=false",
            BUILD_COMMAND,
        )
        .env(
            {
                "NODE_ENV": "production",
                "PORT": str(port),
                "GUEST_HARNESS_PATH": GUEST_HARNESS_PATH,
                "MODAL_SANDBOX_REGION": region,
                **(extra_env or {}),
            }
        )
        # The container entrypoint re-imports the deploy script (Modal >= 1.0
        # no longer auto-mounts locally imported modules), and there this
        # module's `scripts/` directory does not exist — the deploy script's
        # sys.path insert resolves to /scripts inside the container. Mount
        # this module next to the entrypoint (/root/modal_image.py) so
        # `from modal_image import build_image` resolves at container start.
        .add_local_python_source("modal_image")
    )
