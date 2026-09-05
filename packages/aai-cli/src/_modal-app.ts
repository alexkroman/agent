// Copyright 2026 the AAI authors. MIT license.
/**
 * The Modal app definition `aai build --target modal` emits — `app.py`.
 *
 * ## Why this target is a generated PYTHON file
 *
 * Every other target emits the host's expected entry shape and lets the host
 * hold the rest: Vercel reads a routing table it already understands, Deno
 * Deploy takes a directory and an entrypoint. Modal has no such descriptor.
 * Its deploy unit is a Python module — `modal.App`, an image recipe, and a
 * decorated function — and `modal deploy` runs that module rather than reading
 * a manifest out of it. So the "preset" for Modal is the module itself, which
 * is why this is the one target whose emit generates code in another language.
 *
 * ## The knobs are DEPLOY-TIME ENV, not edits to this file
 *
 * The awkward consequence is that Modal's policy — how many containers, how
 * much CPU, which secret — lives in Python arguments rather than in a platform
 * dashboard. A generated file carrying policy is a file people edit, and this
 * one is overwritten by the next `aai build`, so "do not edit" would be a lie
 * the first time somebody wanted a warm container.
 *
 * Four knobs are therefore read from the environment at deploy time
 * ({@link MODAL_ENV_KNOBS}), which keeps the project committing nothing
 * host-specific — the property `_build-target.ts` opens by defending:
 *
 * ```sh
 * AAI_MODAL_MIN_CONTAINERS=1 modal deploy .aai/modal/app.py
 * ```
 *
 * The rest — cpu, memory, timeout, concurrency — stays a documented constant
 * in the emitted file. Those are the numbers a reader needs to SEE to trust
 * the deployment, and regenerating restates the default, which is the same
 * contract every other generated artifact here has.
 */

import { MODAL_APP_FILE, MODAL_ENTRY_FILE, MODAL_PORT } from "./_modal-target.ts";

/**
 * The Node major the emitted image may not go below — the SDK's own `engines`
 * floor.
 *
 * The tag otherwise tracks the Node running the build, so the bundle runs on
 * the runtime it was bundled for. Modal pulls any tag that exists on Docker
 * Hub, so there is nothing to clamp from ABOVE — unlike `vercelNodeRuntime`,
 * whose platform publishes a fixed list. The floor is the half that matters:
 * npm does not enforce `engines` by default, so a build on Node 22 would
 * otherwise emit a `node:22-slim` image in which the SDK genuinely does not
 * run, and the failure would arrive as a crash-looping container.
 */
const MODAL_NODE_MAJOR_FLOOR = 24;

/**
 * The Python `add_python` layers beside Node.
 *
 * Matches `scripts/modal_image.py`, which is the same arrangement one layer up:
 * the container entrypoint is Modal's own Python runtime, and it spawns node.
 */
const MODAL_ADD_PYTHON = "3.13";

/** What a name sanitizes to when nothing usable survives — see {@link modalAppName}. */
const MODAL_FALLBACK_APP_NAME = "aai-agent";

/**
 * Modal caps a resource name at 64 characters. Truncated rather than refused:
 * the name is cosmetic (it appears in the app's URL), and failing a build over
 * a long agent name would be the target's first impression.
 */
const MODAL_NAME_MAX = 64;

/** The deploy-time knobs the emitted app reads, documented in its own docstring. */
export const MODAL_ENV_KNOBS = [
  "AAI_MODAL_APP",
  "AAI_MODAL_SECRET",
  "AAI_MODAL_MIN_CONTAINERS",
  "AAI_MODAL_MAX_CONTAINERS",
] as const;

/**
 * An agent name as a Modal app name.
 *
 * Modal accepts a narrow character set here and the name reaches a hostname —
 * a deployed function is served at `<workspace>--<app>-<function>.modal.run` —
 * so anything outside `[a-z0-9-]` becomes a dash rather than being passed
 * through and rejected by the platform. Agent names are free text
 * (`define({ name: "Retail Support Bot" })`), which is why this is a mapping
 * and not a validation.
 *
 * Collapsed and trimmed, because `--` is what a hostname reader sees as the
 * workspace separator, and a leading or trailing dash is not a legal label.
 */
export function modalAppName(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MODAL_NAME_MAX)
    // A truncation can land on a dash, which the trim above already ran.
    .replace(/-+$/g, "");
  return slug === "" ? MODAL_FALLBACK_APP_NAME : slug;
}

/**
 * The Modal Secret the deployment reads its env from.
 *
 * `-env` rather than the app name alone: the secret holds exactly what
 * `.env.example` declares, and a name that says so makes
 * `modal secret create <name> …` self-explaining. Derived rather than
 * configured, so the emitted file and the command in its docstring cannot name
 * two different secrets.
 */
export function modalSecretName(appName: string): string {
  return `${appName}-env`.slice(0, MODAL_NAME_MAX);
}

/** `node:<major>-slim` for the Node running this build, floored at the SDK's minimum. */
export function modalNodeImageTag(version: string = process.versions.node): string {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  const resolved =
    Number.isNaN(major) || major < MODAL_NODE_MAJOR_FLOOR ? MODAL_NODE_MAJOR_FLOOR : major;
  return `node:${resolved}-slim`;
}

/** Options for {@link modalAppSource}. */
export interface ModalAppSourceOptions {
  /** The agent's name, as declared in `agent.ts`. */
  name: string;
  /** Base image tag. Defaults to {@link modalNodeImageTag} for the running Node. */
  nodeImage?: string | undefined;
}

/**
 * Render `app.py` for this agent.
 *
 * Every number the platform needs appears ONCE and is interpolated, so the
 * emitted file cannot disagree with itself or with the entry beside it — see
 * {@link MODAL_PORT} for the failure that motivates it.
 */
export function modalAppSource(options: ModalAppSourceOptions): string {
  const app = modalAppName(options.name);
  const secret = modalSecretName(app);
  const image = options.nodeImage ?? modalNodeImageTag();

  return `# Generated by \`aai build --target modal\` — do not edit, and do not commit.
"""Deploys this agent to Modal.

    modal secret create ${secret} ASSEMBLYAI_API_KEY=...   # once
    modal deploy .aai/modal/${MODAL_APP_FILE}

Everything this serves is in THIS directory. \`${MODAL_ENTRY_FILE}\` is a bundle
with no imports left to resolve, so the image installs nothing, carries no
lockfile and needs no node_modules.

Policy is read from the environment at DEPLOY time rather than edited here,
because \`aai build --target modal\` overwrites this file:

    AAI_MODAL_APP             app name (default: ${app})
    AAI_MODAL_SECRET          secret holding the agent env (default: ${secret})
    AAI_MODAL_MIN_CONTAINERS  warm floor (default: 0, i.e. scales to zero)
    AAI_MODAL_MAX_CONTAINERS  autoscaler ceiling (default: 10)
"""

import atexit
import contextlib
import os
import signal
import subprocess
from pathlib import Path

import modal

# This file's OWN directory, never the shell's. \`modal deploy\` resolves a
# relative local path against the directory it was invoked FROM, so an
# \`add_local_dir(".")\` here would upload the project root or nothing at all,
# depending on where the deploy was run.
HERE = Path(__file__).parent

# Bound to \`@modal.web_server\` and baked into the image env from this one
# place. The proxy routes to the port it is told about, and a node process
# reading a different number listens where nothing is routed — a deployment
# that builds, starts, reports healthy and answers no request.
PORT = ${MODAL_PORT}

# The node server, spawned by \`server()\` below.
ENTRY = "${MODAL_ENTRY_FILE}"

APP_NAME = os.environ.get("AAI_MODAL_APP", "${app}")
SECRET_NAME = os.environ.get("AAI_MODAL_SECRET", "${secret}")
MIN_CONTAINERS = int(os.environ.get("AAI_MODAL_MIN_CONTAINERS", "0"))
MAX_CONTAINERS = int(os.environ.get("AAI_MODAL_MAX_CONTAINERS", "10"))

# How long a container stop waits for node to close its sessions before the
# force-kill. Modal's own SIGKILL backstop still bounds the real grace period,
# so this is headroom rather than a budget the shutdown spends.
NODE_STOP_TIMEOUT_SECS = 30

image = (
    # \`add_python\` layers Modal's own Python beside Node: the container
    # entrypoint is that Python runtime, and it spawns node. The Node major
    # tracks the one this was BUILT with, so the bundle runs on the runtime it
    # was bundled for.
    modal.Image.from_registry("${image}", add_python="${MODAL_ADD_PYTHON}")
    .env({"NODE_ENV": "production", "PORT": str(PORT)})
    # \`copy=True\` puts these files in an image LAYER. The default mounts them
    # at container start instead, which re-uploads the browser client on every
    # cold start and makes the boot slower the larger the UI gets.
    .add_local_dir(
        HERE,
        remote_path="/app",
        copy=True,
        ignore=["${MODAL_APP_FILE}", "__pycache__"],
    )
)

app = modal.App(APP_NAME)


def _run_node(entry: str, env: dict[str, str]) -> subprocess.Popen:
    """Spawn the node server and hand container stop signals to it.

    Modal stops a container by signalling THIS Python process, and a child
    spawned with a bare Popen receives nothing of its own — so the node
    server's SIGTERM handler, the thing that closes live voice sessions, would
    never run on a scale-in or a redeploy. Every call in progress would just
    lose its socket.

    Two hooks, because neither alone is reliable: \`signal.signal\` only works on
    the main thread and Modal may call this off it, while the atexit fallback
    catches the runtime handling the signal itself and exiting normally. Both
    funnel into one memoized stop(), and the node handler is idempotent, so
    double delivery is harmless.
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

    def forward(signum: int) -> None:
        previous = signal.getsignal(signum)

        def handler(sig: int, frame: object) -> None:
            stop()
            if callable(previous):
                previous(sig, frame)
            elif previous == signal.SIG_DFL:
                # Re-deliver with the default disposition so this runtime still
                # dies the way the platform expects.
                signal.signal(sig, signal.SIG_DFL)
                os.kill(os.getpid(), sig)

        signal.signal(signum, handler)

    for signum in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(ValueError):  # not the main thread
            forward(signum)

    atexit.register(stop)
    return proc


@app.function(
    image=image,
    # Values live in a Modal Secret; the \`.env.example\` beside this file
    # DECLARES which names reach \`ctx.env\`. Deploy FAILS when the secret does
    # not exist, which is the right time to hear about it — the alternative is
    # a container that starts and has no provider credential.
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    # An audio pipeline is not a burstable workload: STT framing, the LLM turn
    # and TTS playback all run in this process.
    cpu=1,
    memory=1024,
    min_containers=MIN_CONTAINERS,
    max_containers=MAX_CONTAINERS,
    # Hold a container after the last call rather than paying a cold start on
    # the next one.
    scaledown_window=300,
    # Bounds ONE input, and a WebSocket is one input for as long as the call
    # lasts — so this is the longest single call this deployment will carry.
    timeout=3600,
)
# Without this a container serves ONE input at a time, and a voice call holds
# its input until the caller hangs up: the second caller would wait out the
# first, and every asset request for the browser client would queue behind
# whichever call is in progress. \`target_inputs\` is the scale-out set point,
# under the cap, so a container is joined by another before it saturates.
@modal.concurrent(max_inputs=50, target_inputs=25)
@modal.web_server(port=PORT, startup_timeout=180)
def server() -> None:
    env = os.environ.copy()
    # Modal points this at an in-container Unix socket serving its own Python
    # task runtime. The \`modal\` JS SDK prefers that variable over the public
    # endpoint, so anything in node that talks to Modal would dial a socket
    # that does not answer it.
    env.pop("MODAL_SERVER_URL", None)
    # _run_node, not a bare Popen, so the container's stop signal reaches node
    # and live sessions are closed rather than dropped.
    _run_node(ENTRY, env)
`;
}
