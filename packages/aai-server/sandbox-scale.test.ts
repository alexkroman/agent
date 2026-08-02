// Copyright 2026 the AAI authors. MIT license.
/**
 * Horizontal sandbox scaling (sandbox-scale.ts, routed through
 * resolveSandbox): least-connections across a slug's replicas, scale-out
 * when every resident sandbox is at session capacity, and the per-slug cap.
 * Replica teardown/idle scale-in lives in sandbox-slots.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { resolveSandbox } from "./sandbox-resolve.ts";
import { createSlotCache, terminateSlot } from "./sandbox-slots.ts";
import { createTestStore } from "./test-utils.ts";

// Each createSandboxVm call mints one fake guest whose session count tests
// mutate; `status` RPCs answer from it, mirroring the real harness.
const { mockCreateSandboxVm, guests } = vi.hoisted(() => {
  type FakeGuest = { activeSessions: number; sessionUrl: string; shutdown: () => Promise<void> };
  const guests: FakeGuest[] = [];
  const mockCreateSandboxVm = vi.fn().mockImplementation(() => {
    const guest: FakeGuest = {
      activeSessions: 0,
      sessionUrl: `wss://tunnel-${guests.length}.test:443/websocket`,
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    guests.push(guest);
    return Promise.resolve({
      conn: {
        sendRequest: vi
          .fn()
          .mockImplementation((method: string) =>
            Promise.resolve(
              method === "status" ? { activeSessions: guest.activeSessions } : undefined,
            ),
          ),
        sendNotification: vi.fn(),
        onRequest: vi.fn(),
        onNotification: vi.fn(),
        listen: vi.fn(),
        dispose: vi.fn(),
      },
      sessionUrl: guest.sessionUrl,
      shutdown: guest.shutdown,
      alive: () => true,
      onExit: vi.fn(),
    });
  });
  return { mockCreateSandboxVm, guests };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  createSandboxVm: mockCreateSandboxVm,
}));

const TEST_AGENT_CONFIG: IsolateConfig = {
  name: "test-agent",
  systemPrompt: "You are a test agent",
  greeting: "Hello!",
  maxSteps: 3,
  toolSchemas: [],
  builtinTools: [],
};

async function seedAgent(
  slug: string,
  scale: { maxSessionsPerSandbox: number; maxSandboxes: number },
) {
  const store = createTestStore();
  await store.putAgent({
    slug,
    env: {},
    worker: 'export default { name: "t" };',
    clientFiles: {},
    credential_hashes: ["hash"],
    agentConfig: TEST_AGENT_CONFIG,
  });
  return { slots: createSlotCache(), store, scale };
}

function guest(i: number) {
  const g = guests[i];
  if (!g) throw new Error(`no guest ${i} was spawned`);
  return g;
}

describe("sandbox scale-out routing", () => {
  beforeEach(() => {
    guests.length = 0;
    mockCreateSandboxVm.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays on one sandbox while it has session capacity", async () => {
    const deps = await seedAgent("roomy", { maxSessionsPerSandbox: 3, maxSandboxes: 4 });
    const first = await resolveSandbox("roomy", deps);
    guest(0).activeSessions = 2;
    const second = await resolveSandbox("roomy", deps);
    expect(second).toBe(first);
    expect(mockCreateSandboxVm).toHaveBeenCalledTimes(1);
  });

  it("spawns a replica when the sandbox is at capacity and routes to it", async () => {
    const deps = await seedAgent("full", { maxSessionsPerSandbox: 2, maxSandboxes: 4 });
    const first = await resolveSandbox("full", deps);
    guest(0).activeSessions = 2;
    const second = await resolveSandbox("full", deps);
    expect(second).not.toBe(first);
    expect(mockCreateSandboxVm).toHaveBeenCalledTimes(2);
    // The replica is a distinct guest with its own tunnel.
    await expect(second?.sessionUrl()).resolves.not.toBe(await first?.sessionUrl());
    // The slot tracks it for teardown/eviction.
    expect(deps.slots.get("full")?.replicas).toHaveLength(1);
  });

  it("routes by least connections across replicas", async () => {
    const deps = await seedAgent("balanced", { maxSessionsPerSandbox: 3, maxSandboxes: 4 });
    await resolveSandbox("balanced", deps);
    guest(0).activeSessions = 3;
    const replica = await resolveSandbox("balanced", deps);
    // A session ends on the primary while the replica fills past it:
    // routing must now pick the primary again.
    guest(0).activeSessions = 2;
    guest(1).activeSessions = 3;
    const routed = await resolveSandbox("balanced", deps);
    expect(routed).not.toBe(replica);
    await expect(routed?.sessionUrl()).resolves.toBe(guest(0).sessionUrl);
    expect(mockCreateSandboxVm).toHaveBeenCalledTimes(2);
  });

  it("saturation past the cap routes to the least-loaded instead of spawning", async () => {
    const deps = await seedAgent("capped", { maxSessionsPerSandbox: 1, maxSandboxes: 2 });
    await resolveSandbox("capped", deps);
    guest(0).activeSessions = 1;
    await resolveSandbox("capped", deps); // scales out to the cap
    guest(1).activeSessions = 3;
    const routed = await resolveSandbox("capped", deps); // both full, cap reached
    await expect(routed?.sessionUrl()).resolves.toBe(guest(0).sessionUrl);
    expect(mockCreateSandboxVm).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      "All sandbox replicas at session capacity; routing to least-loaded",
      expect.objectContaining({ slug: "capped", sandboxes: 2 }),
    );
  });

  it("concurrent saturated brokers spawn one replica, not one each", async () => {
    const deps = await seedAgent("stampede", { maxSessionsPerSandbox: 1, maxSandboxes: 4 });
    await resolveSandbox("stampede", deps);
    guest(0).activeSessions = 1;
    const [a, b] = await Promise.all([
      resolveSandbox("stampede", deps),
      resolveSandbox("stampede", deps),
    ]);
    // Both landed on the single freshly spawned replica.
    expect(mockCreateSandboxVm).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);
  });

  it("without a scaling policy a full sandbox keeps serving alone", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "unscaled",
      env: {},
      worker: 'export default { name: "t" };',
      clientFiles: {},
      credential_hashes: ["hash"],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const deps = { slots: createSlotCache(), store };
    const first = await resolveSandbox("unscaled", deps);
    guest(0).activeSessions = 50;
    const second = await resolveSandbox("unscaled", deps);
    expect(second).toBe(first);
    expect(mockCreateSandboxVm).toHaveBeenCalledTimes(1);
  });

  it("terminateSlot tears down replicas along with the primary", async () => {
    const deps = await seedAgent("torn", { maxSessionsPerSandbox: 1, maxSandboxes: 4 });
    await resolveSandbox("torn", deps);
    guest(0).activeSessions = 1;
    await resolveSandbox("torn", deps);
    const slot = deps.slots.get("torn");
    if (!slot) throw new Error("slot missing");
    expect(slot.replicas).toHaveLength(1);
    await terminateSlot(slot);
    expect(guest(0).shutdown).toHaveBeenCalled();
    expect(guest(1).shutdown).toHaveBeenCalled();
    expect(slot.replicas).toBeUndefined();
  });
});
