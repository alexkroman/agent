// Copyright 2026 the AAI authors. MIT license.
/**
 * Apple-container-backed sandbox spawning — the DEVELOPER-MODE backend.
 *
 * On a macOS dev box with Apple's [`container`](https://github.com/apple/container)
 * CLI installed, guest harnesses run in local containers (each a lightweight
 * VM under Apple's Containerization framework) instead of remote Modal
 * Sandboxes. That removes the Modal-credentials requirement and the
 * transatlantic round trip from local development while keeping the same
 * boundary shape: the agent bundle still runs in an isolated guest, loaded
 * over the same `/ws` control channel, serving sessions on the same
 * `/websocket` endpoint.
 *
 * Backend selection lives in `sandbox-backend.ts`: this backend is the
 * local-dev default (production always resolves Modal). Boot probes the CLI
 * via this module's {@link isAppleContainerCliAvailable} and warns — or, on an
 * explicit `SANDBOX_BACKEND=apple-container`, fails — when it is missing;
 * there is no fallback backend.
 *
 * Differences from the Modal backend, all acceptable because this only runs
 * on a single-user dev machine:
 * - The published port binds 127.0.0.1, so both the control channel and the
 *   client session endpoint are plain `ws://` loopback URLs — no tunnel.
 * - The bearer token is still enforced by the harness but rides the
 *   container's env (`container run --env`) rather than an exec env; it is
 *   visible to `container inspect` on the same machine only.
 * - The harness file is copied into a per-spawn temp dir and mounted into
 *   the container, rather than baked into a snapshot image.
 * - No lifetime/idle timeouts: the container dies with its harness process
 *   (`--rm`), and the harness's own orphan timeout covers a crashed host.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { GUEST_PORT } from "./modal-sandbox.ts";
import { parseSandboxLimitsFromEnv } from "./modal-sandbox-env.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import {
  type DialGuest,
  dialGuest,
  type GuestProcLike,
  getFreePort,
  warmFromGuest,
} from "./warm-harness.ts";

// ── CLI probe ────────────────────────────────────────────────────────────────

// Probing PATH costs a subprocess; the answer is stable per process. Note the
// consequence for `sandbox-backend.ts`: installing the CLI under a running
// server does not change the selected backend until the server restarts.
let cliMemo: boolean | null = null;

/** True when Apple's `container` CLI resolves on PATH and answers --version. */
export function isAppleContainerCliAvailable(): boolean {
  cliMemo ??= spawnSync("container", ["--version"], { stdio: "ignore" }).status === 0;
  return cliMemo;
}

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Default guest image — the same Node base the Modal backend uses, pulled by
 * the `container` CLI from Docker Hub. Override with `APPLE_CONTAINER_IMAGE`.
 */
const DEFAULT_CONTAINER_IMAGE = "node:24-slim";

/** Where the per-spawn harness dir is mounted inside the container. */
const HARNESS_MOUNT_DIR = "/aai-guest";

const HARNESS_FILE_NAME = "harness.mjs";

// ── Structural container-process types ───────────────────────────────────────
// Injectable for tests, exactly like ModalSpawnContext: unit tests never
// invoke the real CLI.

export type ContainerProcLike = GuestProcLike & {
  /** Hard-kill the attached CLI process (backup for a failed `stop`). */
  kill(): void;
};

export type AppleContainerRunParams = {
  /** Unique container name — the handle `stop` uses. */
  name: string;
  image: string;
  /** Host loopback port published to {@link GUEST_PORT} in the container. */
  hostPort: number;
  /** Container env (carries the per-sandbox bearer token — dev-only, see module doc). */
  env: Record<string, string>;
  /** Host dir holding the harness copy, mounted at {@link HARNESS_MOUNT_DIR}. */
  harnessDir: string;
  memoryLimitMiB?: number | undefined;
  cpuLimit?: number | undefined;
};

export type AppleContainerSpawnContext = {
  /** `container run` the guest, attached — the proc mirrors the container. */
  runGuestContainer(params: AppleContainerRunParams): ContainerProcLike;
  /** `container stop` by name; must tolerate an already-gone container. */
  stopGuestContainer(name: string): Promise<void>;
};

/**
 * Argument list for `container run`, pure so tests can assert it. Flags per
 * `container run --help` (apple/container ≥ 0.3, which added `--publish`):
 * attached (no `--detach`) so the CLI process's exit mirrors the container's
 * and stdio pipes straight through, `--rm` so a stopped container leaves
 * nothing behind.
 */
export function buildContainerRunArgs(params: AppleContainerRunParams): string[] {
  return [
    "run",
    "--rm",
    "--name",
    params.name,
    "--volume",
    `${params.harnessDir}:${HARNESS_MOUNT_DIR}`,
    // Loopback only: the session endpoint is auth-free by design (parity
    // with the platform's public agent WebSocket), so don't publish it to
    // the dev machine's network.
    "--publish",
    `127.0.0.1:${params.hostPort}:${GUEST_PORT}`,
    ...Object.entries(params.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ...(params.memoryLimitMiB !== undefined ? ["--memory", `${params.memoryLimitMiB}M`] : []),
    ...(params.cpuLimit !== undefined ? ["--cpus", String(params.cpuLimit)] : []),
    params.image,
    "node",
    `${HARNESS_MOUNT_DIR}/${HARNESS_FILE_NAME}`,
  ];
}

// ── Default context (the real CLI) ───────────────────────────────────────────

/**
 * `binary` is injectable so tests can point at a name that resolves nowhere
 * — exercising the error paths without ever running a real container.
 */
function realContext(binary = "container"): AppleContainerSpawnContext {
  return {
    runGuestContainer(params) {
      const child = spawn(binary, buildContainerRunArgs(params), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const wait = new Promise<number>((resolve) => {
        // `error` (ENOENT etc.) and `close` both mean the guest is gone;
        // warm-harness only cares that wait() settles.
        child.once("error", () => resolve(-1));
        child.once("close", (code) => resolve(code ?? -1));
      });
      return {
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: () => wait,
        kill: () => void child.kill("SIGKILL"),
      };
    },
    async stopGuestContainer(name) {
      await new Promise<void>((resolve) => {
        const stop = spawn(binary, ["stop", name], { stdio: "ignore" });
        // Best-effort by contract: an already-stopped container is fine.
        stop.once("error", () => resolve());
        stop.once("close", () => resolve());
      });
    },
  };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness in a local Apple container and dial its
 * WebSocket. Mirrors `spawnModalWarm`: the returned WarmHarness has a
 * running harness process and a connected RPC channel, but no listeners
 * attached and no bundle loaded.
 */
export async function spawnAppleContainerWarm(
  opts: { harnessPath: string; slug?: string },
  ctx: AppleContainerSpawnContext = realContext(),
  dial: DialGuest = dialGuest,
): Promise<WarmHarness> {
  const slug = opts.slug ?? "pool";
  const name = `aai-guest-${randomBytes(6).toString("hex")}`;
  // Per-spawn copy: mounting the built dist dir directly would let one guest
  // tamper with the harness every later spawn loads.
  const harnessDir = await mkdtemp(join(tmpdir(), "aai-guest-"));
  const removeHarnessDir = (): Promise<void> =>
    rm(harnessDir, { recursive: true, force: true }).catch(() => undefined);

  const t0 = performance.now();
  try {
    await copyFile(opts.harnessPath, join(harnessDir, HARNESS_FILE_NAME));
    const hostPort = await getFreePort();
    const limits = parseSandboxLimitsFromEnv(process.env);
    const token = randomBytes(32).toString("hex");

    const proc = ctx.runGuestContainer({
      name,
      image: process.env.APPLE_CONTAINER_IMAGE ?? DEFAULT_CONTAINER_IMAGE,
      hostPort,
      env: { AAI_GUEST_TOKEN: token, AAI_GUEST_PORT: String(GUEST_PORT) },
      harnessDir,
      memoryLimitMiB: limits.memoryLimitMiB,
      cpuLimit: limits.cpuLimit,
    });

    const terminate = async (): Promise<void> => {
      await ctx.stopGuestContainer(name);
      // `stop` resolving is not proof the attached CLI process exited
      // (it is best-effort by contract) — the kill is the backstop.
      proc.kill();
      await removeHarnessDir();
    };

    try {
      const ws = await dial(`ws://127.0.0.1:${hostPort}/ws`, token);
      debug("Apple container sandbox spawned", {
        name,
        slug,
        ms: Math.round(performance.now() - t0),
      });
      return warmFromGuest({
        label: `container:${name}`,
        proc,
        terminate,
        ws,
        // The PUBLIC client-session endpoint — handed to browsers by the
        // client-config broker, loopback-only here.
        sessionUrl: `ws://127.0.0.1:${hostPort}/websocket`,
      });
    } catch (err) {
      // Never leak a container whose harness failed to start.
      await terminate().catch(() => undefined);
      throw err;
    }
  } catch (err) {
    await removeHarnessDir();
    throw new Error(`Apple container sandbox spawn failed: ${errorMessage(err)}`, { cause: err });
  }
}

// ── Test-only internals ──────────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  realContext,
  resetCliProbe(): void {
    cliMemo = null;
  },
};
