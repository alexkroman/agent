// Copyright 2025 the AAI authors. MIT license.
/**
 * Slot-cache semantics. Idle reclamation is deliberately NOT here: the
 * GUEST owns idleness (agent-mode self-exit — see aai-guest's
 * harness/agent-mode.test.ts), and its exit reaches the slot through
 * `onSandboxLost` → `terminateSlot` (covered in sandbox.test.ts /
 * sandbox/resolve.test.ts).
 */

import { describe, expect, it, vi } from "vitest";
import { captureLogs } from "../_logger-test-utils.ts";
import {
  attachSandbox,
  claimSlot,
  createSlotCache,
  deleteSlot,
  holdsSandbox,
  retireSlot,
  type SlotSandbox,
  slotSandbox,
  terminateSlot,
} from "./slots.ts";

function makeSandbox(overrides: Partial<SlotSandbox> = {}) {
  return {
    shutdown: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function readySlot(slug: string, sandbox: SlotSandbox, version = 1) {
  const slot = claimSlot(createSlotCache(), slug);
  attachSandbox(slot, sandbox, version);
  return slot;
}

describe("slot cache", () => {
  const logs = captureLogs();
  it("claim/get/delete round-trips slots by slug", () => {
    const cache = createSlotCache();
    const slot = claimSlot(cache, "a");
    expect(slot.state).toEqual({ kind: "empty" });
    expect(cache.get("a")).toBe(slot);
    expect(deleteSlot(cache, "a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
  });

  it("a redeploy replaces the slot under its slug", () => {
    // The case the cache used to be an `OwnedMap` for. Nothing ever used the
    // ownership affordance (`claim`'s release was discarded and `owns()` had no
    // production caller), and the exclusion the call sites really rest on is
    // `withSlugLock` — every write and delete runs inside it. So this is plain
    // `Map` semantics, and pinning them is what says the choice was made.
    const cache = createSlotCache();
    claimSlot(cache, "a");
    const second = claimSlot(cache, "a");
    expect(cache.get("a")).toBe(second);
    expect(cache.size).toBe(1);
  });

  it("attachSandbox makes the slot ready with its deploy version", () => {
    const sandbox = makeSandbox();
    const slot = readySlot("v", sandbox, 7);
    expect(slot.state).toEqual({ kind: "ready", sandbox, version: 7 });
    expect(slotSandbox(slot)).toBe(sandbox);
    expect(holdsSandbox(slot, sandbox)).toBe(true);
    expect(holdsSandbox(slot, makeSandbox())).toBe(false);
    expect(holdsSandbox(undefined, sandbox)).toBe(false);
  });

  it("terminateSlot detaches synchronously and shuts the sandbox down", async () => {
    const sandbox = makeSandbox();
    const slot = readySlot("t", sandbox);
    const done = terminateSlot(slot);
    // Detached before the await settles: no window where the broker could
    // hand out a sandbox that is being torn down.
    expect(slot.state).toEqual({ kind: "empty" });
    await done;
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("terminateSlot swallows shutdown errors", async () => {
    const slot = readySlot("boom", { shutdown: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(terminateSlot(slot)).resolves.toBeUndefined();
    expect(logs.warns()).not.toHaveLength(0);
  });

  it("retireSlot detaches synchronously and hands the sandbox its drain budget", async () => {
    const sandbox = makeSandbox();
    const slot = readySlot("r", sandbox);
    const delivered = retireSlot(slot, "superseded");
    // Synchronous detach — the drain delivery runs behind it (awaitable for
    // shutdown callers, void-ed on request paths).
    expect(slotSandbox(slot)).toBeUndefined();
    await delivered;
    expect(sandbox.drain).toHaveBeenCalledWith(expect.any(Number));
    // The guest owns the drain: no host-side shutdown for a reachable guest.
    expect(sandbox.shutdown).not.toHaveBeenCalled();
  });

  it("retireSlot on an empty slot is a no-op", async () => {
    const slot = claimSlot(createSlotCache(), "empty");
    await expect(retireSlot(slot, "superseded")).resolves.toBeUndefined();
    expect(slot.state).toEqual({ kind: "empty" });
  });
});
