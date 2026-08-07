# Copyright 2026 the AAI authors. MIT license.
"""The monorepo container image for the platform deployment.

Built from a clean-tree install plus the same workspace build the tests
exercised, so the deployed container cannot run a dependency tree the suite
never saw. `build_image` is parameterized only by per-app env (`extra_env`) and
port; the deploy *policy* — Modal app name, autoscaling numbers, resources —
stays in the deploy script.

There is one deployment now (packages/aai-server/modal_deploy.py, serving both
surfaces). This module stays a separate, parameterized recipe rather than being
inlined into it: it exists because there used to be TWO deploy scripts whose
"same image" invariant was asserted by a comment ("Mirrors the agent app's
image") and enforced by nothing — the build command enumerates workspace
packages, so adding one meant editing two Python files and a miss produced two
services on different trees with no build failure to catch it. Keeping the
recipe in one place is what makes a second deployment cheap and safe to add
back.
"""

import atexit
import contextlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
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
# client + the server entry. Order matters: each depends on the ones before it.
#
# aai-server is deliberately absent: it has no build. Its subpath exports point
# at `.ts` source, so aai-studio-server — the composition root for both apps and
# the only entry any deployment runs — bundles it directly. (`pnpm --filter
# aai-server build` would fail outright now, not no-op.)
BUILD_COMMAND = (
    "pnpm --filter aai build"
    " && pnpm --filter aai-ui build"
    " && pnpm --filter @alexkroman1/aai-cli build"
    " && pnpm --filter aai-guest build"
    " && pnpm --filter aai-studio-client build"
    " && pnpm --filter aai-studio-server build"
)

GUEST_HARNESS_PATH = "/app/packages/aai-guest/dist/harness.mjs"

# ── The install layer's inputs ───────────────────────────────────────────────
#
# `pnpm install` needs the lockfile, the workspace globs, and every workspace
# manifest — and nothing else in the repo. Copying it AHEAD of the source is
# what lets Modal reuse the installed `node_modules` across deploys instead of
# refetching the whole dependency tree every time a `.ts` file changes.
#
# The manifests are NORMALIZED rather than copied verbatim, and that is the
# part that makes the split worth anything. This layer's cache key is the
# content of what goes into it, and a package.json's `version` moves on EVERY
# release — which is precisely when a deploy happens, since
# `.github/workflows/deploy.yml` fires on a version bump and nothing else. Copied
# as-is, the install layer would therefore miss on every single production
# deploy and the split would be pure ceremony. Stripped to the fields install
# actually reads, the layer survives a release and misses only when a
# DEPENDENCY really changed.
#
# Dropping `version` is safe here because every workspace dependency in this
# repo is `workspace:*` — a spec that matches any version, so nothing resolves
# differently without it. A `workspace:^` anywhere would break that assumption.
# The real manifests land in the source layer below, so the built image still
# has each package's true version; only the cache key is normalized.
INSTALL_MANIFEST_FIELDS = (
    "name",
    "private",
    "packageManager",
    "engines",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "optionalDependencies",
    "pnpm",
)

# Copied byte-for-byte: these ARE the dependency graph (and `.npmrc` carries
# `verify-deps-before-run=false`, which the build commands below rely on once
# the source layer replaces the normalized manifests).
INSTALL_ROOT_FILES = ("pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc")

# Workspace members, mirroring `pnpm-workspace.yaml`. A new glob there needs a
# matching entry here or its package is missing at install time — which
# `--frozen-lockfile` reports as a lockfile mismatch, loudly, at image build.
WORKSPACE_MANIFEST_GLOBS = ("packages/*/package.json", "docs/package.json")


def _stage_install_inputs() -> Path:
    """Materialize the normalized install inputs into a temp dir.

    Returned as a directory rather than a list of files because Modal's
    `add_local_dir` preserves relative layout, and pnpm needs each manifest at
    its real workspace path. The directory has to outlive this call — Modal
    builds the image lazily, at `modal deploy`, not here — so it is cleaned up
    at process exit instead of by a context manager.
    """
    staged = Path(tempfile.mkdtemp(prefix="aai-modal-install-"))
    atexit.register(shutil.rmtree, staged, True)

    for name in INSTALL_ROOT_FILES:
        shutil.copyfile(REPO_ROOT / name, staged / name)

    manifests = [Path("package.json")]
    for pattern in WORKSPACE_MANIFEST_GLOBS:
        manifests.extend(sorted(p.relative_to(REPO_ROOT) for p in REPO_ROOT.glob(pattern)))

    for rel in manifests:
        source = json.loads((REPO_ROOT / rel).read_text())
        kept = {k: source[k] for k in INSTALL_MANIFEST_FIELDS if k in source}
        destination = staged / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Sorted keys and a fixed indent: the layer's cache key is this file's
        # bytes, so reordering a manifest by hand must not invalidate it.
        destination.write_text(f"{json.dumps(kept, indent=2, sort_keys=True)}\n")

    return staged


# Between the source copy and the build: `add_local_dir` is a COPY into an
# existing `/app`, so the installed tree merges rather than being replaced (the
# source copy carries no `node_modules` — see BUILD_IGNORE). If that ever stops
# holding, the build fails a dozen confusing steps later on a missing module;
# this turns it into one sentence, at image build time, where production has
# not moved yet.
ASSERT_INSTALL_SURVIVED = (
    "test -d /app/node_modules/.pnpm || "
    '{ echo "The source layer clobbered the install layer — see _stage_install_inputs" >&2; '
    "exit 1; }"
)

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
        # Dependencies BEFORE source, so an ordinary code change reuses the
        # installed tree instead of refetching it — see _stage_install_inputs.
        # The win is on the cold start, not the deploy: `modal deploy` builds
        # the image before any traffic moves, but a container starting on a
        # worker that already holds this layer pulls only what changed.
        .add_local_dir(_stage_install_inputs(), remote_path="/app", copy=True)
        .workdir("/app")
        .run_commands("pnpm install --frozen-lockfile --ignore-scripts --prod=false")
        .add_local_dir(REPO_ROOT, remote_path="/app", copy=True, ignore=BUILD_IGNORE)
        .run_commands(ASSERT_INSTALL_SURVIVED, BUILD_COMMAND)
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
