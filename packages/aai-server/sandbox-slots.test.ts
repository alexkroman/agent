// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_SANDBOX_MS } from "./constants.ts";
import { registry } from "./metrics.ts";
import {
  type AgentSlot,
  acquireSlotSession,
  attachSandbox,
  createSlotCache,
  deleteSlot,
  registerSlotsForGauges,
  releaseSlotSession,
  setSlot,
  terminateSlot,
} from "./sandbox-slots.ts";
import { counterValue, gaugeValue } from "./test-utils.ts";

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

describe("slot-cache gauges", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });
  afterEach(() => {
    registry.resetMetrics();
  });

  it("publishes aai_slots_registered when a slot is added or removed", () => {
    const cache = createSlotCache();
    registerSlotsForGauges(cache);
    setSlot(cache, makeSlot("a"));
    setSlot(cache, makeSlot("b"));
    expect(gaugeValue("aai_slots_registered")).toBe(2);
    deleteSlot(cache, "a");
    expect(gaugeValue("aai_slots_registered")).toBe(1);
  });

  it("publishes aai_slots_resident when a sandbox is attached or detached", async () => {
    const cache = createSlotCache();
    registerSlotsForGauges(cache);
    const slot = makeSlot("a");
    setSlot(cache, slot);
    expect(gaugeValue("aai_slots_resident")).toBe(0);
    attachSandbox(cache, slot, makeSandbox());
    expect(gaugeValue("aai_slots_resident")).toBe(1);
    await terminateSlot(slot);
    expect(gaugeValue("aai_slots_resident")).toBe(0);
  });
});

describe("idle sandbox eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registry.resetMetrics();
  });
  afterEach(() => {
    vi.useRealTimers();
    registry.resetMetrics();
  });

  it("evicts a sandbox after IDLE_SANDBOX_MS with no touches", async () => {
    const cache = createSlotCache();
    registerSlotsForGauges(cache);
    const slot = makeSlot("alpha");
    setSlot(cache, slot);
    const sandbox = makeSandbox();
    attachSandbox(cache, slot, sandbox);

    expect(gaugeValue("aai_slots_resident")).toBe(1);

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(cache.get("alpha")?.sandbox).toBeUndefined();
    // Slot itself stays registered — only the sandbox is evicted.
    expect(cache.has("alpha")).toBe(true);
    expect(gaugeValue("aai_slots_resident")).toBe(0);
    expect(gaugeValue("aai_slots_registered")).toBe(1);
    expect(counterValue("aai_sandbox_evicted_total", { reason: "idle" })).toBe(1);
  });

  it("does not evict a sandbox with an active session, and evicts after release", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("busy");
    setSlot(cache, slot);
    const sandbox = makeSandbox();
    attachSandbox(cache, slot, sandbox);

    // A live session pauses idle eviction indefinitely.
    acquireSlotSession(cache, "busy");
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS * 3);
    expect(sandbox.shutdown).not.toHaveBeenCalled();

    // Releasing the last session rearms the timer.
    releaseSlotSession(cache, "busy");
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
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
    // No "idle" eviction either — terminate doesn't increment that counter.
    expect(counterValue("aai_sandbox_evicted_total", { reason: "idle" })).toBe(0);
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
