// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import { liveGuestSessions, teardownSandboxes } from "./teardown-sandboxes.ts";

const fakeSandbox = () => ({ shutdown: vi.fn().mockResolvedValue(undefined) });

const countingSandbox = (n: number | (() => number)) => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
  activeSessions: vi.fn(() => Promise.resolve(typeof n === "function" ? n() : n)),
});

/**
 * The shutdown drain's input. `wss.clients.size` cannot see a browser voice
 * session — it dials the guest tunnel directly — so this is the only honest
 * count, and getting it wrong means every scale-in cuts live calls while
 * reporting a clean drain.
 */
describe("liveGuestSessions", () => {
  it("sums the resident sandboxes across every slot", async () => {
    const slots = createSlotCache();
    setSlot(slots, { slug: "a", sandbox: countingSandbox(3) });
    setSlot(slots, { slug: "b", sandbox: countingSandbox(1) });

    await expect(liveGuestSessions(slots)).resolves.toBe(4);
  });

  it("counts an unreachable guest as idle rather than stalling shutdown", async () => {
    const slots = createSlotCache();
    setSlot(slots, {
      slug: "dead",
      sandbox: {
        shutdown: vi.fn().mockResolvedValue(undefined),
        activeSessions: () => Promise.reject(new Error("guest gone")),
      },
    });
    setSlot(slots, { slug: "alive", sandbox: countingSandbox(2) });

    await expect(liveGuestSessions(slots)).resolves.toBe(2);
  });

  it("is zero with no sandboxes", async () => {
    await expect(liveGuestSessions(createSlotCache())).resolves.toBe(0);
  });
});

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
    const broker = { dispose: vi.fn().mockResolvedValue(undefined) };

    await expect(teardownSandboxes({ slots, broker })).resolves.toBeUndefined();

    expect(good.shutdown).toHaveBeenCalledOnce();
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
