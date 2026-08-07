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

# Keep in lockstep with the root package.json ``packageManager`` field. Drift is
# self-healing but not free: pnpm 10 manages its own version, so a mismatched
# global install silently downloads the declared one on first invocation.
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
# shutdown before force-killing it. Shutdown is retire-and-exit (one drain
# request per agent guest, no session-drain wait), so this is generous
# headroom rather than a budget the shutdown consumes; Modal's SIGKILL
# backstop still bounds the container's real grace period.
NODE_STOP_TIMEOUT_SECS = 150


def run_node(entry: str, env: dict[str, str]) -> subprocess.Popen:
    """Spawn the node server and hand container stop signals to it.

    Modal stops a container by signaling this Python runtime process — a
    child spawned with a bare ``subprocess.Popen`` receives nothing of its
    own. That meant the node server's SIGTERM handler —
    ``teardownSandboxes`` (packages/aai-server/teardown-sandboxes.ts), the
    only thing that retires the replica's resident guest sandboxes — never
    ran on a scale-in or redeploy. Every guest the
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


def build_image(*, port: int, extra_env: dict[str, str] | None = None):
    """The shared image, parameterized only by per-app env.

    Deliberately does NOT bake ``MODAL_SANDBOX_REGION``: guest sandboxes are
    placed by Modal for CAPACITY. Pinning them to the service's own region
    (once ``us-east-2``) bought co-location at the cost of restricting every
    spawn to one region's free capacity, and a spawn that cannot be scheduled
    in ~50s fails with ``Sandbox operation timed out`` out of ``tunnels()`` —
    a studio chat or voice session that never starts. The RTT the pin was
    added for is the smaller cost: agent guests hold no host channel at all
    (clients dial the sandbox tunnel directly), so only the studio's
    control-channel round trips pay it.

    ``MODAL_SANDBOX_REGION`` is still read by ``modal-sandbox-env.ts``, so an
    operator can pin placement per environment without a code change.
    """
    return (
        # ``add_python`` layers the Modal runtime's Python next to Node — the
        # container entrypoint is Modal's Python runtime, which spawns node.
        #
        # Keep the major in lockstep with ``DEFAULT_SANDBOX_IMAGE``
        # (aai-server/modal-sandbox.ts): the host and its guest sandboxes run
        # the same runtime by design, which is what makes the harness the dev
        # server (see "Dev/prod parity" in CLAUDE.md).
        modal.Image.from_registry("node:26-slim", add_python="3.13")
        .apt_install("ca-certificates")
        # pnpm comes from npm, NOT corepack. Node stopped shipping corepack in
        # its official distributions at 25 (TSC vote; it remains bundled only
        # in 24 and earlier), so the `corepack enable` this line replaced —
        # untouched by the 24 → 26 bump — failed the image build outright:
        # `/bin/sh: 1: corepack: not found`, container exit status 127, before
        # a single package was fetched. npm is still bundled, and the guest
        # harness image already depends on that (see the `RUN npm install` in
        # aai-server/modal-harness-image.ts), so this adds no new assumption.
        .run_commands(f"npm install --global --no-audit --no-fund pnpm@{PNPM_VERSION}")
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
