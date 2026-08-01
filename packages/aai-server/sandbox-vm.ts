// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by Modal Sandboxes (see modal-sandbox.ts) in
 * production, and in local dev by local Apple containers
 * (subprocess-sandbox.ts). `sandbox-backend.ts` owns the selection
 * policy.
 *
 * Provides the `SandboxHandle` abstraction that `sandbox.ts` delegates to.
 * The guest runs the COMPLETE agent runtime; this control channel (JSON-RPC
 * over the harness's WebSocket, dialed through the sandbox's Modal tunnel or
 * the container's published loopback port) carries only bundle loading,
 * one-shot tool trials, the session-count probe, and the guest's ctx.db
 * proxy. Clients connect directly to the guest's public `/websocket`
 * endpoint (`SandboxHandle.sessionUrl`).
 */

import { performance } from "node:perf_hooks";
import type { Db } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { spawnModalWarm } from "./modal-sandbox.ts";
import type { BundleLoadResult, GuestConnection } from "./rpc-schemas.ts";
import { resolveSandboxBackend } from "./sandbox-backend.ts";
import { registerGuestRpcHandlers } from "./sandbox-guest-rpc.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { spawnSubprocessWarm } from "./subprocess-sandbox.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxHandle = {
  conn: GuestConnection;
  /** Public client-session endpoint on the sandbox's tunnel. */
  sessionUrl: string;
  shutdown(): Promise<void>;
};

/**
 * A spawned harness whose guest process is running and whose RPC connection
 * is dialed, but which has NOT yet received a bundle/load. Used by the
 * sandbox pool for warm starts.
 *
 * `listen()` has not been called on the connection yet — the per-agent
 * configuration step (handler registration + bundle/load) will call it
 * after handlers are registered.
 */
export type WarmHarness = {
  conn: GuestConnection;
  /** Public client-session endpoint on the sandbox's tunnel. */
  sessionUrl: string;
  cleanup: () => Promise<void>;
  /** True while the underlying guest process is alive. */
  alive: () => boolean;
  /** Register a one-shot listener for guest exit (for pool reaping). */
  onExit: (cb: () => void) => void;
  [Symbol.asyncDispose](): Promise<void>;
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
};

/** Minimal interface the pool exposes to createSandboxVm. */
type WarmHarnessSource = {
  acquire(): Promise<WarmHarness | null>;
};

// ── Shared setup ─────────────────────────────────────────────────────────────

/**
 * Finalize a warm harness for a specific agent: register host-side RPC
 * handlers, start listening on the connection, and send bundle/load.
 * Returns the configured SandboxHandle.
 *
 * Splitting register-handlers → listen → bundle-load lets the pool
 * spawn a harness ahead of time without committing to an agent identity.
 * Handlers MUST be registered before listen() so no incoming guest messages
 * are dropped.
 */
async function configureSandbox(warm: WarmHarness, opts: SandboxVmOptions): Promise<SandboxHandle> {
  const { conn } = warm;

  // Host serves guest ctx.db requests — see sandbox-guest-rpc.ts.
  registerGuestRpcHandlers(conn, opts);

  conn.listen();

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
    // bundle/load can time out (a bundle whose top level never resolves).
    // Tear down the harness sandbox so it doesn't leak, then rethrow.
    await warm[Symbol.asyncDispose]();
    throw err;
  }
  debug("Sandbox bundle/load complete", {
    slug: opts.slug,
    bytes: opts.workerCode.length,
    ms: Math.round(performance.now() - tBundle),
  });

  return {
    conn,
    sessionUrl: warm.sessionUrl,
    // One teardown definition (`WarmHarness[Symbol.asyncDispose]`) so this
    // handle and every error path below can't drift on the shutdown-notify /
    // dispose / cleanup triple.
    shutdown: () => warm[Symbol.asyncDispose](),
  };
}

// ── Warm-harness spawning ────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness in a fresh sandbox. The returned WarmHarness has
 * a running guest process and a dialed RPC channel, but no listeners
 * attached and no bundle loaded.
 *
 * Single dispatch point for the backend policy, used by both the sandbox pool
 * and on-demand sandbox creation. `resolveSandboxBackend` (see
 * `sandbox-backend.ts`) picks Modal in production and the isolation-free
 * `subprocess` backend in local dev. Spawning fails loudly when the chosen
 * backend's prerequisites are absent — there is no fallback *between* backends
 * at spawn time, only at selection time, and selection can never reach
 * `subprocess` outside local dev.
 *
 * `slug` only affects the sandbox's observability tag (pool spawns default
 * to "pool"); under Modal the security boundary is the sandbox container.
 */
export async function spawnWarmHarness(opts: {
  harnessPath: string;
  slug?: string;
}): Promise<WarmHarness> {
  switch (resolveSandboxBackend(process.env)) {
    case "subprocess":
      return spawnSubprocessWarm(opts);
    default:
      return spawnModalWarm(opts);
  }
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
  await using warm =
    (await opts.pool?.acquire()) ??
    (await spawn({ harnessPath: opts.harnessPath, slug: "studio-inspect" }));
  // Register the standard guest-RPC handlers (with no db bound) so a
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
}

// ── Test-only internals ─────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  configureSandbox,
};

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a sandbox backed by the selected backend (see spawnWarmHarness).
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
  if (pool) {
    const warm = await pool.acquire();
    // A ready pooled harness is the only fast path.
    if (warm) {
      try {
        return await configureSandbox(warm, opts);
      } catch (err: unknown) {
        // The warm harness can die between acquire()'s alive() check and
        // bundle/load. Don't fail the session for it — clean up (idempotent;
        // the bundle/load failure path already did) and fall through to a
        // cold spawn, which either works or surfaces the real error.
        console.warn("Warm sandbox configuration failed; falling back to cold spawn", {
          slug: opts.slug,
          error: errorMessage(err),
        });
        await warm[Symbol.asyncDispose]();
      }
    }
  }

  const warm = await spawn({
    harnessPath: opts.harnessPath,
    slug: opts.slug,
  });
  try {
    return await configureSandbox(warm, opts);
  } catch (err) {
    // configureSandbox's own cleanup only covers the bundle/load failure
    // path; a throw before it (handler registration, listen) would strand
    // the just-spawned Modal sandbox until the guest orphan watchdog reaps
    // it. Idempotent with that path's cleanup.
    await warm[Symbol.asyncDispose]();
    throw err;
  }
}
