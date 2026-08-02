// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_SANDBOX_MS, RETIRE_POLL_MS } from "./constants.ts";
import {
  type AgentSlot,
  attachSandbox,
  createSlotCache,
  deleteSlot,
  setSlot,
  terminateSlot,
} from "./sandbox-slots.ts";

function makeSandbox(activeSessions?: () => Promise<number>) {
  return {
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...(activeSessions && { activeSessions }),
  };
}

function makeSlot(slug: string, overrides?: Partial<AgentSlot>): AgentSlot {
  return {
    slug,
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
    cache.claim("my-agent", slot);
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
    // `performance` too — retirement's drain deadline is measured with
    // performance.now(), which vitest leaves real by default.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("probes the guest and rearms instead of evicting while sessions are live", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("busy");
    setSlot(cache, slot);
    // Sessions connect directly to the sandbox tunnel, so the host asks the
    // guest: two probe rounds report a live session, the third reports idle.
    const probe = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    const sandbox = makeSandbox(probe);
    attachSandbox(cache, slot, sandbox);

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).not.toHaveBeenCalled();

    // Third window: the guest reports no live sessions — evict.
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("evicts when the probe rejects (dead guest)", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("dead");
    setSlot(cache, slot);
    const sandbox = makeSandbox(() => Promise.reject(new Error("guest gone")));
    attachSandbox(cache, slot, sandbox);

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("does not evict a replacement sandbox installed while the probe was in flight", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("raced");
    setSlot(cache, slot);
    const gate = Promise.withResolvers<number>();
    const sandbox = makeSandbox(() => gate.promise);
    attachSandbox(cache, slot, sandbox);

    // Fire the idle timer; the probe is now awaiting the gate.
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    // A redeploy replaces the slot object under the same slug mid-probe.
    await terminateSlot(slot);
    const newSlot = makeSlot("raced");
    setSlot(cache, newSlot);
    const newSandbox = makeSandbox();
    attachSandbox(cache, newSlot, newSandbox);

    // The stale probe settles "idle" — but its slot is no longer current.
    gate.resolve(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(newSandbox.shutdown).not.toHaveBeenCalled();
    expect(cache.get("raced")?.sandbox).toBe(newSandbox);
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

  it("scales in idle replicas while the primary stays busy", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("scaled");
    setSlot(cache, slot);
    const sandbox = makeSandbox(() => Promise.resolve(2));
    attachSandbox(cache, slot, sandbox);
    const busyReplica = makeSandbox(() => Promise.resolve(1));
    const idleReplica = makeSandbox(() => Promise.resolve(0));
    slot.replicas = [busyReplica, idleReplica];

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    // Only the idle replica was reclaimed; the timer re-armed.
    expect(idleReplica.shutdown).toHaveBeenCalledOnce();
    expect(busyReplica.shutdown).not.toHaveBeenCalled();
    expect(sandbox.shutdown).not.toHaveBeenCalled();
    expect(slot.replicas).toEqual([busyReplica]);
    expect(slot.idleTimer).toBeDefined();
  });

  it("keeps an idle primary alive while a replica still has sessions", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("tail");
    setSlot(cache, slot);
    const sandbox = makeSandbox(() => Promise.resolve(0));
    attachSandbox(cache, slot, sandbox);
    const busyReplica = makeSandbox(() => Promise.resolve(1));
    slot.replicas = [busyReplica];

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    // The primary is the slot's routing anchor — evicting it while a
    // replica holds sessions would force a full rebuild on the next broker
    // request. Everything is reclaimed once all counts reach zero.
    expect(sandbox.shutdown).not.toHaveBeenCalled();
    expect(busyReplica.shutdown).not.toHaveBeenCalled();

    slot.replicas = [makeSandbox(() => Promise.resolve(0))];
    const lastReplica = slot.replicas[0];
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(lastReplica?.shutdown).toHaveBeenCalledOnce();
    expect(slot.replicas).toBeUndefined();
    expect(cache.get("tail")?.sandbox).toBeUndefined();
  });

  it("retires a superseded sandbox regardless of live sessions, without cutting them", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("superseded");
    setSlot(cache, slot);
    // Busy: the plain idle probe would re-arm the timer forever, so the
    // sweep must not gate on this count — but it must not cut the calls
    // either.
    let live = 3;
    const sandbox = makeSandbox(() => Promise.resolve(live));
    const replica = makeSandbox(() => Promise.resolve(live));
    attachSandbox(cache, slot, sandbox, () => Promise.resolve(true));
    slot.replicas = [replica];

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    // Detached at once — no NEW session can be brokered onto it...
    expect(cache.get("superseded")?.sandbox).toBeUndefined();
    expect(cache.get("superseded")?.replicas).toBeUndefined();
    // ...while the calls already on it keep running.
    expect(sandbox.shutdown).not.toHaveBeenCalled();
    expect(replica.shutdown).not.toHaveBeenCalled();

    live = 0;
    await vi.advanceTimersByTimeAsync(RETIRE_POLL_MS + 1);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(replica.shutdown).toHaveBeenCalledOnce();
  });

  it("rearms normally when the staleness check says the resident is current", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("current");
    setSlot(cache, slot);
    const sandbox = makeSandbox(() => Promise.resolve(1));
    attachSandbox(cache, slot, sandbox, () => Promise.resolve(false));

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    expect(sandbox.shutdown).not.toHaveBeenCalled();
    expect(slot.idleTimer).toBeDefined();
  });

  it("does not retire a replacement installed while the staleness check was in flight", async () => {
    const cache = createSlotCache();
    const slot = makeSlot("raced-stale");
    setSlot(cache, slot);
    const gate = Promise.withResolvers<boolean>();
    const sandbox = makeSandbox(() => Promise.resolve(0));
    attachSandbox(cache, slot, sandbox, () => gate.promise);

    // Fire the idle timer; the staleness check is now awaiting the gate.
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    // A redeploy replaces the slot object under the same slug mid-check.
    await terminateSlot(slot);
    const newSlot = makeSlot("raced-stale");
    setSlot(cache, newSlot);
    const newSandbox = makeSandbox(() => Promise.resolve(0));
    attachSandbox(cache, newSlot, newSandbox, () => Promise.resolve(false));

    gate.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(newSandbox.shutdown).not.toHaveBeenCalled();
    expect(cache.get("raced-stale")?.sandbox).toBe(newSandbox);
  });

  it("terminateSlot shuts down replicas along with the primary", async () => {
    const sandbox = makeSandbox();
    const replica = makeSandbox();
    const slot = makeSlot("multi", { sandbox, replicas: [replica] });
    await terminateSlot(slot);
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(replica.shutdown).toHaveBeenCalledOnce();
    expect(slot.sandbox).toBeUndefined();
    expect(slot.replicas).toBeUndefined();
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
