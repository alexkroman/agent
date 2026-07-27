// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by gVisor OCI containers (Linux) or plain
 * child processes (macOS dev mode).
 *
 * Provides the `SandboxHandle` abstraction that `sandbox.ts` delegates to.
 * Communication with the guest uses NDJSON over stdio pipes.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { Kv } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai";
import type { Vector } from "@alexkroman1/aai/runtime";
import { debug } from "./_debug-log.ts";
import { createGvisorSandbox, isGvisorAvailable, waitForChildExit } from "./gvisor.ts";
import {
  hrtimeSeconds,
  metrics,
  type SandboxInitFailReason,
  type SandboxInitPath,
} from "./metrics.ts";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";
import type { SandboxResourceLimits } from "./oci-spec.ts";
import { registerGuestRpcHandlers } from "./sandbox-guest-rpc.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxHandle = {
  conn: NdjsonConnection;
  shutdown(): Promise<void>;
};

/**
 * A spawned harness whose Deno process is running and whose NDJSON
 * connection is wired to its stdio, but which has NOT yet received a
 * bundle/load. Used by the sandbox pool for warm starts.
 *
 * `listen()` has not been called on the connection yet — the per-agent
 * configuration step (KV/fetch handler registration + bundle/load) will
 * call it after handlers are registered.
 */
export type WarmHarness = {
  conn: NdjsonConnection;
  cleanup: () => Promise<void>;
  /** True while the underlying child process is alive. */
  alive: () => boolean;
  /** Register a one-shot listener for child exit (for pool reaping). */
  onExit: (cb: () => void) => void;
};

export type SandboxVmOptions = {
  slug: string;
  workerCode: string;
  env: Record<string, string>;
  harnessPath: string;
  /** Resolved Kv instance (enables kv/* RPC handlers when set). */
  kv?: Kv;
  /** Resolved Vector instance (enables vector/* RPC handlers when set). */
  vector?: Vector;
  allowedHosts?: string[];
};

/** Minimal interface the pool exposes to createSandboxVm. */
type WarmHarnessSource = {
  acquire(): Promise<WarmHarness | null>;
};

// ── Shared setup ─────────────────────────────────────────────────────────────

/**
 * Finalize a warm harness for a specific agent: register host-side KV/fetch
 * handlers, start listening on the connection, and send bundle/load. Returns
 * the configured SandboxHandle.
 *
 * Splitting register-handlers → listen → bundle/load lets the pool spawn a
 * harness ahead of time without committing to an agent identity. Handlers
 * MUST be registered before listen() so no incoming guest messages are
 * dropped.
 */
async function configureSandbox(warm: WarmHarness, opts: SandboxVmOptions): Promise<SandboxHandle> {
  const { conn } = warm;

  // Host serves guest KV/Vector/fetch requests — see sandbox-guest-rpc.ts.
  registerGuestRpcHandlers(conn, opts);

  conn.listen();

  // Send bundle to guest. The bundle/load round-trip is on the request
  // path, so we time it to distinguish guest cold-start latency (gVisor
  // boot + Deno V8 init) from host-side spawn overhead.
  const tBundle = performance.now();
  try {
    await conn.sendRequest("bundle/load", {
      code: opts.workerCode,
      env: opts.env,
    });
  } catch (err) {
    // bundle/load can now time out (a bundle whose top level never resolves).
    // Tear down the harness process so it doesn't leak, then rethrow.
    conn.dispose();
    await warm.cleanup().catch(() => undefined);
    throw err;
  }
  debug("Sandbox bundle/load complete", {
    slug: opts.slug,
    bytes: opts.workerCode.length,
    ms: Math.round(performance.now() - tBundle),
  });

  return {
    conn,
    async shutdown() {
      void conn.sendNotification("shutdown");
      conn.dispose();
      await warm.cleanup();
    },
  };
}

function gvisorRequiredError(): Error {
  return new Error(
    "gVisor (runsc) is required in production but not found on PATH. " +
      "Install runsc: https://gvisor.dev/docs/user_guide/install/ — " +
      "Running untrusted agent code without sandbox isolation is not allowed.",
  );
}

// ── Connection helper ────────────────────────────────────────────────────────

function createConnection(child: ChildProcess): NdjsonConnection {
  if (!(child.stdout && child.stdin)) {
    throw new Error("Child process missing stdio");
  }
  // A guest that dies mid-RPC (OOM-killed at the cgroup limit, crashed) leaves
  // its stdio streams to emit EPIPE/ECONNRESET asynchronously. Without an
  // `error` listener those become an uncaughtException that exits the whole
  // multi-tenant host, so attach no-op handlers on both pipes.
  child.stdin.on("error", () => {
    /* guest died; RPC layer surfaces this via the readline close */
  });
  child.stdout.on("error", () => {
    /* guest died; RPC layer surfaces this via the readline close */
  });
  return createNdjsonConnection(child.stdout, child.stdin);
}

/** Wrap a ChildProcess into the WarmHarness shape used by the pool. */
function warmFromChild(child: ChildProcess, cleanup: () => Promise<void>): WarmHarness {
  const conn = createConnection(child);
  const exitListeners: (() => void)[] = [];
  let dead = false;
  const notifyExit = (): void => {
    if (dead) return;
    dead = true;
    for (const cb of exitListeners) {
      try {
        cb();
      } catch {
        // Listener errors must not crash the host
      }
    }
  };
  child.once("exit", notifyExit);
  // A failed spawn (deno/runsc missing, EAGAIN under fd pressure) emits
  // `error` — with no listener that's an uncaughtException that exits the
  // whole multi-tenant host, and `exit` is not guaranteed to follow. Treat it
  // as harness death so the pool/fallback path replaces it.
  child.on("error", notifyExit);
  return {
    conn,
    cleanup,
    alive: () => !dead && child.exitCode === null && !child.killed,
    onExit: (cb) => {
      exitListeners.push(cb);
    },
  };
}

// ── Dev sandbox (macOS / non-gVisor) ─────────────────────────────────────────

/** Build spawn arguments for dev sandbox. Exported for testing via _internals. */
function devSandboxSpawnArgs(harnessPath: string): {
  args: string[];
  env: Record<string, string | undefined>;
} {
  return {
    args: ["run", "--allow-env", `--allow-read=${harnessPath}`, "--no-prompt", harnessPath],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NO_COLOR: "1",
    },
  };
}

/** Spawn a dev-mode (no gVisor) Deno harness, returning an unconfigured WarmHarness. */
function spawnDevWarm(harnessPath: string): WarmHarness {
  const spawnConfig = devSandboxSpawnArgs(harnessPath);
  const child: ChildProcess = spawn("deno", spawnConfig.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: spawnConfig.env,
  });
  return warmFromChild(child, async () => {
    child.kill("SIGTERM");
    if (!(await waitForChildExit(child, 2000))) {
      child.kill("SIGKILL");
    }
  });
}

// ── gVisor sandbox (Linux production) ────────────────────────────────────────

/**
 * Spawn a gVisor-backed Deno harness, returning an unconfigured WarmHarness.
 *
 * For pool spawns, pass a synthetic slug like "pool"; the slug only affects
 * the gVisor container ID for logging and is unrelated to the security
 * boundary (which is enforced by the OCI spec + minimal rootfs).
 */
async function spawnGvisorWarm(
  slug: string,
  harnessPath: string,
  limits?: SandboxResourceLimits,
): Promise<WarmHarness> {
  const gvisor = await createGvisorSandbox({
    slug,
    harnessPath,
    ...(limits && { limits }),
  });
  return warmFromChild(gvisor.process, () => gvisor.cleanup());
}

// ── Warm-harness spawning ────────────────────────────────────────────────────

/**
 * Spawn a warm Deno harness using the best-available backend. The returned
 * WarmHarness has a running process and a connected NDJSON channel, but no
 * listeners are attached and no bundle has been loaded.
 *
 * Single source of the backend policy, used by both the sandbox pool and
 * on-demand sandbox creation:
 * - gVisor on Linux when runsc is on PATH
 * - Plain child process on macOS dev mode
 * - In production (NODE_ENV=production), gVisor is REQUIRED.
 *
 * `slug` only affects the gVisor container ID for logging (pool spawns
 * default to "pool"); the security boundary is the OCI spec + rootfs.
 */
export async function spawnWarmHarness(opts: {
  harnessPath: string;
  slug?: string;
}): Promise<WarmHarness> {
  if (isGvisorAvailable()) {
    return spawnGvisorWarm(
      opts.slug ?? "pool",
      opts.harnessPath,
      parseSandboxLimitsFromEnv(process.env),
    );
  }

  if (process.env.NODE_ENV === "production") {
    throw gvisorRequiredError();
  }
  return spawnDevWarm(opts.harnessPath);
}

// ── Operator resource limit overrides ────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * One row per operator-overridable limit: env var, target field, clamp bounds,
 * and the multiplier converting the env var's unit to the field's. Keeping the
 * bounds next to the field they clamp is the point — in the previous
 * copy-pasted blocks a mismatched pair was invisible.
 */
const LIMIT_SPECS = [
  ["SANDBOX_MEMORY_LIMIT_MB", "memoryLimitBytes", 16, 512, 1024 * 1024],
  ["SANDBOX_PID_LIMIT", "pidLimit", 8, 256, 1],
  ["SANDBOX_TMPFS_LIMIT_MB", "tmpfsSizeBytes", 1, 100, 1024 * 1024],
  ["SANDBOX_CPU_TIME_LIMIT_SECS", "cpuTimeLimitSecs", 10, 300, 1],
] as const satisfies readonly (readonly [
  string,
  keyof SandboxResourceLimits,
  number,
  number,
  number,
])[];

/**
 * Parses sandbox resource limits from environment variables.
 * Unset or non-numeric vars are ignored (use built-in defaults).
 */
export function parseSandboxLimitsFromEnv(
  env: Record<string, string | undefined>,
): SandboxResourceLimits {
  const limits: SandboxResourceLimits = {};
  for (const [envVar, field, min, max, scale] of LIMIT_SPECS) {
    const raw = Number(env[envVar]);
    if (Number.isFinite(raw)) limits[field] = clamp(raw, min, max) * scale;
  }

  return limits;
}

// ── Test-only internals ─────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  configureSandbox,
  createConnection,
  devSandboxSpawnArgs,
  warmFromChild,
};

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a sandbox using the best available backend:
 * - gVisor OCI container on Linux (production)
 * - Child process on macOS (dev only — no isolation)
 *
 * In production (NODE_ENV=production), gVisor is REQUIRED. The server
 * will refuse to start without it to prevent running untrusted agent
 * code without sandbox isolation.
 *
 * If a `pool` is provided, attempts to acquire a pre-warmed harness from
 * it before spawning a fresh one. Falls back to a fresh spawn if the pool
 * is empty or returns a dead harness.
 */
export async function createSandboxVm(
  opts: SandboxVmOptions,
  pool?: WarmHarnessSource,
): Promise<SandboxHandle> {
  const t0 = process.hrtime.bigint();
  try {
    const { handle, path } = await createSandboxVmInner(opts, pool);
    metrics.sandboxInit.observe({ path }, hrtimeSeconds(t0));
    return handle;
  } catch (err) {
    // A throw means the warm path was never taken, so the label is "cold".
    metrics.sandboxInit.observe({ path: "cold" }, hrtimeSeconds(t0));
    metrics.sandboxInitFailed.inc({ reason: classifyInitFailure(err) });
    throw err;
  }
}

/** Classify a sandbox-init error into one of three coarse buckets. */
function classifyInitFailure(err: unknown): SandboxInitFailReason {
  const msg = errorMessage(err);
  if (msg.includes("bundle") || msg.includes("Worker code not found")) return "bundle_missing";
  if (msg.includes("spawn") || msg.includes("ENOENT")) return "worker_spawn";
  return "host_init";
}

async function createSandboxVmInner(
  opts: SandboxVmOptions,
  pool: WarmHarnessSource | undefined,
): Promise<{ handle: SandboxHandle; path: SandboxInitPath }> {
  if (pool) {
    const warm = await pool.acquire();
    // A ready pooled harness is the only fast path.
    if (warm) return { handle: await configureSandbox(warm, opts), path: "warm" };
  }

  if (!isGvisorAvailable() && process.env.NODE_ENV !== "production") {
    console.warn(
      "[sandbox] WARNING: gVisor not available. Running without sandbox isolation (dev mode only).",
    );
  }
  // spawnWarmHarness reads the env-var limits itself.
  const warm = await spawnWarmHarness({
    harnessPath: opts.harnessPath,
    slug: opts.slug,
  });
  return { handle: await configureSandbox(warm, opts), path: "cold" };
}
