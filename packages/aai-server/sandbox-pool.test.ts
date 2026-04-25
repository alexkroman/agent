// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxPool } from "./sandbox-pool.ts";
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

describe("createSandboxPool", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pre-spawns targetSize warm harnesses synchronously on creation", () => {
    const spawn = vi.fn(makeFakeWarm);
    const pool = createSandboxPool({ targetSize: 3, spawn });

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(pool.readySize()).toBe(3);
  });

  it("clamps targetSize to >= 1", () => {
    const spawn = vi.fn(makeFakeWarm);
    const pool = createSandboxPool({ targetSize: 0, spawn });
    expect(pool.readySize()).toBe(1);
  });

  it("clamps targetSize to <= POOL_SIZE_MAX (16)", () => {
    const spawn = vi.fn(makeFakeWarm);
    createSandboxPool({ targetSize: 100, spawn });
    expect(spawn).toHaveBeenCalledTimes(16);
  });

  it("acquire returns a warm harness from the pool", async () => {
    const harnesses = [makeFakeWarm(), makeFakeWarm()];
    let i = 0;
    const spawn = vi.fn((): WarmHarness => harnesses[i++] ?? (makeFakeWarm() as WarmHarness));
    const pool = createSandboxPool({ targetSize: 2, spawn });

    const acquired = await pool.acquire();
    expect(acquired).toBe(harnesses[0]);
  });

  it("acquire replenishes the pool to targetSize after a hit", async () => {
    const spawn = vi.fn(makeFakeWarm);
    const pool = createSandboxPool({ targetSize: 2, spawn });

    expect(spawn).toHaveBeenCalledTimes(2);

    await pool.acquire();
    expect(pool.readySize()).toBe(2);
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
    const spawn = vi.fn(makeDeadOnArrival);
    const pool = createSandboxPool({ targetSize: 2, spawn });
    expect(pool.readySize()).toBe(2);

    const acquired = await pool.acquire();
    expect(acquired).toBeNull();
  });

  it("acquire skips dead harnesses and returns the next live one", async () => {
    const dead = makeFakeWarm();
    const live = makeFakeWarm();
    const order: FakeWarm[] = [dead, live];
    let i = 0;
    // Lazy spawns after the seeded two so replenish doesn't run out.
    const spawn = vi.fn((): WarmHarness => {
      const next = order[i++];
      return next ?? (makeFakeWarm() as WarmHarness);
    });

    const pool = createSandboxPool({ targetSize: 2, spawn });
    expect(pool.readySize()).toBe(2);

    // Kill the first one BEFORE acquire by directly toggling alive.
    // We can't call __die() because that would also evict (via onExit).
    // Instead, mark alive=false without firing exit.
    (dead as unknown as { alive: () => boolean }).alive = () => false;

    const acquired = await pool.acquire();
    expect(acquired).toBe(live);
    // The dead one was discarded and cleanup called
    expect(dead.__cleanedUp()).toBe(true);
  });

  it("evicts a warm harness from the ready list when its process exits", () => {
    const w1 = makeFakeWarm();
    const w2 = makeFakeWarm();
    const harnesses = [w1, w2];
    let i = 0;
    const spawn = vi.fn(() => harnesses[i++] as WarmHarness);

    const pool = createSandboxPool({ targetSize: 2, spawn });
    expect(pool.readySize()).toBe(2);

    w1.__die();

    // Pool should drop the dead one. No auto-replenish (to avoid fail loops).
    expect(pool.readySize()).toBe(1);
  });

  it("does not auto-replenish when a warm harness dies (avoids fail loops)", () => {
    const harnesses = Array.from({ length: 10 }, () => makeFakeWarm());
    let i = 0;
    const spawn = vi.fn(() => harnesses[i++] as WarmHarness);

    const pool = createSandboxPool({ targetSize: 2, spawn });
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
    const spawn = vi.fn(() => harnesses[i++] as WarmHarness);

    const pool = createSandboxPool({ targetSize: 2, spawn });
    harnesses[0]?.__die();
    harnesses[1]?.__die();
    expect(pool.readySize()).toBe(0);

    const acquired = await pool.acquire();
    expect(acquired).toBeNull();
    // Acquire's replenish kicked off two new spawns
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(pool.readySize()).toBe(2);
  });

  it("shutdown cleans up all idle warm harnesses", async () => {
    const harnesses = Array.from({ length: 3 }, () => makeFakeWarm());
    let i = 0;
    const spawn = vi.fn(() => harnesses[i++] as WarmHarness);

    const pool = createSandboxPool({ targetSize: 3, spawn });
    expect(pool.readySize()).toBe(3);

    await pool.shutdown();

    expect(pool.isShutdown()).toBe(true);
    expect(pool.readySize()).toBe(0);
    for (const h of harnesses) {
      expect(h.__cleanedUp()).toBe(true);
    }
  });

  it("acquire returns null after shutdown without spawning", async () => {
    const spawn = vi.fn(makeFakeWarm);
    const pool = createSandboxPool({ targetSize: 2, spawn });
    expect(spawn).toHaveBeenCalledTimes(2);

    await pool.shutdown();
    spawn.mockClear();

    const result = await pool.acquire();
    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("logs and stops replenishing when spawn throws", () => {
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

  it("killing an acquired harness does not affect the pool's ready list", async () => {
    // Distinct harnesses for ctor + replenish
    const harnesses = Array.from({ length: 4 }, () => makeFakeWarm());
    let i = 0;
    const spawn = vi.fn(() => harnesses[i++] as WarmHarness);

    const pool = createSandboxPool({ targetSize: 1, spawn });
    const acquired = (await pool.acquire()) as FakeWarm;
    expect(acquired).toBe(harnesses[0]);

    // After acquire, replenish spawned harness #1 into ready
    expect(pool.readySize()).toBe(1);

    // Kill the acquired one — the pool's onExit listener should be a
    // no-op because it's no longer in the ready list.
    acquired.__die();
    expect(pool.readySize()).toBe(1);
  });
});
