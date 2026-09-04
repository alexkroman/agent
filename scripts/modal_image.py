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
import logging
import os
import re
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

# SDK + host runtime + UI (default client) + CLI (client bundler) + guest
# harness + studio client + the server entry. Order matters: each depends on the
# ones before it.
#
# aai-runtime is NOT optional here even though nothing in this list is named
# after it: aai-studio-server imports `@alexkroman1/aai-runtime/internal`, which
# resolves to `dist/internal.js` in the image and to `internal.ts` only under the
# `@dev/source` condition. Omitting it built a green image whose entry died at
# warm-up on ERR_MODULE_NOT_FOUND for that exact path.
#
# aai-server is deliberately absent: it has no build. Its subpath exports point
# at `.ts` source, so aai-studio-server — the composition root for both apps and
# the only entry any deployment runs — bundles it directly. (`pnpm --filter
# aai-server build` would fail outright now, not no-op.)
BUILD_COMMAND = (
    "pnpm --filter aai build"
    " && pnpm --filter aai-runtime build"
    " && pnpm --filter aai-ui build"
    " && pnpm --filter @alexkroman1/aai-cli build"
    " && pnpm --filter aai-guest build"
    " && pnpm --filter aai-studio-client build"
    " && pnpm --filter aai-studio-server build"
)

GUEST_HARNESS_PATH = "/app/packages/aai-guest/dist/harness.mjs"

# The service entry every deployment runs. Built by BUILD_COMMAND's last step;
# named here because the compile-cache warm-up below has to run the same file
# the container will.
SERVER_ENTRY = "/app/packages/aai-studio-server/dist/index.mjs"

# ── The server's V8 compile cache ────────────────────────────────────────────
#
# The entry is one ~3.7 MB bundle (aai-server is compiled in — see that
# package's tsdown.config.ts) plus its npm imports, and every container boots
# it cold, so V8 pays the same parse+compile on every cold start. Populating
# the cache once HERE, in a build layer, turns that into a cache read for the
# life of the image — the same trick the guest harness bakes into its snapshot
# (`warmCompileCache` in packages/aai-server/modal-harness-image.ts).
#
# Three properties make it safe to bake. A missing or stale entry is a silent
# MISS, never an error (the cache keys on Node version + file content, so a
# bumped base image simply misses); the directory lives under the writable
# `/app`, so a runtime miss can still write; and the warm-up runs the entry in
# a mode that evaluates the module graph and exits 0 without opening a port,
# a socket, or a database connection (`AAI_SERVER_WARMUP`, honored at the top
# of packages/aai-studio-server/index.ts).
#
# Deliberately NOT best-effort, unlike the harness's: this runs the real entry,
# so a non-zero exit means the built bundle cannot even be evaluated. Failing
# the image build is the right answer to that, and it is a free smoke test of
# the artifact production is about to run.
SERVER_COMPILE_CACHE = "/app/.compile-cache"
WARM_COMPILE_CACHE = (
    f"NODE_COMPILE_CACHE={SERVER_COMPILE_CACHE} AAI_SERVER_WARMUP=1 node {SERVER_ENTRY}"
)

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

# Copied byte-for-byte: these ARE the dependency graph. The workspace yaml also
# carries `verifyDepsBeforeRun: false`, which the build commands below rely on
# once the source layer replaces the normalized manifests. That setting used to
# live in a third file here, `.npmrc`, and moved because pnpm 11 reads no
# pnpm-specific setting from `.npmrc` at all — measured on 11.24.0, the key
# resolved to `undefined` there and to `false` from the yaml. So the guarantee
# this list exists to carry into the image is now in a file already on it.
INSTALL_ROOT_FILES = ("pnpm-lock.yaml", "pnpm-workspace.yaml")

# `patchedDependencies` in the workspace yaml names a patch FILE per dependency,
# and pnpm reads that file during install to verify the patched tarball against
# the hash the lockfile records. So copying the yaml byte-for-byte above without
# the files it points at makes the install layer fail outright:
#
#     ENOENT: no such file or directory, open '/app/patches/<name>.patch'
#
# The paths are DERIVED from the declaration rather than listed, because a
# listed `patches/` would be a second place to remember: the whole failure is
# that the declaration and the staged tree disagreed. Regex rather than a YAML
# parse because the deploy environment is `pip install modal` and nothing else
# (see .github/workflows/deploy.yml) — the block is a flat map of scalars, and a
# declaration this cannot read fails loudly below rather than staging nothing.
PATCHED_DEPENDENCIES_KEY = re.compile(r"^patchedDependencies:", re.M)
PATCHED_DEPENDENCIES_BLOCK = re.compile(
    r"^patchedDependencies:[ \t]*\n((?:[ \t]+\S.*\n)+)", re.M
)


def _patch_paths(workspace_yaml: str) -> list[str]:
    """The repo-relative patch files `patchedDependencies` names, if any.

    Pure — takes the yaml TEXT, so every filesystem read in this module stays
    inside `_stage_install_inputs`, behind its `modal.is_local()` guard. See
    that docstring for why a repo read outside it crash-loops the container.
    """
    block = PATCHED_DEPENDENCIES_BLOCK.search(workspace_yaml)
    # The key is quoted and holds an `@version`, so split on the LAST colon.
    paths = (
        [
            value
            for line in block.group(1).splitlines()
            if (value := line.rpartition(":")[2].strip().strip("\"'"))
        ]
        if block is not None
        else []
    )
    # A declaration this cannot read — flow style, or a body the block regex
    # does not match — must not degrade to staging nothing: that is exactly the
    # ENOENT above, one layer later and with no clue pointing here.
    if not paths and PATCHED_DEPENDENCIES_KEY.search(workspace_yaml):
        raise RuntimeError(
            "pnpm-workspace.yaml declares patchedDependencies but no patch path "
            "could be read from it — see _patch_paths in scripts/modal_image.py"
        )
    return paths


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

    EMPTY inside the container, and that guard is what keeps the app
    startable. Modal re-imports the deploy script in every container to
    hydrate the function (see `add_local_python_source` at the end of
    `build_image`), so this runs THERE too — where the repo does not exist and
    `REPO_ROOT`, derived from `__file__`, resolves to `/` because the module
    is mounted at `/root/modal_image.py`. Evaluated eagerly as an argument to
    `add_local_dir`, that is a hard `FileNotFoundError: '/pnpm-lock.yaml'` at
    import time, and the shape of the failure is the dangerous part: `modal
    deploy` exits 0 and CI reports success, the image builds, the app reads
    `deployed` — and then every container dies on startup while the PREVIOUS
    deploy's containers keep serving. Nothing in the request log says the
    rollout failed; the service simply cannot scale out or be replaced, until
    the last old container goes and takes the service with it. (Modal does log
    `Function modal_deploy.server is crash-looping`, minutes later, in the app
    log nobody is reading.) The image is only ever BUILT locally, so the
    container's copy has nothing to stage.

    The rule this generalizes to: everything in this module may be IMPORTED
    without the repo present. Modal's own `Image` builder calls are lazy, so
    referring to `REPO_ROOT` in one is fine; reading the filesystem to compute
    an argument to one is not.
    """
    staged = Path(tempfile.mkdtemp(prefix="aai-modal-install-"))
    atexit.register(shutil.rmtree, staged, True)
    if not modal.is_local():
        return staged

    for name in INSTALL_ROOT_FILES:
        shutil.copyfile(REPO_ROOT / name, staged / name)

    for rel in _patch_paths((REPO_ROOT / "pnpm-workspace.yaml").read_text()):
        destination = staged / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO_ROOT / rel, destination)

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


# ── Modal's proxy noise on an abandoned streamed response ────────────────────
#
# Modal's in-container ASGI proxy relays a streamed response by iterating the
# upstream body in a task it CREATES AND NEVER AWAITS
# (``_proxy_http_request.<locals>.send_response``, modal/_runtime/asgi.py). When
# the browser goes away mid-stream that iteration dies on the upstream
# connection, and because nobody ever retrieves the task's exception, CPython's
# ``Task.__del__`` hands it to the asyncio logger — one ~25-line traceback per
# abandoned stream:
#
#     Task exception was never retrieved
#     future: <Task finished ... coro=<_proxy_http_request.<locals>.send_response() ...
#     aiohttp.client_exceptions.ClientPayloadError: Response payload is not
#       completed: <TransferEncodingError: 400, 'Not enough data to satisfy
#       transfer length header.'>
#
# It is normal traffic, not a fault: every SSE stream the studio opens ends this
# way (a tab close, a navigation, a resubscribe), the browser is already gone
# when it fires, and Modal's own request log records the same request as
# ``200 OK``. Measured on production ``aai-server-web``: ~25 of these an hour
# against ~20 stream completions, and across a 60-minute window they were
# ~600 of the log's ~3,200 lines while the service served ZERO 5xx.
#
# COLLAPSED TO ONE LINE, NOT DROPPED, and that distinction is the point. The
# count and the timing are the only diagnostic these carry, and they matter:
# the server guide's rule for reading them is to join the count to Modal's
# request log, because a RISE means a client is churning subscriptions. Deleting
# the record would delete that; keeping the traceback buries it. So the record
# still flows, carrying its exception type, and the twenty-odd frames of Modal
# and aiohttp internals — identical every time, actionable never — go.
PROXY_NOISE_LOGGER = "asyncio"

# The proxy coroutine named in the record. Requiring it is what keeps this from
# being "swallow asyncio errors": an unretrieved task from anywhere else in the
# runtime — including any of ours — still prints in full.
PROXY_NOISE_CORO = "_proxy_http_request"

# Matched by NAME so this module does not import aiohttp (vendored in the
# container at /__modal/deps, and a local `modal deploy` must not depend on it).
# `ClientPayloadError` is what the task raises; `TransferEncodingError` is its
# cause, matched too because which one surfaces is aiohttp's business.
PROXY_NOISE_EXCEPTIONS = ("ClientPayloadError", "TransferEncodingError")


def _is_abandoned_stream(record: logging.LogRecord) -> bool:
    """Is this the one record Modal emits per abandoned streamed response?"""
    exception = record.exc_info[1] if record.exc_info else None
    if exception is None or type(exception).__name__ not in PROXY_NOISE_EXCEPTIONS:
        return False
    return PROXY_NOISE_CORO in record.getMessage()


class _ProxyNoiseFilter(logging.Filter):
    """Collapse the traceback; keep the event."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not _is_abandoned_stream(record):
            return True
        name = type(record.exc_info[1]).__name__ if record.exc_info else "?"
        record.msg = (
            f"modal proxy: client abandoned a streamed response ({name}) — "
            "expected on an SSE disconnect; a RISE in these means a client is "
            "churning subscriptions"
        )
        record.args = ()
        # Both, or the handler re-renders the traceback from whichever it finds:
        # `exc_text` is the formatter's cache of an already-rendered one.
        record.exc_info = None
        record.exc_text = None
        return True


def install_proxy_noise_filter() -> None:
    """Install {@link _ProxyNoiseFilter} on the asyncio logger.

    A filter rather than an ``asyncio`` exception handler: the record is
    emitted on Modal's own event loop, and the deploy's entry point runs off
    that loop (``@modal.web_server`` calls a sync function), so there is no
    running loop to attach a handler to from where we get control. Logging is
    process-global and has no such constraint.

    Idempotent — a second install would double-collapse nothing but is pointless
    noise in the filter chain.
    """
    logger = logging.getLogger(PROXY_NOISE_LOGGER)
    if any(isinstance(existing, _ProxyNoiseFilter) for existing in logger.filters):
        return
    logger.addFilter(_ProxyNoiseFilter())


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

    ``MODAL_SANDBOX_REGION`` is passed in by the caller (see
    ``modal_deploy.py``), and what it must be is a LIST. This function used to
    refuse to bake it at all, and the refusal was right about the failure and
    wrong about the remedy: pinning guests to a SINGLE region (once
    ``us-east-2``) confined every spawn to one region's spare capacity, and a
    spawn Modal cannot schedule inside the ~50 s ``tunnels()`` wait fails with
    ``Sandbox operation timed out`` — a studio chat or voice session that never
    starts. That is the same shape, at the sandbox layer, as the zero-container
    outage the web function's ``REGIONS`` list exists to prevent, and it takes
    the same answer: a PREFERENCE with a spill, never one region.

    What changed the trade is durable workflows. The old argument — "agent
    guests hold no host channel at all, so only the studio's control-channel
    RPCs pay the RTT" — is still true about VOICE and no longer decides it: a
    run's journal is one ``POST /:slug/workflow-journal`` per operation and the
    engine's are sequential by construction, so every guest→platform hop is
    inside a run's wall clock. Measured on a deployed run, ~24 ms an operation
    against ~2 ms in the platform's own region.

    ``modal-sandbox-env.ts`` still parses it, so an operator can override the
    placement per environment without a code change.
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
        # Passing REPO_ROOT (a bogus `/` in the container) is safe only because
        # this call is LAZY — Modal walks the directory at image build, which
        # happens locally. See _stage_install_inputs for the eager case, and
        # the rule.
        .add_local_dir(REPO_ROOT, remote_path="/app", copy=True, ignore=BUILD_IGNORE)
        .run_commands(ASSERT_INSTALL_SURVIVED, BUILD_COMMAND, WARM_COMPILE_CACHE)
        .env(
            {
                "NODE_ENV": "production",
                "PORT": str(port),
                "GUEST_HARNESS_PATH": GUEST_HARNESS_PATH,
                # Points the container's node at the cache warmed above. Set
                # here rather than in the RUN line so the RUNTIME process reads
                # it too — warming a cache nothing consults is the whole
                # failure mode, and it is silent.
                "NODE_COMPILE_CACHE": SERVER_COMPILE_CACHE,
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
