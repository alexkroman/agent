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
 * - On creation, the pool kicks off `targetSize` background spawns.
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
import type { WarmHarness } from "./sandbox-vm.ts";

// ── Types ────────────────────────────────────────────────────────────────

export type SandboxPoolOptions = {
  /** Target number of idle warm harnesses to keep ready. Must be >= 1. */
  targetSize: number;
  /** Spawns a fresh warm harness. Called by the pool to replenish. */
  spawn: () => WarmHarness;
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
  /** True once `shutdown()` has been called. */
  isShutdown(): boolean;
};

// ── Implementation ───────────────────────────────────────────────────────

const POOL_SIZE_MAX = 16;

export function createSandboxPool(opts: SandboxPoolOptions): SandboxPool {
  const targetSize = Math.max(1, Math.min(POOL_SIZE_MAX, Math.floor(opts.targetSize)));
  const ready: WarmHarness[] = [];
  let shutdown = false;

  function evictDead(handle: WarmHarness): void {
    const idx = ready.indexOf(handle);
    if (idx === -1) return;
    ready.splice(idx, 1);
    // Do NOT auto-replenish here. If spawns are dying immediately (e.g.
    // missing Deno binary), auto-replenish would create a tight fail loop.
    // The next `acquire()` will top up the pool when traffic arrives.
  }

  function spawnOne(): boolean {
    if (shutdown) return false;
    let warm: WarmHarness;
    try {
      warm = opts.spawn();
    } catch (err: unknown) {
      console.warn("Sandbox pool: warm spawn failed", { error: errorMessage(err) });
      return false;
    }
    // If the child dies before it's acquired, evict from the ready list.
    // After acquire it's no longer in `ready` so this is a no-op.
    warm.onExit(() => evictDead(warm));
    if (shutdown) {
      // Race: shutdown was called while we were spawning.
      void warm.cleanup().catch(() => undefined);
      return false;
    }
    ready.push(warm);
    return true;
  }

  function replenish(): void {
    if (shutdown) return;
    while (ready.length < targetSize) {
      if (!spawnOne()) break;
    }
  }

  // Kick off initial spawns. They run in background; constructor returns
  // immediately so server startup is not delayed by the pool.
  replenish();

  return {
    async acquire(): Promise<WarmHarness | null> {
      if (shutdown) return null;
      // Pop until we find a live one; replenish covers losses.
      let warm: WarmHarness | undefined;
      for (;;) {
        const next = ready.shift();
        if (!next) break;
        if (next.alive()) {
          warm = next;
          break;
        }
        // Dead — discard and continue
        void next.cleanup().catch(() => undefined);
      }
      // Replenish in the background regardless of hit/miss
      replenish();
      return warm ?? null;
    },

    async shutdown(): Promise<void> {
      shutdown = true;
      const idle = ready.splice(0, ready.length);
      await Promise.allSettled(idle.map((h) => h.cleanup()));
    },

    readySize(): number {
      return ready.length;
    },

    isShutdown(): boolean {
      return shutdown;
    },
  };
}
