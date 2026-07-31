// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by Modal Sandboxes (see modal-sandbox.ts).
 *
 * Provides the `SandboxHandle` abstraction that `sandbox.ts` delegates to.
 * Communication with the guest uses NDJSON over the exec'd harness process's
 * stdio streams.
 */

import { performance } from "node:perf_hooks";
import type { Db } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai";
import type { HostGenerateFn, Vector } from "@alexkroman1/aai/runtime";
import { debug } from "./_debug-log.ts";
import {
  hrtimeSeconds,
  metrics,
  type SandboxInitFailReason,
  type SandboxInitPath,
} from "./metrics.ts";
import { spawnModalWarm } from "./modal-sandbox.ts";
import type { BundleLoadResult, GuestConnection } from "./rpc-schemas.ts";
import { registerGuestRpcHandlers } from "./sandbox-guest-rpc.ts";
import type { SandboxPool } from "./sandbox-pool.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxHandle = {
  conn: GuestConnection;
  shutdown(): Promise<void>;
};

/**
 * A spawned harness whose guest process is running and whose NDJSON
 * connection is wired to its stdio, but which has NOT yet received a
 * bundle/load. Used by the sandbox pool for warm starts.
 *
 * `listen()` has not been called on the connection yet — the per-agent
 * configuration step (db/fetch handler registration + bundle/load) will
 * call it after handlers are registered.
 */
export type WarmHarness = {
  conn: GuestConnection;
  cleanup: () => Promise<void>;
  /** True while the underlying guest process is alive. */
  alive: () => boolean;
  /** Register a one-shot listener for guest exit (for pool reaping). */
  onExit: (cb: () => void) => void;
};

export type SandboxVmOptions = {
  slug: string;
  workerCode: string;
  env: Record<string, string>;
  harnessPath: string;
  /**
   * App database handle (enables the db/query RPC handler and tells the
   * guest storage is enabled, so ctx.db resolves instead of throwing).
   */
  db?: Db;
  /** Resolved Vector instance (enables vector/* RPC handlers when set). */
  vector?: Vector;
  /** Host generate fn (enables the llm/generate RPC handler when set). */
  generate?: HostGenerateFn;
  allowedHosts?: string[];
};

/** Minimal interface the pool exposes to createSandboxVm. */
type WarmHarnessSource = {
  acquire(): Promise<WarmHarness | null>;
};

// ── Shared setup ─────────────────────────────────────────────────────────────

/**
 * Finalize a warm harness for a specific agent: register host-side db/fetch
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

  // Host serves guest db/Vector/fetch requests — see sandbox-guest-rpc.ts.
  registerGuestRpcHandlers(conn, opts);

  conn.listen();

  // Send bundle to guest. The bundle/load round-trip is on the request
  // path, so we time it to distinguish guest cold-start latency (Modal
  // sandbox boot + Deno V8 init) from host-side spawn overhead.
  const tBundle = performance.now();
  try {
    await conn.sendRequest("bundle/load", {
      code: opts.workerCode,
      env: opts.env,
      // Tells the guest whether ctx.db is live (proxied over db/query) or
      // should throw the storage-not-enabled guidance.
      storageEnabled: opts.db !== undefined,
    });
  } catch (err) {
    // bundle/load can now time out (a bundle whose top level never resolves).
    // Tear down the harness sandbox so it doesn't leak, then rethrow.
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
      // Best-effort: under stdin backpressure the queued notification hits
      // dispose()'s dead-stream guard and is dropped. That's acceptable —
      // cleanup() terminates the Modal sandbox, so the guest dies either way.
      void conn.sendNotification("shutdown");
      conn.dispose();
      await warm.cleanup();
    },
  };
}

// ── Warm-harness spawning ────────────────────────────────────────────────────

/**
 * Spawn a warm Deno harness in a fresh Modal sandbox. The returned
 * WarmHarness has a running guest process and a connected NDJSON channel,
 * but no listeners are attached and no bundle has been loaded.
 *
 * Single source of the backend policy, used by both the sandbox pool and
 * on-demand sandbox creation. Modal is the only backend — spawning fails
 * loudly (dev and prod alike) when Modal credentials are absent.
 *
 * `slug` only affects the sandbox's observability tag (pool spawns default
 * to "pool"); the security boundary is Modal's sandbox isolation.
 */
export async function spawnWarmHarness(opts: {
  harnessPath: string;
  slug?: string;
}): Promise<WarmHarness> {
  return spawnModalWarm(opts);
}

// ── Bundle inspection ────────────────────────────────────────────────────────

/**
 * Load a worker bundle in a throwaway sandbox and return the agent config the
 * bundle extracted about itself (its `__aaiConfig` export — see the guest
 * harness). The bundle is *evaluated in the sandbox*, never on the host, so
 * this is safe to run on untrusted studio-authored code. The sandbox is torn
 * down before returning.
 *
 * Returns `undefined` when the bundle does not self-describe (e.g. a plain
 * CLI-built worker, which ships its config separately).
 */
export async function describeBundle(
  opts: { harnessPath: string; workerCode: string; pool?: SandboxPool | undefined },
  spawn: typeof spawnWarmHarness = spawnWarmHarness,
): Promise<unknown> {
  // Prefer a pre-warmed harness when the caller holds a pool — the studio's
  // Publish path does — falling back to a cold spawn exactly like
  // `createStudioSandbox`. `acquire()` returns null when the pool is empty.
  const warm =
    (await opts.pool?.acquire()) ??
    (await spawn({ harnessPath: opts.harnessPath, slug: "studio-inspect" }));
  try {
    // Register the standard guest-RPC handlers (with no db/Vector bound) so a
    // bundle whose top level issues a guest→host request gets an error reply
    // instead of wedging the load until the RPC timeout.
    registerGuestRpcHandlers(warm.conn, {});
    warm.conn.listen();
    // The reply is guest-asserted wire data (see BundleLoadResult); the
    // caller validates `config` with IsolateConfigSchema.
    const result = (await warm.conn.sendRequest("bundle/load", {
      code: opts.workerCode,
      env: {},
      // Explicit even though the guest schema defaults it: every in-repo
      // sender states its storage intent.
      storageEnabled: false,
    })) as BundleLoadResult | undefined;
    return result?.config;
  } finally {
    void warm.conn.sendNotification("shutdown");
    warm.conn.dispose();
    await warm.cleanup().catch(() => undefined);
  }
}

// ── Test-only internals ─────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  configureSandbox,
};

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a sandbox backed by a Modal Sandbox.
 *
 * If a `pool` is provided, attempts to acquire a pre-warmed harness from
 * it before spawning a fresh one. Falls back to a fresh spawn if the pool
 * is empty or returns a dead harness.
 */
export async function createSandboxVm(
  opts: SandboxVmOptions,
  pool?: WarmHarnessSource,
  spawn: typeof spawnWarmHarness = spawnWarmHarness,
): Promise<SandboxHandle> {
  const t0 = process.hrtime.bigint();
  try {
    const { handle, path } = await createSandboxVmInner(opts, pool, spawn);
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
  spawn: typeof spawnWarmHarness,
): Promise<{ handle: SandboxHandle; path: SandboxInitPath }> {
  if (pool) {
    const warm = await pool.acquire();
    // A ready pooled harness is the only fast path.
    if (warm) {
      try {
        return { handle: await configureSandbox(warm, opts), path: "warm" };
      } catch (err: unknown) {
        // The warm harness can die between acquire()'s alive() check and
        // bundle/load. Don't fail the session for it — clean up (idempotent;
        // the bundle/load failure path already did) and fall through to a
        // cold spawn, which either works or surfaces the real error.
        console.warn("Warm sandbox configuration failed; falling back to cold spawn", {
          slug: opts.slug,
          error: errorMessage(err),
        });
        warm.conn.dispose();
        await warm.cleanup().catch(() => undefined);
      }
    }
  }

  const warm = await spawn({
    harnessPath: opts.harnessPath,
    slug: opts.slug,
  });
  return { handle: await configureSandbox(warm, opts), path: "cold" };
}
