// Copyright 2025 the AAI authors. MIT license.
/**
 * Slot-cache semantics. Idle reclamation is deliberately NOT here: the
 * GUEST owns idleness (agent-mode self-exit — see aai-guest's
 * harness-agent-mode.test.ts), and its exit reaches the slot through
 * `onSandboxLost` → `terminateSlot` (covered in sandbox.test.ts /
 * sandbox-resolve.test.ts).
 */

import { describe, expect, it, vi } from "vitest";
import {
  type AgentSlot,
  createSlotCache,
  deleteSlot,
  retireSlot,
  setSlot,
  terminateSlot,
} from "./sandbox-slots.ts";

function makeSandbox(overrides: Partial<NonNullable<AgentSlot["sandbox"]>> = {}) {
  return {
    shutdown: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("slot cache", () => {
  it("set/get/delete round-trips slots by slug", () => {
    const cache = createSlotCache();
    const slot: AgentSlot = { slug: "a" };
    setSlot(cache, slot);
    expect(cache.get("a")).toBe(slot);
    expect(deleteSlot(cache, "a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
  });

  it("terminateSlot detaches synchronously and shuts the sandbox down", async () => {
    const sandbox = makeSandbox();
    const slot: AgentSlot = { slug: "t", sandbox };
    const done = terminateSlot(slot);
    // Detached before the await settles: no window where the broker could
    // hand out a sandbox that is being torn down.
    expect(slot.sandbox).toBeUndefined();
    await done;
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("terminateSlot swallows shutdown errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const slot: AgentSlot = {
      slug: "boom",
      sandbox: { shutdown: vi.fn().mockRejectedValue(new Error("boom")) },
    };
    await expect(terminateSlot(slot)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("retireSlot detaches synchronously and hands the sandbox its drain budget", async () => {
    const sandbox = makeSandbox();
    const slot: AgentSlot = { slug: "r", sandbox };
    const delivered = retireSlot(slot, "superseded");
    // Synchronous detach — the drain delivery runs behind it (awaitable for
    // shutdown callers, void-ed on request paths).
    expect(slot.sandbox).toBeUndefined();
    await delivered;
    expect(sandbox.drain).toHaveBeenCalledWith(expect.any(Number));
    // The guest owns the drain: no host-side shutdown for a reachable guest.
    expect(sandbox.shutdown).not.toHaveBeenCalled();
  });

  it("retireSlot on an empty slot is a no-op", async () => {
    const slot: AgentSlot = { slug: "empty" };
    await expect(retireSlot(slot, "superseded")).resolves.toBeUndefined();
  });
});
