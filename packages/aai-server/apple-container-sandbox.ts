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
 * Backend selection lives in {@link resolveSandboxBackend}: an explicit
 * `SANDBOX_BACKEND` (`modal` | `apple-container`) always wins; unset, local
 * dev (see `isLocalDev`) on darwin auto-selects this backend when the
 * `container` CLI is on PATH, and everything else stays on Modal. Production
 * is never auto-switched — `SUPABASE_S3_ENDPOINT` being set makes
 * `isLocalDev` false regardless of platform.
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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { errorMessage } from "@alexkroman1/aai";
import { isLocalDev } from "./_boot.ts";
import { debug } from "./_debug-log.ts";
import { GUEST_PORT } from "./modal-sandbox.ts";
import { parseSandboxLimitsFromEnv } from "./modal-sandbox-env.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import { type DialGuest, dialGuest, type GuestProcLike, warmFromGuest } from "./warm-harness.ts";

// ── Backend selection ────────────────────────────────────────────────────────

export type SandboxBackend = "modal" | "apple-container";

/** Injectable host probe so selection is unit-testable off-macOS. */
export type BackendProbe = {
  platform: NodeJS.Platform;
  hasContainerCli(): boolean;
};

// Probing PATH costs a subprocess; the answer is stable per process.
let cliMemo: boolean | null = null;

/** True when Apple's `container` CLI resolves on PATH and answers --version. */
export function isAppleContainerCliAvailable(): boolean {
  cliMemo ??= spawnSync("container", ["--version"], { stdio: "ignore" }).status === 0;
  return cliMemo;
}

const defaultProbe: BackendProbe = {
  platform: process.platform,
  hasContainerCli: isAppleContainerCliAvailable,
};

/**
 * Which backend guest sandboxes run on. `SANDBOX_BACKEND` is the explicit
 * operator override and wins outright (an unknown value throws — silently
 * falling back to Modal would look exactly like the override not working).
 * Unset, developer mode on macOS with the `container` CLI installed selects
 * Apple containers; everything else — production above all — stays on Modal.
 */
export function resolveSandboxBackend(
  env: NodeJS.ProcessEnv,
  probe: BackendProbe = defaultProbe,
): SandboxBackend {
  const raw = env.SANDBOX_BACKEND?.trim().toLowerCase();
  if (raw === "apple-container") return "apple-container";
  if (raw === "modal") return "modal";
  if (raw) {
    throw new Error(
      `Unknown SANDBOX_BACKEND ${JSON.stringify(raw)} — expected "modal" or "apple-container"`,
    );
  }
  return isLocalDev(env) && probe.platform === "darwin" && probe.hasContainerCli()
    ? "apple-container"
    : "modal";
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

function realContext(): AppleContainerSpawnContext {
  return {
    runGuestContainer(params) {
      const child = spawn("container", buildContainerRunArgs(params), {
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
        const stop = spawn("container", ["stop", name], { stdio: "ignore" });
        // Best-effort by contract: an already-stopped container is fine.
        stop.once("error", () => resolve());
        stop.once("close", () => resolve());
      });
    },
  };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/** Ask the OS for a free loopback port (racy by nature; fine for dev). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

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
  getFreePort,
  resetCliProbe(): void {
    cliMemo = null;
  },
};
