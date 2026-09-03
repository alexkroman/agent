// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, it, vi } from "vitest";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import { SHUTDOWN_GRACE_MS, shutdownGraceMs, teardownSandboxes } from "./teardown-sandboxes.ts";
import { captureLogs } from "./test-utils.ts";

const fakeSandbox = () => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
  drain: vi.fn().mockResolvedValue(undefined),
});

describe("teardownSandboxes", () => {
  const logs = captureLogs();

  // A replica going down is a redeploy from the guests' point of view: their
  // sessions dial the tunnel directly and never touch this process, so the
  // guests are RETIRED (drained, guest owns its own exit), never terminated —
  // terminating them here is what used to cut live calls on every scale-in.
  it("retires every slot's sandbox: drains with a budget, never terminates", async () => {
    const slots = createSlotCache();
    const a = fakeSandbox();
    const b = fakeSandbox();
    setSlot(slots, { slug: "a", sandbox: a });
    setSlot(slots, { slug: "b", sandbox: b });

    await teardownSandboxes({ slots, graceMs: 0 });

    expect(a.drain).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
    expect(b.drain).toHaveBeenCalledExactlyOnceWith(expect.any(Number));
    expect(a.shutdown).not.toHaveBeenCalled();
    expect(b.shutdown).not.toHaveBeenCalled();
    // Detached, so nothing else can route to or double-release them.
    expect(slots.get("a")?.sandbox).toBeUndefined();
    expect(slots.get("b")?.sandbox).toBeUndefined();
  });

  it("terminates a guest that is unreachable for the drain", async () => {
    const slots = createSlotCache();
    const dead = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      drain: vi.fn().mockRejectedValue(new Error("guest gone")),
    };
    setSlot(slots, { slug: "dead", sandbox: dead });

    await teardownSandboxes({ slots, graceMs: 0 });

    expect(dead.shutdown).toHaveBeenCalledOnce();
  });

  // The studio broker's own per-project sandboxes: dispose() existed and was
  // documented for shutdown, but had no production call site, so every
  // restart orphaned one guest per active project.
  it("disposes the studio session broker", async () => {
    const broker = { dispose: vi.fn().mockResolvedValue(undefined) };

    await teardownSandboxes({ slots: createSlotCache(), broker, graceMs: 0 });

    expect(broker.dispose).toHaveBeenCalledOnce();
  });

  it("releases everything else even when one guest rejects everything", async () => {
    const slots = createSlotCache();
    const bad = {
      shutdown: vi.fn().mockRejectedValue(new Error("already gone")),
      drain: vi.fn().mockRejectedValue(new Error("guest gone")),
    };
    const good = fakeSandbox();
    setSlot(slots, { slug: "bad", sandbox: bad });
    setSlot(slots, { slug: "good", sandbox: good });
    const broker = { dispose: vi.fn().mockResolvedValue(undefined) };

    await expect(teardownSandboxes({ graceMs: 0, slots, broker })).resolves.toBeUndefined();

    expect(good.drain).toHaveBeenCalledOnce();
    expect(broker.dispose).toHaveBeenCalledOnce();
  });

  it("warns rather than throwing when the broker dispose rejects", async () => {
    const broker = { dispose: vi.fn().mockRejectedValue(new Error("broker boom")) };

    await expect(
      teardownSandboxes({ slots: createSlotCache(), broker, graceMs: 0 }),
    ).resolves.toBeUndefined();

    expect(logs.warns()).not.toHaveLength(0);
  });

  it("is a no-op with no slots or broker", async () => {
    await expect(
      teardownSandboxes({ slots: createSlotCache(), graceMs: 0 }),
    ).resolves.toBeUndefined();
  });

  /**
   * Flipping `draining` only makes `/health` fail; the proxy stops routing
   * here when it NOTICES. Emptying the slots inside that window turns
   * requests that would have been served into 503s.
   */
  it("waits for the proxy to notice before emptying the slots", async () => {
    const slots = createSlotCache();
    const sandbox = fakeSandbox();
    setSlot(slots, { slug: "a", sandbox });
    const done = teardownSandboxes({ slots, graceMs: 50 });
    // Still serving: the resident is attached and drains have not started.
    expect(slots.get("a")?.sandbox).toBe(sandbox);
    expect(sandbox.drain).not.toHaveBeenCalled();
    await done;
    expect(sandbox.drain).toHaveBeenCalledOnce();
  });
});

describe("shutdownGraceMs", () => {
  it("defaults when unset", () => {
    expect(shutdownGraceMs({})).toBe(SHUTDOWN_GRACE_MS);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "  " })).toBe(SHUTDOWN_GRACE_MS);
  });

  it("honours an explicit value, zero included", () => {
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "250" })).toBe(250);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "0" })).toBe(0);
  });

  // Falling back beats disabling the wait by accident: an unusable value
  // should not silently reintroduce the orphan window.
  it("falls back on an unusable value", () => {
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "soon" })).toBe(SHUTDOWN_GRACE_MS);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "-5" })).toBe(SHUTDOWN_GRACE_MS);
  });
});
