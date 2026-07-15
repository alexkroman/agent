// Copyright 2025 the AAI authors. MIT license.
/**
 * Pool of pre-warmed Deno harness processes for faster cold starts.
 *
 * Inspired by Val Town: keep N idle Deno processes already past the slow
 * "spawn + JIT init + gVisor bootstrap" path. When a session needs a
 * sandbox, acquire a warm one from the pool and immediately send
 * `bundle/load` — skipping ~most of the cold-start latency.
 *
 * A warm harness is a spawned Deno process whose NDJSON connection is
 * wired to its stdio but which has not yet:
 * - had request handlers registered (KV / fetch)
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
 * - On `shutdown()`, the pool stops replenishing and tears down all idle
 *   warm harnesses.
 *
 * Acquire is non-blocking by design: blocking the caller while spawning
 * a fresh warm harness would defeat the purpose of pooling on the first
 * cold start. The caller's fallback path is just as fast as the pre-pool
 * behavior.
 */

import { errorMessage } from "@alexkroman1/aai";
import { metrics, type WarmPoolAcquireResult } from "./metrics.ts";
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
   * logged and stop replenishment to avoid tight fail loops.
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

const POOL_SIZE_MAX = 16;

export function createSandboxPool(opts: SandboxPoolOptions): SandboxPool {
  const targetSize = Math.max(1, Math.min(POOL_SIZE_MAX, Math.floor(opts.targetSize)));
  const ready: WarmHarness[] = [];
  const pending = new Set<Promise<void>>();
  let shutdown = false;
  let stoppedDueToFailure = false;

  // prom-client invokes `collect` whenever the metric is serialized.
  // Each new pool overwrites these — fine, since there's only ever one
  // pool per process in production.
  // biome-ignore lint/suspicious/noExplicitAny: prom-client typing limitation
  (metrics.warmPoolReady as any).collect = () => metrics.warmPoolReady.set(ready.length);
  // biome-ignore lint/suspicious/noExplicitAny: prom-client typing limitation
  (metrics.warmPoolPending as any).collect = () => metrics.warmPoolPending.set(pending.size);

  function recordSpawnFailure(err: unknown): void {
    stoppedDueToFailure = true;
    metrics.warmPoolSpawnFailed.inc();
    console.warn("Sandbox pool: warm spawn failed", { error: errorMessage(err) });
  }

  function evictDead(handle: WarmHarness): void {
    const idx = ready.indexOf(handle);
    if (idx === -1) return;
    ready.splice(idx, 1);
    // Do NOT auto-replenish here — if spawns die immediately (e.g. missing
    // Deno binary) it would create a tight fail loop. The next `acquire()`
    // tops up the pool when traffic arrives.
  }

  function spawnOne(): void {
    if (shutdown || stoppedDueToFailure) return;
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
    while (!(shutdown || stoppedDueToFailure) && ready.length + pending.size < targetSize) {
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
      const result: WarmPoolAcquireResult = warm ? "hit" : "miss";
      metrics.warmPoolAcquire.inc({ result });
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
