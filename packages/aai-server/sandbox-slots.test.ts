// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "./metrics.ts";
import {
  type AgentSlot,
  attachSandbox,
  createSlotCache,
  deleteSlot,
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

function gaugeValue(name: string): number {
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  const m = registry.getSingleMetric(name) as any;
  return m?.hashMap?.[""]?.value ?? 0;
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
    setSlot(cache, makeSlot("a"));
    setSlot(cache, makeSlot("b"));
    expect(gaugeValue("aai_slots_registered")).toBe(2);
    deleteSlot(cache, "a");
    expect(gaugeValue("aai_slots_registered")).toBe(1);
  });

  it("publishes aai_slots_resident when a sandbox is attached or detached", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("a");
    setSlot(cache, slot);
    expect(gaugeValue("aai_slots_resident")).toBe(0);
    attachSandbox(cache, slot, makeSandbox());
    expect(gaugeValue("aai_slots_resident")).toBe(1);
    await terminateSlot(slot, cache);
    expect(gaugeValue("aai_slots_resident")).toBe(0);
  });
});
