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
import { errorMessage, MAX_VALUE_SIZE } from "@alexkroman1/aai";
import type { Vector } from "@alexkroman1/aai/runtime";
import { z } from "zod";
import { debug } from "./_debug-log.ts";
import { createGvisorSandbox, isGvisorAvailable } from "./gvisor.ts";
import { metrics, type SandboxInitFailReason, type SandboxInitPath } from "./metrics.ts";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";
import type { SandboxResourceLimits } from "./oci-spec.ts";
import { createFetchHandler, type FetchRequest } from "./sandbox-fetch.ts";

// ── KV param schemas for guest → host validation ────────────────────────────

/**
 * Safe KV key: non-empty, no path traversal. The agent prefix
 * (`agents/${slug}/kv`) uses `/` as the namespace separator, so we reject `/`,
 * `\`, `..`, and null bytes. `:` is allowed — it's a common Redis-style
 * delimiter for hierarchical keys (e.g. `incident:INC-0001`) and isn't used
 * by the prefix scheme.
 */
const SafeKvKeySchema = z
  .string()
  .min(1)
  .refine((k) => !k.includes("\0"), "Key must not contain null bytes")
  .refine((k) => !k.includes("/"), "Key must not contain /")
  .refine((k) => !k.includes("\\"), "Key must not contain \\")
  .refine((k) => !k.includes(".."), "Key must not contain ..");

const KvGetParamsSchema = z.object({ key: SafeKvKeySchema });
const KvSetParamsSchema = z.object({
  key: SafeKvKeySchema,
  value: z
    .unknown()
    .refine(
      (v) => JSON.stringify(v).length <= MAX_VALUE_SIZE,
      `Value exceeds max size of ${MAX_VALUE_SIZE} bytes`,
    ),
});
const KvDelParamsSchema = z.object({ key: SafeKvKeySchema });

// ── Vector param schemas for guest → host validation ────────────────────────

const VectorUpsertParamsSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const VectorQueryParamsSchema = z.object({
  text: z.string().min(1),
  topK: z.number().int().positive().max(100).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});
const VectorDeleteParamsSchema = z.object({
  ids: z.union([z.string().min(1), z.array(z.string().min(1)).max(1000)]),
});

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
  limits?: SandboxResourceLimits;
  allowedHosts?: string[];
};

/** Minimal interface the pool exposes to createSandboxVm. */
export type WarmHarnessSource = {
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

  // Host serves guest KV requests (params validated with Zod).
  if (opts.kv) {
    const kv = opts.kv;
    conn.onRequest("kv/get", async (raw: unknown) => {
      const p = KvGetParamsSchema.parse(raw);
      return await kv.get(p.key);
    });
    conn.onRequest("kv/set", async (raw: unknown) => {
      const p = KvSetParamsSchema.parse(raw);
      await kv.set(p.key, p.value);
    });
    conn.onRequest("kv/del", async (raw: unknown) => {
      const p = KvDelParamsSchema.parse(raw);
      await kv.delete(p.key);
    });
  }

  // Host serves guest Vector requests (params validated with Zod)
  if (opts.vector) {
    const vector = opts.vector;
    conn.onRequest("vector/upsert", async (raw: unknown) => {
      const p = VectorUpsertParamsSchema.parse(raw);
      await vector.upsert(p.id, p.text, p.metadata);
    });
    conn.onRequest("vector/query", async (raw: unknown) => {
      const p = VectorQueryParamsSchema.parse(raw);
      return await vector.query(p.text, {
        ...(p.topK !== undefined ? { topK: p.topK } : {}),
        ...(p.filter !== undefined ? { filter: p.filter } : {}),
      });
    });
    conn.onRequest("vector/delete", async (raw: unknown) => {
      const p = VectorDeleteParamsSchema.parse(raw);
      await vector.delete(p.ids);
    });
  }

  // Host serves guest fetch requests (validated against allowedHosts + SSRF)
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const handleFetch = createFetchHandler({ allowedHosts: opts.allowedHosts });
    let fetchId = 0;
    conn.onRequest("fetch/request", (raw: unknown) => {
      const req = raw as FetchRequest;
      const id = String(++fetchId);
      // Emit response messages as notifications in the background
      void handleFetch(req, id, (msg) => conn.sendNotification(msg.type, msg));
      // Return id immediately so guest can start collecting notifications
      return { id };
    });
  }

  conn.listen();

  // Send bundle to guest. The bundle/load round-trip is on the request
  // path, so we time it to distinguish guest cold-start latency (gVisor
  // boot + Deno V8 init) from host-side spawn overhead.
  const tBundle = performance.now();
  await conn.sendRequest("bundle/load", {
    code: opts.workerCode,
    env: opts.env,
  });
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
  return createNdjsonConnection(child.stdout, child.stdin);
}

/** Wrap a ChildProcess into the WarmHarness shape used by the pool. */
function warmFromChild(child: ChildProcess, cleanup: () => Promise<void>): WarmHarness {
  const conn = createConnection(child);
  const exitListeners: (() => void)[] = [];
  child.once("exit", () => {
    for (const cb of exitListeners) {
      try {
        cb();
      } catch {
        // Listener errors must not crash the host
      }
    }
  });
  return {
    conn,
    cleanup,
    alive: () => child.exitCode === null && !child.killed,
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
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
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
  limits?: SandboxResourceLimits;
  slug?: string;
}): Promise<WarmHarness> {
  const envLimits = parseSandboxLimitsFromEnv(process.env);
  const mergedLimits: SandboxResourceLimits = { ...envLimits, ...opts.limits };

  if (isGvisorAvailable()) {
    return spawnGvisorWarm(opts.slug ?? "pool", opts.harnessPath, mergedLimits);
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
 * Parses sandbox resource limits from environment variables.
 * Unset or non-numeric vars are ignored (use built-in defaults).
 */
export function parseSandboxLimitsFromEnv(
  env: Record<string, string | undefined>,
): SandboxResourceLimits {
  const limits: SandboxResourceLimits = {};

  const memMb = Number(env.SANDBOX_MEMORY_LIMIT_MB);
  if (Number.isFinite(memMb)) {
    limits.memoryLimitBytes = clamp(memMb, 16, 512) * 1024 * 1024;
  }

  const pids = Number(env.SANDBOX_PID_LIMIT);
  if (Number.isFinite(pids)) {
    limits.pidLimit = clamp(pids, 8, 256);
  }

  const tmpfsMb = Number(env.SANDBOX_TMPFS_LIMIT_MB);
  if (Number.isFinite(tmpfsMb)) {
    limits.tmpfsSizeBytes = clamp(tmpfsMb, 1, 100) * 1024 * 1024;
  }

  const cpuSecs = Number(env.SANDBOX_CPU_TIME_LIMIT_SECS);
  if (Number.isFinite(cpuSecs)) {
    limits.cpuTimeLimitSecs = clamp(cpuSecs, 10, 300);
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
  // Default to "cold". `createSandboxVmInner` flips this to "warm" if the
  // pool returns a ready harness — that's the only fast path.
  const pathRef = { path: "cold" as SandboxInitPath };
  try {
    const result = await createSandboxVmInner(opts, pool, pathRef);
    metrics.sandboxInit.observe({ path: pathRef.path }, hrtimeSeconds(t0));
    return result;
  } catch (err) {
    metrics.sandboxInit.observe({ path: pathRef.path }, hrtimeSeconds(t0));
    metrics.sandboxInitFailed.inc({ reason: classifyInitFailure(err) });
    throw err;
  }
}

function hrtimeSeconds(t0: bigint): number {
  return Number(process.hrtime.bigint() - t0) / 1e9;
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
  pathRef: { path: SandboxInitPath },
): Promise<SandboxHandle> {
  const envLimits = parseSandboxLimitsFromEnv(process.env);
  const mergedOpts: SandboxVmOptions = {
    ...opts,
    limits: { ...envLimits, ...opts.limits },
  };

  if (pool) {
    const warm = await pool.acquire();
    if (warm) {
      pathRef.path = "warm";
      return configureSandbox(warm, mergedOpts);
    }
  }

  if (!isGvisorAvailable() && process.env.NODE_ENV !== "production") {
    console.warn(
      "[sandbox] WARNING: gVisor not available. Running without sandbox isolation (dev mode only).",
    );
  }
  const warm = await spawnWarmHarness({
    harnessPath: mergedOpts.harnessPath,
    ...(mergedOpts.limits ? { limits: mergedOpts.limits } : {}),
    slug: mergedOpts.slug,
  });
  return configureSandbox(warm, mergedOpts);
}
