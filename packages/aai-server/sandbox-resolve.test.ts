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
import { createMemoryPlatformEvents } from "./platform-events.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import type { Sandbox } from "./sandbox.ts";
import { createMemorySandboxRegistry } from "./sandbox-registry.ts";
import { brokerSessionUrl, resolveSandbox, watchAgentInvalidation } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { appDbSecretName, createMemorySecretStore } from "./secret-store.ts";
import { createTestStore } from "./test-utils.ts";

const { mockSpawnAgentServer } = vi.hoisted(() => {
  const mockSpawnAgentServer = vi.fn().mockResolvedValue({
    sessionUrl: "wss://tunnel.test:443/websocket",
    activeSessions: vi.fn().mockResolvedValue(0),
    drain: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    alive: () => true,
    onExit: vi.fn(),
  });
  return { mockSpawnAgentServer };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  spawnAgentServer: mockSpawnAgentServer,
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
    // The cold rebuild itself reads fresh (one invalidate); a warm resident
    // costs nothing more.
    deps.invalidate.mockClear();
    const second = await resolveSandbox("stable", deps);
    expect(second).toBe(first);
    expect(deps.invalidate).not.toHaveBeenCalled();
    await first?.shutdown();
    deps.unwatch();
  });

  it("a deploy's change event hands over BLUE-GREEN: the replacement is attached before the old resident detaches", async () => {
    const deps = await seedAgent("redeployed");
    const first = await resolveSandbox("redeployed", deps);
    expect(first).not.toBeNull();

    // A deploy elsewhere upserts the agents row → change event. The handler
    // boots the NEW deploy's sandbox, waits for its readiness, and swaps —
    // the slot is never empty, so the next caller pays no cold start.
    await deps.redeploy();

    const replacement = deps.slots.get("redeployed")?.sandbox;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(first);
    // The rebuild read a fresh row, not a pre-mutation cached one.
    expect(deps.invalidate).toHaveBeenCalledWith("redeployed");

    // The broker serves the ready replacement as-is — no rebuild, and its
    // own deploy event (already handled) leaves it alone.
    await expect(resolveSandbox("redeployed", deps)).resolves.toBe(replacement);
    await (replacement as Sandbox).shutdown();
    deps.unwatch();
  });

  it("a replacement that fails to boot retires the old resident — the failure stays visible", async () => {
    const deps = await seedAgent("bad-redeploy");
    const first = await resolveSandbox("bad-redeploy", deps);
    expect(first).not.toBeNull();

    // The NEW deploy crashes on boot. Blue-green must not cut over to a
    // corpse, and must not keep serving superseded code silently either:
    // the old resident retires and the slot empties, so the next broker
    // call rebuilds and surfaces the boot failure.
    mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("boot crash")));
    await deps.redeploy();

    await vi.waitFor(() => {
      expect(deps.slots.get("bad-redeploy")?.sandbox).toBeUndefined();
    });
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

  it("a deploy landing mid-rebuild is not dropped: the event queues on the slug lock and retires the stale build", async () => {
    const deps = await seedAgent("mid-rebuild");
    // Park the rebuild between its record read and the sandbox attach.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGetWorkerCode = deps.store.getWorkerCode.bind(deps.store);
    deps.store.getWorkerCode = async (slug) => {
      await gate;
      return realGetWorkerCode(slug);
    };

    const resolving = resolveSandbox("mid-rebuild", deps);
    await settleEvents();
    // The slot is claimed before any read, so the event pre-filter sees it
    // even though no sandbox is attached yet.
    expect(deps.slots.get("mid-rebuild")).toBeDefined();
    expect(deps.slots.get("mid-rebuild")?.sandbox).toBeUndefined();

    // A deploy elsewhere commits while the rebuild is in flight. Its change
    // event queues behind the rebuild's slug lock instead of being skipped.
    await deps.redeploy();
    release();
    const stale = await resolving;
    expect(stale).not.toBeNull();

    // The queued handler ran after the attach: version mismatch → blue-green
    // handover to a replacement at the row's current version.
    await vi.waitFor(() => {
      const current = deps.slots.get("mid-rebuild")?.sandbox;
      expect(current).toBeDefined();
      expect(current).not.toBe(stale);
    });
    const fresh = deps.slots.get("mid-rebuild")?.sandbox;
    await expect(resolveSandbox("mid-rebuild", deps)).resolves.toBe(fresh);
    await (fresh as Sandbox).shutdown();
    deps.unwatch();
  });

  it("a failed rebuild of an unknown slug leaves no empty slot behind", async () => {
    const deps = await seedAgent("known");
    await expect(resolveSandbox("never-deployed", deps)).resolves.toBeNull();
    expect(deps.slots.get("never-deployed")).toBeUndefined();
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

  it("retirement hands the old sandbox its drain budget instead of cutting it", async () => {
    const deps = await seedAgent("draining");
    const sandbox = (await resolveSandbox("draining", deps)) as Sandbox;
    const drain = vi.spyOn(sandbox, "drain");
    const shutdown = vi.spyOn(sandbox, "shutdown");

    await deps.redeploy();

    // Handed over: the slot holds the READY replacement (no new session
    // can reach the old sandbox), and the old one was told to drain — the
    // GUEST finishes its calls and exits itself; the host never hangs up.
    expect(deps.slots.get("draining")?.sandbox).toBeDefined();
    expect(deps.slots.get("draining")?.sandbox).not.toBe(sandbox);
    await vi.waitFor(() => {
      expect(drain).toHaveBeenCalledWith(expect.any(Number));
    });
    expect(shutdown).not.toHaveBeenCalled();
    deps.unwatch();
  });
});

describe("storage (ctx.db) delivery", () => {
  it("injects the app's own DATABASE_URL into the bundle/load env when storage is enabled", async () => {
    const secrets = createMemorySecretStore();
    await secrets.put(
      appDbSecretName("stored-app"),
      JSON.stringify({ role: "app_0123456789abcdef", password: "p".repeat(32) }),
    );
    const store = createTestStore(secrets);
    await store.putAgent({
      slug: "stored-app",
      env: { OTHER: "x" },
      worker: 'export default { name: "t" };',
      clientFiles: {},
      credential_hashes: ["hash"],
      agentConfig: TEST_AGENT_CONFIG,
    });
    const appDb = {
      provision: () => Promise.reject(new Error("not expected")),
      deprovision: () => Promise.reject(new Error("not expected")),
      connectionUrl: vi.fn(() => "postgres://app_0123456789abcdef:pw@db.example:6543/postgres"),
    };
    mockSpawnAgentServer.mockClear();

    const sandbox = await resolveSandbox("stored-app", {
      slots: createSlotCache(),
      store,
      secrets,
      appDb,
    });
    expect(sandbox).not.toBeNull();

    // The guest connects to its OWN scoped database directly — the app-db
    // credential rides in the env, and no db handle stays host-side.
    const vmOpts = mockSpawnAgentServer.mock.calls[0]?.[0] as {
      env: Record<string, string>;
    };
    expect(vmOpts.env).toEqual({
      OTHER: "x",
      DATABASE_URL: "postgres://app_0123456789abcdef:pw@db.example:6543/postgres",
    });
    await sandbox?.shutdown();
  });

  it("leaves the env untouched when storage is not enabled", async () => {
    const deps = await seedAgent("no-storage");
    mockSpawnAgentServer.mockClear();
    const sandbox = await resolveSandbox("no-storage", deps);
    const vmOpts = mockSpawnAgentServer.mock.calls[0]?.[0] as {
      env: Record<string, string>;
    };
    expect(vmOpts.env).toEqual({});
    await sandbox?.shutdown();
    deps.unwatch();
  });
});

/**
 * A boot that never finishes must not hold the CLIENT for the guest's full
 * boot budget (`AGENT_HEALTH_TIMEOUT_MS`, 120s): an agent whose top-level
 * code blocks never becomes ready, so every broker call hung two minutes
 * before its 503 — permanently, for every caller.
 */
describe("broker readiness cap", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockSpawnAgentServer.mockReset();
  });

  it("answers 503 while a boot is still running, without spawning a second sandbox", async () => {
    // A spawn that never resolves — the hung-boot case.
    let releaseBoot: ((handle: unknown) => void) | undefined;
    mockSpawnAgentServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseBoot = resolve;
        }),
    );
    const seeded = await seedAgent("hung");
    // Short cap so the test observes it without spending the real budget.
    const deps = { ...seeded, readyTimeoutMs: 50 };
    try {
      const first = await brokerSessionUrl("hung", deps);
      expect(first).toMatchObject({ ok: false, status: 503 });

      // The sandbox stayed attached and is still booting.
      expect(deps.slots.get("hung")?.sandbox?.alive?.()).toBe(true);

      // Count from HERE: a cold rebuild may legitimately spawn twice when a
      // change event lands between slot creation and its version stamp (the
      // "one extra rebuild" race rebuildSlot documents), and a boot slow
      // enough to time out widens that window. What this pins is the new
      // behavior — a broker that stopped waiting must JOIN the running boot,
      // never start another one.
      const afterFirst = mockSpawnAgentServer.mock.calls.length;
      const second = await brokerSessionUrl("hung", deps);
      expect(second).toMatchObject({ ok: false, status: 503 });
      expect(mockSpawnAgentServer.mock.calls.length).toBe(afterFirst);

      // And when the boot finally lands, the next call serves it.
      releaseBoot?.({
        sessionUrl: "wss://tunnel.test:443/websocket",
        guestOrigin: "wss://tunnel.test:443",
        activeSessions: vi.fn().mockResolvedValue(0),
        drain: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        alive: () => true,
        onExit: vi.fn(),
      });
      await expect(brokerSessionUrl("hung", deps)).resolves.toMatchObject({
        ok: true,
        sessionUrl: "wss://tunnel.test:443/websocket",
      });
      expect(mockSpawnAgentServer.mock.calls.length).toBe(afterFirst);
    } finally {
      seeded.unwatch();
    }
  });
});

describe("cross-replica registry keeps one sandbox per slug fleet-wide", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Earlier suites `restoreAllMocks`, which strips the hoisted default.
    mockSpawnAgentServer.mockReset().mockResolvedValue({
      sessionUrl: "wss://tunnel.test:443/websocket",
      guestOrigin: "wss://tunnel.test:443",
      activeSessions: vi.fn().mockResolvedValue(0),
      drain: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      alive: () => true,
      onExit: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a cold broker to a live peer instead of spawning a duplicate", async () => {
    // The reported bug: two replicas serving one slug each spawned a guest,
    // because the slot cache is per-replica and Modal load-balances every
    // request independently.
    const seeded = await seedAgent("shared");
    const registry = createMemorySandboxRegistry("replica-b");
    registry.registerPeer("shared", {
      sessionUrl: "wss://peer.test:443/websocket",
      guestOrigin: "wss://peer.test:443",
    });
    try {
      const brokered = await brokerSessionUrl("shared", { ...seeded, registry });
      expect(brokered).toEqual({
        ok: true,
        sessionUrl: "wss://peer.test:443/websocket",
        guestOrigin: "wss://peer.test:443",
      });
      expect(mockSpawnAgentServer).not.toHaveBeenCalled();
    } finally {
      seeded.unwatch();
    }
  });

  it("spawns locally when the peer's agent row is gone", async () => {
    // A deleted agent's registry rows outlive the row by up to one lease.
    // Routing to them would resurrect a 404, so the version read gates it.
    const seeded = await seedAgent("deleted-soon");
    const registry = createMemorySandboxRegistry("replica-b");
    registry.registerPeer("deleted-soon", {
      sessionUrl: "wss://peer.test:443/websocket",
      guestOrigin: "wss://peer.test:443",
    });
    try {
      await seeded.deleteAgent();
      const brokered = await brokerSessionUrl("deleted-soon", { ...seeded, registry });
      expect(brokered).toMatchObject({ ok: false, status: 404 });
      expect(mockSpawnAgentServer).not.toHaveBeenCalled();
    } finally {
      seeded.unwatch();
    }
  });

  it("prefers its own warm resident over a peer", async () => {
    // A local resident costs nothing; the registry read is a DB round trip
    // on a path where the caller is waiting.
    const seeded = await seedAgent("warm-local");
    const registry = createMemorySandboxRegistry("replica-b");
    try {
      const first = await brokerSessionUrl("warm-local", { ...seeded, registry });
      expect(first).toMatchObject({ ok: true, sessionUrl: "wss://tunnel.test:443/websocket" });
      registry.registerPeer("warm-local", {
        sessionUrl: "wss://peer.test:443/websocket",
        guestOrigin: "wss://peer.test:443",
      });
      const second = await brokerSessionUrl("warm-local", { ...seeded, registry });
      expect(second).toMatchObject({ sessionUrl: "wss://tunnel.test:443/websocket" });
    } finally {
      seeded.unwatch();
    }
  });

  it("spawns locally when a registry read fails, rather than failing the broker", async () => {
    const seeded = await seedAgent("registry-down");
    const registry = {
      register: () => Promise.resolve(),
      unregister: () => Promise.resolve(),
      findPeer: () => Promise.reject(new Error("registry unreachable")),
    };
    try {
      await expect(
        brokerSessionUrl("registry-down", { ...seeded, registry }),
      ).resolves.toMatchObject({ ok: true, sessionUrl: "wss://tunnel.test:443/websocket" });
    } finally {
      seeded.unwatch();
    }
  });
});
