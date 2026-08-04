// Copyright 2025 the AAI authors. MIT license.
/**
 * Pool of pre-warmed Node harness sandboxes for faster cold starts.
 *
 * Keep N idle guest sandboxes already past the slow "Modal sandbox create +
 * dial" path. When a session needs a sandbox, acquire a warm one from the
 * pool and immediately send `bundle/load` — skipping most of the cold-start
 * latency.
 *
 * A warm harness is a spawned guest sandbox whose control-channel WebSocket
 * is dialed but which has not yet:
 * - had `listen()` called
 * - received the agent's bundle
 *
 * That per-agent finalization happens in `configureSandbox` after acquire.
 *
 * Lifecycle:
 * - On creation, the pool kicks off `targetSize` async spawns. They run
 *   in the background and land in `ready` as they complete; the pool
 *   constructor never blocks.
 * - On `acquire()`, returns the next warm harness immediately if one is
 *   ready; otherwise returns `null` (caller falls back to a fresh spawn).
 *   Either way, the pool replenishes asynchronously so future cold starts
 *   stay fast.
 * - If a warm harness's child process dies before it's acquired, it is
 *   evicted and replenishment kicks off.
 * - Spawn failures put replenishment into a cooldown (exponential backoff
 *   on consecutive failures) instead of disabling the pool permanently —
 *   a transient failure (fd pressure, slow disk) must not turn every
 *   future session into a cold start. A successful spawn resets the
 *   backoff fully.
 * - On `shutdown()`, the pool stops replenishing and tears down all idle
 *   warm harnesses.
 *
 * Acquire is non-blocking by design: blocking the caller while spawning
 * a fresh warm harness would defeat the purpose of pooling on the first
 * cold start. The caller's fallback path is just as fast as the pre-pool
 * behavior.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { WarmHarness } from "./sandbox-vm.ts";

// ── Types ────────────────────────────────────────────────────────────────

type SandboxPoolOptions = {
  /** Target number of idle warm harnesses to keep ready. Must be >= 1. */
  targetSize: number;
  /**
   * Spawns a fresh warm harness. Called by the pool to replenish.
   *
   * The returned promise must resolve once the child process is running
   * and its NDJSON channel is wired (no bundle/load yet). Rejections are
   * logged and suppress replenishment for a cooldown period to avoid
   * tight fail loops.
   */
  spawn: () => Promise<WarmHarness>;
};

export type SandboxPool = {
  /**
   * Returns an idle warm harness immediately, or `null` if none is ready.
   * Triggers async replenishment in either case.
   */
  acquire(): Promise<WarmHarness | null>;
  /** Stop replenishing and tear down all idle warm harnesses. */
  shutdown(): Promise<void>;
  /** Number of warm harnesses currently idle and ready. */
  readySize(): number;
  /** Number of in-flight spawns not yet ready. */
  pendingSize(): number;
  /** True once `shutdown()` has been called. */
  isShutdown(): boolean;
};

// ── Implementation ───────────────────────────────────────────────────────

/**
 * Hard ceiling on the warm sandbox pool. Exported because `_boot.ts` clamps
 * `SANDBOX_POOL_SIZE` to it before logging the boot line and the
 * `warm_pool_target` metric: two copies meant raising the ceiling in one file
 * made those report a size the pool would not actually run at.
 */
export const POOL_SIZE_MAX = 16;

/** Base cooldown after a spawn failure before replenishment resumes. */
export const SPAWN_FAILURE_COOLDOWN_MS = 30_000;
/** Cap on the exponential backoff for consecutive spawn failures. */
const SPAWN_FAILURE_COOLDOWN_MAX_MS = 5 * 60_000;

export function createSandboxPool(opts: SandboxPoolOptions): SandboxPool {
  const targetSize = Math.max(1, Math.min(POOL_SIZE_MAX, Math.floor(opts.targetSize)));
  const ready: WarmHarness[] = [];
  const pending = new Set<Promise<void>>();
  let shutdown = false;
  // Spawn-failure backoff: replenishment is suppressed until `cooldownUntil`,
  // doubling per consecutive failure. Fully reset by a successful spawn.
  let consecutiveSpawnFailures = 0;
  let cooldownUntil = 0;

  function recordSpawnFailure(err: unknown): void {
    consecutiveSpawnFailures++;
    const backoffMs = Math.min(
      SPAWN_FAILURE_COOLDOWN_MAX_MS,
      SPAWN_FAILURE_COOLDOWN_MS * 2 ** (consecutiveSpawnFailures - 1),
    );
    cooldownUntil = Date.now() + backoffMs;
    console.warn("Sandbox pool: warm spawn failed", {
      error: errorMessage(err),
      cooldownMs: backoffMs,
    });
  }

  function inCooldown(): boolean {
    return Date.now() < cooldownUntil;
  }

  function evictDead(handle: WarmHarness): void {
    const idx = ready.indexOf(handle);
    if (idx === -1) return;
    ready.splice(idx, 1);
    // The guest process is dead but the Modal sandbox may not be —
    // cleanup terminates it (same fire-and-forget shape as acquire()'s
    // dead-entry path).
    void handle.cleanup().catch(() => undefined);
    // Do NOT auto-replenish here — if spawns die immediately (e.g. missing
    // Modal credentials) it would create a tight fail loop. The next
    // `acquire()` tops up the pool when traffic arrives.
  }

  function spawnOne(): void {
    if (shutdown || inCooldown()) return;
    let p: Promise<WarmHarness>;
    try {
      p = opts.spawn();
    } catch (err: unknown) {
      recordSpawnFailure(err);
      return;
    }
    const tracked = (async () => {
      let warm: WarmHarness;
      try {
        warm = await p;
      } catch (err: unknown) {
        recordSpawnFailure(err);
        return;
      }
      // A successful spawn proves the backend is healthy again.
      consecutiveSpawnFailures = 0;
      cooldownUntil = 0;
      if (shutdown) {
        await warm.cleanup().catch(() => undefined);
        return;
      }
      warm.onExit(() => evictDead(warm));
      ready.push(warm);
    })().finally(() => {
      pending.delete(tracked);
    });
    pending.add(tracked);
  }

  function replenish(): void {
    while (!(shutdown || inCooldown()) && ready.length + pending.size < targetSize) {
      spawnOne();
    }
  }

  replenish();

  return {
    async acquire(): Promise<WarmHarness | null> {
      let warm: WarmHarness | undefined;
      if (!shutdown) {
        for (let next = ready.shift(); next; next = ready.shift()) {
          if (next.alive()) {
            warm = next;
            break;
          }
          void next.cleanup().catch(() => undefined);
        }
        replenish();
      }
      return warm ?? null;
    },

    async shutdown(): Promise<void> {
      shutdown = true;
      const idle = ready.splice(0, ready.length);
      // Wait for in-flight spawns first so their warm harnesses get
      // cleaned up by the shutdown branch in spawnOne.
      await Promise.allSettled([...pending]);
      await Promise.allSettled(idle.map((h) => h.cleanup()));
    },

    readySize(): number {
      return ready.length;
    },

    pendingSize(): number {
      return pending.size;
    },

    isShutdown(): boolean {
      return shutdown;
    },
  };
}
