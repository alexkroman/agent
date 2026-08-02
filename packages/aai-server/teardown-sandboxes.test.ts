// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import { teardownSandboxes } from "./teardown-sandboxes.ts";

const fakeSandbox = () => ({ shutdown: vi.fn().mockResolvedValue(undefined) });

describe("teardownSandboxes", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("shuts down every slot's primary sandbox", async () => {
    const slots = createSlotCache();
    const a = fakeSandbox();
    const b = fakeSandbox();
    setSlot(slots, { slug: "a", sandbox: a });
    setSlot(slots, { slug: "b", sandbox: b });

    await teardownSandboxes({ slots });

    expect(a.shutdown).toHaveBeenCalledOnce();
    expect(b.shutdown).toHaveBeenCalledOnce();
  });

  // The leak this closes: both entries called `slot.sandbox?.shutdown()`,
  // which skips overflow replicas entirely — terminateSlot already handles
  // both, and these paths re-implemented a subset of it.
  it("shuts down overflow replicas alongside the primary", async () => {
    const slots = createSlotCache();
    const primary = fakeSandbox();
    const replica = fakeSandbox();
    setSlot(slots, { slug: "scaled", sandbox: primary, replicas: [replica] });

    await teardownSandboxes({ slots });

    expect(primary.shutdown).toHaveBeenCalledOnce();
    expect(replica.shutdown).toHaveBeenCalledOnce();
  });

  it("shuts down the warm pool", async () => {
    const pool = { shutdown: vi.fn().mockResolvedValue(undefined) };

    await teardownSandboxes({ slots: createSlotCache(), pool });

    expect(pool.shutdown).toHaveBeenCalledOnce();
  });

  // The studio broker's own per-project sandboxes: dispose() existed and was
  // documented for shutdown, but had no production call site, so every
  // restart orphaned one guest per active project.
  it("disposes the studio session broker", async () => {
    const broker = { dispose: vi.fn().mockResolvedValue(undefined) };

    await teardownSandboxes({ slots: createSlotCache(), broker });

    expect(broker.dispose).toHaveBeenCalledOnce();
  });

  it("tears everything else down even when one sandbox rejects", async () => {
    const slots = createSlotCache();
    const bad = { shutdown: vi.fn().mockRejectedValue(new Error("already gone")) };
    const good = fakeSandbox();
    setSlot(slots, { slug: "bad", sandbox: bad });
    setSlot(slots, { slug: "good", sandbox: good });
    const pool = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const broker = { dispose: vi.fn().mockResolvedValue(undefined) };

    await expect(teardownSandboxes({ slots, pool, broker })).resolves.toBeUndefined();

    expect(good.shutdown).toHaveBeenCalledOnce();
    expect(pool.shutdown).toHaveBeenCalledOnce();
    expect(broker.dispose).toHaveBeenCalledOnce();
  });

  it("warns rather than throwing when the broker dispose rejects", async () => {
    const broker = { dispose: vi.fn().mockRejectedValue(new Error("broker boom")) };

    await expect(teardownSandboxes({ slots: createSlotCache(), broker })).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalled();
  });

  it("is a no-op with no slots, pool, or broker", async () => {
    await expect(teardownSandboxes({ slots: createSlotCache() })).resolves.toBeUndefined();
  });
});
