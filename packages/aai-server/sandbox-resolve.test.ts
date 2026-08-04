// Copyright 2026 the AAI authors. MIT license.
/**
 * Event-driven sandbox invalidation (see sandbox-resolve.ts +
 * platform-events.ts): the agents row's change stream is THE mover of
 * resident sandboxes — a deploy anywhere (any replica, either service)
 * retires this replica's resident, and a delete terminates it. There is no
 * per-broker version check and no idle-sweep superseded probe; secret
 * changes deliberately do NOT move sandboxes (they apply on the next
 * deploy/rebuild). The vmReady-failure resolution paths are covered in
 * sandbox.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETIRE_POLL_MS } from "./constants.ts";
import { createMemoryPlatformEvents } from "./platform-events.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import type { RpcConnection } from "./rpc-transport.ts";
import type { Sandbox } from "./sandbox.ts";
import { resolveSandbox, watchAgentInvalidation } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestStore } from "./test-utils.ts";

const { mockCreateSandboxVm } = vi.hoisted(() => {
  const mockConn: RpcConnection = {
    sendRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  };
  const mockCreateSandboxVm = vi.fn().mockResolvedValue({
    conn: mockConn,
    sessionUrl: "wss://tunnel.test:443/websocket",
    shutdown: vi.fn().mockResolvedValue(undefined),
    alive: () => true,
    onExit: vi.fn(),
  });
  return { mockCreateSandboxVm };
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

/** Yield until the emitted change event's async handler has settled. */
async function settleEvents(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function seedAgent(slug: string) {
  const memory = createMemoryPlatformEvents();
  const store = createTestStore(undefined, memory);
  const put = (worker: string) =>
    store.putAgent({
      slug,
      env: {},
      worker,
      clientFiles: {},
      credential_hashes: ["hash"],
      agentConfig: TEST_AGENT_CONFIG,
    });
  await put('export default { name: "t" };');
  await settleEvents();
  // Spy that calls through: the watcher's cache drop must actually happen
  // for the rebuild to read the freshly deployed record.
  const invalidate = vi.spyOn(store, "invalidate");
  const deps = { slots: createSlotCache(), store };
  const unwatch = watchAgentInvalidation(memory.events, deps);
  return {
    ...deps,
    invalidate,
    unwatch,
    redeploy: async () => {
      await put('export default { name: "t2" };');
      await settleEvents();
    },
    /** A duplicated/self-echoed change event with no row change behind it. */
    reEmit: async () => {
      memory.emitAgent(slug);
      await settleEvents();
    },
    deleteAgent: async () => {
      await store.deleteAgent(slug);
      await settleEvents();
    },
  };
}

describe("agents-row change stream drives sandbox invalidation", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the resident sandbox while nothing changed", async () => {
    const deps = await seedAgent("stable");
    const first = await resolveSandbox("stable", deps);
    const second = await resolveSandbox("stable", deps);
    expect(second).toBe(first);
    expect(deps.invalidate).not.toHaveBeenCalled();
    await first?.shutdown();
    deps.unwatch();
  });

  it("a deploy's change event retires the resident (drops row caches); the next broker rebuilds", async () => {
    const deps = await seedAgent("redeployed");
    const first = await resolveSandbox("redeployed", deps);
    expect(first).not.toBeNull();

    // A deploy elsewhere upserts the agents row → change event.
    await deps.redeploy();

    // Detached the moment the event was handled — before any re-broker.
    expect(deps.slots.get("redeployed")?.sandbox).toBeUndefined();
    // The rebuild must not read a pre-mutation cached row.
    expect(deps.invalidate).toHaveBeenCalledWith("redeployed");

    const second = await resolveSandbox("redeployed", deps);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // The rebuilt sandbox matches the row's version: its own deploy event
    // (already handled) and further resolves leave it alone.
    await expect(resolveSandbox("redeployed", deps)).resolves.toBe(second);
    await second?.shutdown();
    deps.unwatch();
  });

  it("a duplicated change event does not touch a resident already at the row's version", async () => {
    const deps = await seedAgent("self-echo");
    const sandbox = await resolveSandbox("self-echo", deps);
    expect(sandbox).not.toBeNull();
    // A duplicated (or reordered) event re-reads the version, compares it
    // against the slot's stamp, and leaves the current resident alone.
    await deps.reEmit();
    expect(deps.slots.get("self-echo")?.sandbox).toBe(sandbox);
    await sandbox?.shutdown();
    deps.unwatch();
  });

  it("a delete's change event terminates the resident and drops the slot", async () => {
    const deps = await seedAgent("gone");
    const first = (await resolveSandbox("gone", deps)) as Sandbox;
    expect(first).not.toBeNull();
    const shutdown = vi.spyOn(first, "shutdown");

    await deps.deleteAgent();

    // Terminated (a deleted agent must stop answering), slot dropped, and
    // the next resolve finds no record → 404 upstream.
    expect(shutdown).toHaveBeenCalled();
    expect(deps.slots.get("gone")).toBeUndefined();
    await expect(resolveSandbox("gone", deps)).resolves.toBeNull();
    deps.unwatch();
  });

  it("a secret change does NOT retire the resident sandbox", async () => {
    const deps = await seedAgent("secretly-updated");
    const first = await resolveSandbox("secretly-updated", deps);
    expect(first).not.toBeNull();

    // Secret mutations write Vault, not the agents row: no change event.
    await deps.store.putEnv("secretly-updated", { NEW_KEY: "v" });
    await settleEvents();

    await expect(resolveSandbox("secretly-updated", deps)).resolves.toBe(first);
    await first?.shutdown();
    deps.unwatch();
  });

  it("an unreadable version store never takes down a healthy sandbox", async () => {
    const deps = await seedAgent("db-blip");
    const first = await resolveSandbox("db-blip", deps);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    deps.store.getAgentVersion = () => Promise.reject(new Error("db down"));

    await deps.redeploy();

    // The handler logged and left the resident alone; sessions continue.
    expect(warn).toHaveBeenCalled();
    await expect(resolveSandbox("db-blip", deps)).resolves.toBe(first);
    await first?.shutdown();
    deps.unwatch();
  });

  it("retirement drains live sessions instead of cutting them", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    try {
      const deps = await seedAgent("draining");
      const sandbox = (await resolveSandbox("draining", deps)) as Sandbox;
      let live = 4;
      vi.spyOn(sandbox, "activeSessions").mockImplementation(() => Promise.resolve(live));
      const shutdown = vi.spyOn(sandbox, "shutdown");

      await deps.redeploy();

      // Off the slot immediately — no new session can reach it — but the
      // four calls on it are not hung up on.
      expect(deps.slots.get("draining")?.sandbox).toBeUndefined();
      expect(shutdown).not.toHaveBeenCalled();

      live = 0;
      await vi.advanceTimersByTimeAsync(RETIRE_POLL_MS + 1);
      expect(shutdown).toHaveBeenCalledOnce();
      deps.unwatch();
    } finally {
      vi.useRealTimers();
    }
  });
});
