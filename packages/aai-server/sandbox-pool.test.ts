// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "./metrics.ts";
import { createSandboxPool, type SandboxPool } from "./sandbox-pool.ts";
import type { WarmHarness } from "./sandbox-vm.ts";

// ── Test helpers ─────────────────────────────────────────────────────────

type FakeWarm = WarmHarness & {
  /** Simulate the underlying child process exiting. */
  __die(): void;
  __cleanedUp(): boolean;
};

function makeFakeWarm(): FakeWarm {
  let alive = true;
  let cleanedUp = false;
  const exitListeners: (() => void)[] = [];
  const warm: FakeWarm = {
    conn: {} as WarmHarness["conn"],
    cleanup: vi.fn(async () => {
      cleanedUp = true;
    }),
    alive: () => alive,
    onExit: (cb) => {
      exitListeners.push(cb);
    },
    __die() {
      if (!alive) return;
      alive = false;
      for (const cb of exitListeners) cb();
    },
    __cleanedUp: () => cleanedUp,
  };
  return warm;
}

/** Wait for the pool's in-flight spawns to settle. */
async function waitForReady(pool: SandboxPool, expected: number): Promise<void> {
  await vi.waitFor(() => {
    if (pool.readySize() !== expected) {
      throw new Error(`expected ready=${expected}, got ${pool.readySize()}`);
    }
  });
}

describe("createSandboxPool", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kicks off targetSize spawns synchronously on creation", () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 3, spawn });

    // spawn() is invoked synchronously even though it returns a promise —
    // this is what keeps the constructor non-blocking yet eager.
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(pool.pendingSize()).toBe(3);
  });

  it("warm harnesses become ready after async spawns resolve", async () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 3, spawn });

    await waitForReady(pool, 3);
    expect(pool.pendingSize()).toBe(0);
  });

  it("clamps targetSize to >= 1", async () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 0, spawn });
    await waitForReady(pool, 1);
  });

  it("clamps targetSize to <= POOL_SIZE_MAX (16)", () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    createSandboxPool({ targetSize: 100, spawn });
    expect(spawn).toHaveBeenCalledTimes(16);
  });

  it("acquire returns a warm harness from the pool", async () => {
    const harnesses = [makeFakeWarm(), makeFakeWarm()];
    let i = 0;
    const spawn = vi.fn(async (): Promise<WarmHarness> => harnesses[i++] ?? makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);

    const acquired = await pool.acquire();
    expect(acquired).toBe(harnesses[0]);
  });

  it("acquire replenishes the pool to targetSize after a hit", async () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 2, spawn });

    await waitForReady(pool, 2);
    expect(spawn).toHaveBeenCalledTimes(2);

    await pool.acquire();
    await waitForReady(pool, 2);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("acquire returns null when every harness in the queue is dead", async () => {
    // Spawn returns harnesses that mark dead via alive()===false but do
    // NOT fire onExit (so they stay in the ready queue). Acquire should
    // discard them one by one and return null.
    const makeDeadOnArrival = (): WarmHarness => {
      const w = makeFakeWarm();
      // Override alive without triggering onExit listeners
      (w as unknown as { alive: () => boolean }).alive = () => false;
      return w;
    };
    const spawn = vi.fn(async () => makeDeadOnArrival());
    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);

    const acquired = await pool.acquire();
    expect(acquired).toBeNull();
  });

  it("acquire skips dead harnesses and returns the next live one", async () => {
    const dead = makeFakeWarm();
    const live = makeFakeWarm();
    const order: FakeWarm[] = [dead, live];
    let i = 0;
    // Lazy spawns after the seeded two so replenish doesn't run out.
    const spawn = vi.fn(async (): Promise<WarmHarness> => {
      const next = order[i++];
      return next ?? makeFakeWarm();
    });

    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);

    // Kill the first one BEFORE acquire by directly toggling alive.
    // We can't call __die() because that would also evict (via onExit).
    // Instead, mark alive=false without firing exit.
    (dead as unknown as { alive: () => boolean }).alive = () => false;

    const acquired = await pool.acquire();
    expect(acquired).toBe(live);
    // The dead one was discarded and cleanup called
    expect(dead.__cleanedUp()).toBe(true);
  });

  it("evicts a warm harness from the ready list when its process exits", async () => {
    const w1 = makeFakeWarm();
    const w2 = makeFakeWarm();
    const harnesses = [w1, w2];
    let i = 0;
    const spawn = vi.fn(async (): Promise<WarmHarness> => harnesses[i++] ?? makeFakeWarm());

    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);

    w1.__die();

    // Pool should drop the dead one. No auto-replenish (to avoid fail loops).
    expect(pool.readySize()).toBe(1);
  });

  it("does not auto-replenish when a warm harness dies (avoids fail loops)", async () => {
    const harnesses = Array.from({ length: 10 }, () => makeFakeWarm());
    let i = 0;
    const spawn = vi.fn(async (): Promise<WarmHarness> => harnesses[i++] ?? makeFakeWarm());

    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);
    expect(spawn).toHaveBeenCalledTimes(2);

    // Kill both
    harnesses[0]?.__die();
    harnesses[1]?.__die();

    // No new spawns triggered by death events
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(pool.readySize()).toBe(0);
  });

  it("acquire after death triggers a replenish", async () => {
    const harnesses = Array.from({ length: 10 }, () => makeFakeWarm());
    let i = 0;
    const spawn = vi.fn(async (): Promise<WarmHarness> => harnesses[i++] ?? makeFakeWarm());

    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);
    harnesses[0]?.__die();
    harnesses[1]?.__die();
    expect(pool.readySize()).toBe(0);

    const acquired = await pool.acquire();
    expect(acquired).toBeNull();
    // Acquire's replenish kicked off two new spawns
    await waitForReady(pool, 2);
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it("shutdown cleans up all idle warm harnesses", async () => {
    const harnesses = Array.from({ length: 3 }, () => makeFakeWarm());
    let i = 0;
    const spawn = vi.fn(async (): Promise<WarmHarness> => harnesses[i++] ?? makeFakeWarm());

    const pool = createSandboxPool({ targetSize: 3, spawn });
    await waitForReady(pool, 3);

    await pool.shutdown();

    expect(pool.isShutdown()).toBe(true);
    expect(pool.readySize()).toBe(0);
    for (const h of harnesses) {
      expect(h.__cleanedUp()).toBe(true);
    }
  });

  it("shutdown cleans up in-flight spawns once they resolve", async () => {
    let resolveSpawn: ((w: WarmHarness) => void) | undefined;
    const pendingWarm = makeFakeWarm();
    const spawn = vi.fn(
      () =>
        new Promise<WarmHarness>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const pool = createSandboxPool({ targetSize: 1, spawn });
    expect(pool.pendingSize()).toBe(1);

    const shutdownPromise = pool.shutdown();
    // Resolve the in-flight spawn after shutdown started — its warm
    // harness should be cleaned up rather than added to ready.
    resolveSpawn?.(pendingWarm);
    await shutdownPromise;

    expect(pendingWarm.__cleanedUp()).toBe(true);
    expect(pool.readySize()).toBe(0);
  });

  it("acquire returns null after shutdown without spawning", async () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);

    await pool.shutdown();
    spawn.mockClear();

    const result = await pool.acquire();
    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("logs and stops replenishing when spawn synchronously throws", () => {
    const warnSpy = vi.spyOn(console, "warn");
    const spawn = vi.fn(() => {
      throw new Error("deno not found");
    });

    const pool = createSandboxPool({ targetSize: 3, spawn });

    // First failed spawn breaks the replenish loop — does not call spawn
    // again to fill.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pool.readySize()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "Sandbox pool: warm spawn failed",
      expect.objectContaining({ error: expect.stringContaining("deno not found") }),
    );
  });

  it("logs and stops replenishing when spawn rejects asynchronously", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const spawn = vi.fn(async () => {
      throw new Error("rootfs prep failed");
    });

    const pool = createSandboxPool({ targetSize: 3, spawn });
    // All three spawns kicked off concurrently before any rejected.
    expect(spawn).toHaveBeenCalledTimes(3);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "Sandbox pool: warm spawn failed",
        expect.objectContaining({ error: expect.stringContaining("rootfs prep failed") }),
      );
    });
    // Pool state ends up empty and won't replenish further.
    expect(pool.readySize()).toBe(0);
    expect(pool.pendingSize()).toBe(0);
  });

  it("killing an acquired harness does not affect the pool's ready list", async () => {
    // Distinct harnesses for ctor + replenish
    const harnesses = Array.from({ length: 4 }, () => makeFakeWarm());
    let i = 0;
    const spawn = vi.fn(async (): Promise<WarmHarness> => harnesses[i++] ?? makeFakeWarm());

    const pool = createSandboxPool({ targetSize: 1, spawn });
    await waitForReady(pool, 1);
    const acquired = (await pool.acquire()) as FakeWarm;
    expect(acquired).toBe(harnesses[0]);

    // After acquire, replenish spawned harness #1 into ready
    await waitForReady(pool, 1);

    // Kill the acquired one — the pool's onExit listener should be a
    // no-op because it's no longer in the ready list.
    acquired.__die();
    expect(pool.readySize()).toBe(1);
  });
});

// ── Pool metrics ─────────────────────────────────────────────────────────

function counterValue(name: string, labels: Record<string, string> = {}): number {
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  const m = registry.getSingleMetric(name) as any;
  if (!m?.hashMap) return 0;
  if (Object.keys(labels).length === 0) {
    return m.hashMap[""]?.value ?? 0;
  }
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  for (const entry of Object.values(m.hashMap) as any[]) {
    const ok = Object.entries(labels).every(([k, v]) => entry.labels?.[k] === v);
    if (ok) return entry.value ?? 0;
  }
  return 0;
}

function gaugeValue(name: string): number {
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  const m = registry.getSingleMetric(name) as any;
  return m?.hashMap?.[""]?.value ?? 0;
}

describe("sandbox-pool metrics", () => {
  beforeEach(() => {
    registry.resetMetrics();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    registry.resetMetrics();
    vi.restoreAllMocks();
  });

  it("increments aai_warm_pool_acquire_total{result=hit} on warm acquire", async () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 1, spawn });
    await waitForReady(pool, 1);
    const acquired = await pool.acquire();
    expect(acquired).not.toBeNull();
    expect(counterValue("aai_warm_pool_acquire_total", { result: "hit" })).toBe(1);
  });

  it("increments aai_warm_pool_acquire_total{result=miss} when pool is empty", async () => {
    // spawn never resolves → pool stays empty
    const spawn = vi.fn(() => new Promise<WarmHarness>(() => undefined));
    const pool = createSandboxPool({ targetSize: 1, spawn });
    const acquired = await pool.acquire();
    expect(acquired).toBeNull();
    expect(counterValue("aai_warm_pool_acquire_total", { result: "miss" })).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("publishes ready/pending gauges that match pool state", async () => {
    const spawn = vi.fn(async () => makeFakeWarm());
    const pool = createSandboxPool({ targetSize: 2, spawn });
    await waitForReady(pool, 2);
    // Trigger a state-publishing call (acquire republishes gauges).
    await pool.acquire();
    await vi.waitFor(() => {
      // After an acquire-and-replenish round the pool is back to ready=2.
      expect(gaugeValue("aai_warm_pool_ready")).toBe(pool.readySize());
      expect(gaugeValue("aai_warm_pool_pending")).toBe(pool.pendingSize());
    });
  });

  it("increments aai_warm_pool_spawn_failed_total when spawn rejects", async () => {
    const spawn = vi.fn(() => Promise.reject(new Error("boom")));
    const pool = createSandboxPool({ targetSize: 2, spawn });
    await vi.waitFor(() => {
      expect(counterValue("aai_warm_pool_spawn_failed_total")).toBeGreaterThanOrEqual(1);
    });
    expect(pool.readySize()).toBe(0);
  });
});
