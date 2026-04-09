// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VMS } from "./constants.ts";
import { type AgentEntry, createAgentMap, isAtCapacity } from "./sandbox-slots.ts";

function makeSandbox() {
  return { shutdown: vi.fn().mockResolvedValue(undefined) };
}

function makeEntry(slug: string, overrides?: Partial<AgentEntry>): AgentEntry {
  return {
    slug,
    sandbox: makeSandbox(),
    sessions: new Set(),
    idleTimer: null,
    ...overrides,
  };
}

describe("createAgentMap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers and retrieves an agent entry", () => {
    const agents = createAgentMap();
    const entry = makeEntry("my-agent");
    agents.set("my-agent", entry);
    expect(agents.get("my-agent")).toBe(entry);
  });

  it("idle timer fires: shutdown called and entry removed", async () => {
    const agents = createAgentMap();
    const entry = makeEntry("idle-agent");
    agents.set("idle-agent", entry);

    agents.startIdleTimer("idle-agent");
    expect(agents.has("idle-agent")).toBe(true);

    vi.advanceTimersByTime(30_000);

    expect(agents.has("idle-agent")).toBe(false);
    // Allow the microtask queue to flush for the shutdown promise
    await Promise.resolve();
    expect(entry.sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("idle timer cancelled: shutdown NOT called", () => {
    const agents = createAgentMap();
    const entry = makeEntry("cancel-agent");
    agents.set("cancel-agent", entry);

    agents.startIdleTimer("cancel-agent");
    agents.cancelIdleTimer("cancel-agent");

    vi.advanceTimersByTime(30_000);

    // Entry still present (we didn't remove it manually)
    expect(agents.has("cancel-agent")).toBe(true);
    expect(entry.sandbox.shutdown).not.toHaveBeenCalled();
    expect(entry.idleTimer).toBeNull();
  });

  it("startIdleTimer replaces an existing timer", async () => {
    const agents = createAgentMap();
    const entry = makeEntry("reset-agent");
    agents.set("reset-agent", entry);

    // Start timer, advance partway, reset it
    agents.startIdleTimer("reset-agent");
    vi.advanceTimersByTime(15_000);

    agents.startIdleTimer("reset-agent");
    vi.advanceTimersByTime(15_000);

    // Only 15s into the reset timer — should NOT have fired yet
    expect(agents.has("reset-agent")).toBe(true);
    expect(entry.sandbox.shutdown).not.toHaveBeenCalled();

    // Advance the remaining 15s
    vi.advanceTimersByTime(15_000);
    expect(agents.has("reset-agent")).toBe(false);
    await Promise.resolve();
    expect(entry.sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("startIdleTimer is a no-op for unknown slug", () => {
    const agents = createAgentMap();
    // Should not throw
    expect(() => agents.startIdleTimer("ghost")).not.toThrow();
  });

  it("cancelIdleTimer is a no-op for unknown slug", () => {
    const agents = createAgentMap();
    expect(() => agents.cancelIdleTimer("ghost")).not.toThrow();
  });
});

describe("isAtCapacity", () => {
  it("returns false when map is empty", () => {
    const agents = createAgentMap();
    expect(isAtCapacity(agents)).toBe(false);
  });

  it("returns false when map is one below the cap", () => {
    const agents = createAgentMap();
    for (let i = 0; i < MAX_VMS - 1; i++) {
      agents.set(`agent-${i}`, makeEntry(`agent-${i}`));
    }
    expect(isAtCapacity(agents)).toBe(false);
  });

  it("returns true when map is exactly at MAX_VMS", () => {
    const agents = createAgentMap();
    for (let i = 0; i < MAX_VMS; i++) {
      agents.set(`agent-${i}`, makeEntry(`agent-${i}`));
    }
    expect(isAtCapacity(agents)).toBe(true);
  });

  it("returns true when map exceeds MAX_VMS", () => {
    const agents = createAgentMap();
    for (let i = 0; i < MAX_VMS + 5; i++) {
      agents.set(`agent-${i}`, makeEntry(`agent-${i}`));
    }
    expect(isAtCapacity(agents)).toBe(true);
  });
});
