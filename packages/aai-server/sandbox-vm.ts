// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by gVisor OCI containers (Linux) or plain
 * child processes (macOS dev mode).
 *
 * Provides the `SandboxHandle` abstraction that `sandbox.ts` delegates to.
 * Communication with the guest uses NDJSON over stdio pipes.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Storage, StorageValue } from "unstorage";
import { z } from "zod";
import { createGvisorSandbox, isGvisorAvailable } from "./gvisor.ts";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";
import type { SandboxResourceLimits } from "./oci-spec.ts";

// ── KV param schemas for guest → host validation ────────────────────────────

const KvGetParamsSchema = z.object({ key: z.string().min(1) });
const KvSetParamsSchema = z.object({ key: z.string().min(1), value: z.unknown() });
const KvDelParamsSchema = z.object({ key: z.string().min(1) });

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
  limits?: SandboxResourceLimits;
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

  // Host serves guest KV requests (params validated with Zod)
  if (opts.kvStorage && opts.kvPrefix) {
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

/**
 * Creates a sandbox by spawning the Deno guest harness as a child process.
 * Communication uses stdio pipes with NDJSON transport.
 */
export async function createDevSandbox(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const child: ChildProcess = spawn(
    "deno",
    ["run", "--allow-env", "--no-prompt", opts.harnessPath],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
    },
  );

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

// ── Internal exports for testing ─────────────────────────────────────────────

/** @internal Exposed for testing only. */
export const _internals = {
  configureSandbox,
  createConnection,
};
