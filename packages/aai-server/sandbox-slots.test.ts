// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_SANDBOX_MS } from "./constants.ts";
import {
  type AgentSlot,
  acquireSlotSession,
  attachSandbox,
  createSlotCache,
  deleteSlot,
  releaseSlotSession,
  setSlot,
  terminateSlot,
} from "./sandbox-slots.ts";

function makeSandbox() {
  return { shutdown: vi.fn().mockResolvedValue(undefined) };
}

function makeSlot(slug: string, overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    slug,
    keyHash: `hash-${slug}`,
    ...overrides,
  };
}

describe("createSlotCache", () => {
  it("creates an empty Map", () => {
    const cache = createSlotCache();
    expect(cache.size).toBe(0);
  });

  it("stores and retrieves a slot", () => {
    const cache = createSlotCache();
    const slot = makeSlot("my-agent");
    cache.set("my-agent", slot);
    expect(cache.get("my-agent")).toBe(slot);
  });
});

describe("terminateSlot", () => {
  it("calls shutdown on the sandbox and clears it", async () => {
    const sandbox = makeSandbox();
    const slot = makeSlot("agent-a", { sandbox });
    await terminateSlot(slot);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(slot.sandbox).toBeUndefined();
  });

  it("is a no-op when slot has no sandbox", async () => {
    const slot = makeSlot("agent-b");
    await expect(terminateSlot(slot)).resolves.toBeUndefined();
  });

  it("swallows shutdown errors and logs a warning", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sandbox = { shutdown: vi.fn().mockRejectedValue(new Error("boom")) };
    const slot = makeSlot("agent-c", { sandbox });
    await expect(terminateSlot(slot)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith("Failed to shut down sandbox", expect.any(Object));
    consoleSpy.mockRestore();
  });
});

describe("idle sandbox eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts a sandbox after IDLE_SANDBOX_MS with no touches", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("alpha");
    setSlot(cache, slot);
    const sandbox = makeSandbox();
    attachSandbox(cache, slot, sandbox);

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(cache.get("alpha")?.sandbox).toBeUndefined();
    // Slot itself stays registered — only the sandbox is evicted.
    expect(cache.has("alpha")).toBe(true);
  });

  it("does not evict a sandbox with an active session, and evicts after release", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("busy");
    setSlot(cache, slot);
    const sandbox = makeSandbox();
    attachSandbox(cache, slot, sandbox);

    // A live session pauses idle eviction indefinitely.
    const acquired = acquireSlotSession(cache, "busy");
    expect(acquired).toBe(slot);
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS * 3);
    expect(sandbox.shutdown).not.toHaveBeenCalled();

    // Releasing the last session rearms the timer.
    releaseSlotSession(cache, acquired);
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("a stale release from before a redeploy cannot idle-evict the new sandbox", async () => {
    const cache = createSlotCache();
    const oldSlot = makeSlot("agent");
    setSlot(cache, oldSlot);
    attachSandbox(cache, oldSlot, makeSandbox());

    // Session O goes live on the old slot.
    const handleO = acquireSlotSession(cache, "agent");

    // Redeploy: old slot terminated, replaced by a fresh slot object
    // (deploy.ts resets the counter), new sandbox attached.
    await terminateSlot(oldSlot);
    const newSlot = makeSlot("agent");
    setSlot(cache, newSlot);
    const newSandbox = makeSandbox();
    attachSandbox(cache, newSlot, newSandbox);

    // Session N goes live on the new slot.
    const handleN = acquireSlotSession(cache, "agent");
    expect(handleN).toBe(newSlot);

    // O's socket finally closes. Its release targets the OLD slot only — it
    // must not decrement the new slot's counter or rearm its idle timer.
    releaseSlotSession(cache, handleO);
    expect(newSlot.activeSessions).toBe(1);
    expect(newSlot.idleTimer).toBeUndefined();

    // N stays alive well past the idle window.
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS * 3);
    expect(newSandbox.shutdown).not.toHaveBeenCalled();

    // Releasing N (the real last session) rearms eviction as usual.
    releaseSlotSession(cache, handleN);
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(newSandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("acquire returns null and release tolerates it for an unknown slug", () => {
    const cache = createSlotCache();
    const acquired = acquireSlotSession(cache, "missing");
    expect(acquired).toBeNull();
    expect(() => releaseSlotSession(cache, acquired)).not.toThrow();
  });

  it("terminateSlot clears the idle timer to avoid leaks", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("delta");
    setSlot(cache, slot);
    const sandbox = makeSandbox();
    attachSandbox(cache, slot, sandbox);
    expect(slot.idleTimer).toBeDefined();

    await terminateSlot(slot);
    expect(slot.idleTimer).toBeUndefined();
    expect(sandbox.shutdown).toHaveBeenCalledOnce();

    // Advancing time must not trigger another shutdown — terminate
    // already happened and the timer should have been cleared.
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("deleteSlot clears the idle timer to avoid leaks", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("epsilon");
    setSlot(cache, slot);
    const sandbox = makeSandbox();
    attachSandbox(cache, slot, sandbox);
    expect(slot.idleTimer).toBeDefined();

    deleteSlot(cache, "epsilon");
    expect(slot.idleTimer).toBeUndefined();

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).not.toHaveBeenCalled();
  });

  it("swallows shutdown errors during idle eviction", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = createSlotCache();
    const slot = makeSlot("zeta");
    setSlot(cache, slot);
    const sandbox = { shutdown: vi.fn().mockRejectedValue(new Error("boom")) };
    attachSandbox(cache, slot, sandbox);

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    // Let the rejected shutdown promise settle.
    await vi.runAllTimersAsync();

    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(cache.get("zeta")?.sandbox).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith("Failed to shut down idle sandbox", expect.any(Object));
    consoleSpy.mockRestore();
  });
});
