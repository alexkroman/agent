// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by gVisor OCI containers (Linux) or plain
 * child processes (macOS dev mode).
 *
 * Provides the `SandboxHandle` abstraction that `sandbox.ts` delegates to.
 * Communication with the guest uses NDJSON over stdio pipes.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Kv, Vector } from "@alexkroman1/aai";
import type { Storage, StorageValue } from "unstorage";
import { z } from "zod";
import { createGvisorSandbox, isGvisorAvailable } from "./gvisor.ts";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";
import type { SandboxResourceLimits } from "./oci-spec.ts";
import { createFetchHandler, type FetchRequest } from "./sandbox-fetch.ts";

// ── KV param schemas for guest → host validation ────────────────────────────

/** Max KV value size in bytes (matches SDK constant). */
const MAX_KV_VALUE_SIZE = 65_536;

/**
 * Safe KV key: non-empty, no path traversal, no prefix-delimiter escape.
 * Rejects `..`, `:`, `/`, `\`, and null bytes to prevent namespace breakout.
 */
const SafeKvKeySchema = z
  .string()
  .min(1)
  .refine((k) => !k.includes("\0"), "Key must not contain null bytes")
  .refine((k) => !k.includes("/"), "Key must not contain /")
  .refine((k) => !k.includes("\\"), "Key must not contain \\")
  .refine((k) => !k.includes(":"), "Key must not contain :")
  .refine((k) => !k.includes(".."), "Key must not contain ..");

const KvGetParamsSchema = z.object({ key: SafeKvKeySchema });
const KvSetParamsSchema = z.object({
  key: SafeKvKeySchema,
  value: z
    .unknown()
    .refine(
      (v) => JSON.stringify(v).length <= MAX_KV_VALUE_SIZE,
      `Value exceeds max size of ${MAX_KV_VALUE_SIZE} bytes`,
    ),
});
const KvDelParamsSchema = z.object({ key: SafeKvKeySchema });

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxHandle = {
  conn: NdjsonConnection;
  shutdown(): Promise<void>;
};

export type SandboxVmOptions = {
  slug: string;
  workerCode: string;
  env: Record<string, string>;
  harnessPath: string;
  kvStorage?: Storage;
  kvPrefix?: string;
  /**
   * Pre-resolved KV instance for the agent. Takes precedence over
   * `kvStorage`/`kvPrefix` — set when the agent provides its own
   * `kv: upstash(...)` descriptor.
   */
  kv?: Kv;
  /**
   * Pre-resolved vector store. When set, the host serves
   * `vector/upsert|query|delete|fetch` RPC from the guest.
   */
  vector?: Vector;
  limits?: SandboxResourceLimits;
  allowedHosts?: string[];
};

// ── Shared setup ─────────────────────────────────────────────────────────────

/**
 * After establishing an NDJSON connection, sends the bundle message and
 * registers the KV handler. Returns the configured SandboxHandle.
 */
async function configureSandbox(
  conn: NdjsonConnection,
  opts: SandboxVmOptions,
  cleanup: () => Promise<void>,
): Promise<SandboxHandle> {
  conn.listen();

  // Host serves guest KV requests (params validated with Zod). Prefer the
  // agent-provided `Kv` instance (configured via `kv: upstash(...)` etc.);
  // fall back to the platform-managed storage when no descriptor is set.
  if (opts.kv) {
    const kv = opts.kv;
    conn.onRequest("kv/get", async (raw: unknown) => {
      const p = KvGetParamsSchema.parse(raw);
      const value = await kv.get(p.key);
      return value;
    });
    conn.onRequest("kv/set", async (raw: unknown) => {
      const p = KvSetParamsSchema.parse(raw);
      await kv.set(p.key, p.value);
    });
    conn.onRequest("kv/del", async (raw: unknown) => {
      const p = KvDelParamsSchema.parse(raw);
      await kv.delete(p.key);
    });
  } else if (opts.kvStorage && opts.kvPrefix) {
    const storage = opts.kvStorage;
    const prefix = opts.kvPrefix;
    conn.onRequest("kv/get", async (raw: unknown) => {
      const p = KvGetParamsSchema.parse(raw);
      return await storage.getItem(`${prefix}:${p.key}`);
    });
    conn.onRequest("kv/set", async (raw: unknown) => {
      const p = KvSetParamsSchema.parse(raw);
      await storage.setItem(`${prefix}:${p.key}`, p.value as StorageValue);
    });
    conn.onRequest("kv/del", async (raw: unknown) => {
      const p = KvDelParamsSchema.parse(raw);
      await storage.removeItem(`${prefix}:${p.key}`);
    });
  }

  // Host serves guest vector requests when an agent vector store is configured.
  if (opts.vector) {
    const vec = opts.vector;
    conn.onRequest("vector/upsert", async (raw: unknown) => {
      const p = raw as {
        records: import("@alexkroman1/aai").VectorRecord[];
        namespace?: string;
      };
      await vec.upsert(p.records, p.namespace ? { namespace: p.namespace } : undefined);
      return { ok: true };
    });
    conn.onRequest("vector/query", async (raw: unknown) => {
      const p = raw as import("@alexkroman1/aai").VectorQuery;
      return await vec.query(p);
    });
    conn.onRequest("vector/delete", async (raw: unknown) => {
      const p = raw as { ids?: string[]; namespace?: string; deleteAll?: boolean };
      await vec.delete(p.ids ?? [], {
        ...(p.namespace !== undefined ? { namespace: p.namespace } : {}),
        ...(p.deleteAll !== undefined ? { deleteAll: p.deleteAll } : {}),
      });
      return { ok: true };
    });
    conn.onRequest("vector/fetch", async (raw: unknown) => {
      const p = raw as { ids: string[]; namespace?: string };
      return await vec.fetch(p.ids, p.namespace ? { namespace: p.namespace } : undefined);
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

  // Send bundle to guest
  await conn.sendRequest("bundle/load", {
    code: opts.workerCode,
    env: opts.env,
  });

  return {
    conn,
    async shutdown() {
      void conn.sendNotification("shutdown");
      conn.dispose();
      await cleanup();
    },
  };
}

// ── Connection helper ────────────────────────────────────────────────────────

function createConnection(child: ChildProcess): NdjsonConnection {
  if (!(child.stdout && child.stdin)) {
    throw new Error("Child process missing stdio");
  }
  return createNdjsonConnection(child.stdout, child.stdin);
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

/**
 * Creates a sandbox by spawning the Deno guest harness as a child process.
 * Communication uses stdio pipes with NDJSON transport.
 */
export async function createDevSandbox(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const spawnConfig = devSandboxSpawnArgs(opts.harnessPath);
  const child: ChildProcess = spawn("deno", spawnConfig.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: spawnConfig.env,
  });

  return configureSandbox(createConnection(child), opts, async () => {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
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
 * Creates a sandbox backed by a gVisor OCI container.
 */
export async function createGvisorSandboxHandle(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const gvisor = createGvisorSandbox({
    slug: opts.slug,
    harnessPath: opts.harnessPath,
    ...(opts.limits && { limits: opts.limits }),
  });
  return configureSandbox(createConnection(gvisor.process), opts, () => gvisor.cleanup());
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
export const _internals = { configureSandbox, createConnection, devSandboxSpawnArgs };

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a sandbox using the best available backend:
 * - gVisor OCI container on Linux (production)
 * - Child process on macOS (dev only — no isolation)
 *
 * In production (NODE_ENV=production), gVisor is REQUIRED. The server
 * will refuse to start without it to prevent running untrusted agent
 * code without sandbox isolation.
 */
export async function createSandboxVm(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const envLimits = parseSandboxLimitsFromEnv(process.env);
  const mergedOpts: SandboxVmOptions = {
    ...opts,
    limits: { ...envLimits, ...opts.limits },
  };

  if (isGvisorAvailable()) return createGvisorSandboxHandle(mergedOpts);

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "gVisor (runsc) is required in production but not found on PATH. " +
        "Install runsc: https://gvisor.dev/docs/user_guide/install/ — " +
        "Running untrusted agent code without sandbox isolation is not allowed.",
    );
  }
  console.warn(
    "[sandbox] WARNING: gVisor not available. Running without sandbox isolation (dev mode only).",
  );
  return createDevSandbox(mergedOpts);
}
