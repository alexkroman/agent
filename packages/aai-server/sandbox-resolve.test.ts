// Copyright 2026 the AAI authors. MIT license.
/**
 * Slug → sandbox resolution and the paths that hang off it: storage
 * (`ctx.db`) env delivery, the draining guard, the broker's readiness cap,
 * and the fleet-wide directory that keeps one sandbox per deploy.
 *
 * The agents-row change stream that INVALIDATES these residents moved to
 * sandbox-invalidate.test.ts with the code it covers; vmReady-failure
 * resolution is in sandbox.test.ts. `seedAgent` still wires a real watcher,
 * because several cases below depend on a resident not being disturbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryPlatformEvents } from "./platform-events.ts";
import { brokerSessionUrl } from "./sandbox-broker.ts";
import { createMemorySandboxDirectory, SandboxNameTakenError } from "./sandbox-directory.ts";
import { watchAgentInvalidation } from "./sandbox-invalidate.ts";
import { resolveSandbox } from "./sandbox-resolve.ts";
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

async function seedAgent(slug: string) {
  const memory = createMemoryPlatformEvents();
  // The real signal that a change event has been delivered AND its handler
  // has finished — this file used to spin 20 microtasks and hope.
  const settleEvents = (): Promise<void> => memory.settled();
  // Models a Realtime OUTAGE, which is the one thing the memory emitter cannot
  // do on its own: the row write still lands, its notification is simply not
  // delivered. Dropping the emit rather than the write is the whole point —
  // the database is the source of truth and stays correct; what breaks is this
  // replica's knowledge of it.
  let streamDown = false;
  const store = createTestStore(undefined, {
    ...memory,
    emitAgent: (changed: string) => {
      if (!streamDown) memory.emitAgent(changed);
    },
  });
  const put = (worker: string) =>
    store.putAgent({
      slug,
      env: {},
      worker,
      clientFiles: {},
      credential_hashes: ["hash"],
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
    settleEvents,
    /**
     * Write a new deploy's row WITHOUT waiting for the change event to be
     * handled. Separate from `redeploy` because the handler queues on the
     * slug lock: a caller holding that lock must commit, release, and only
     * then settle — awaiting settlement first deadlocks.
     */
    commitDeploy: () => put('export default { name: "t2" };'),
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
    /** Take the change stream down / bring it back — see `streamDown`. */
    setStreamDown: (down: boolean) => {
      streamDown = down;
    },
    /** The stream re-joined: `subscribe()` acked SUBSCRIBED. */
    rejoin: async () => {
      memory.emitAgentResync();
      await settleEvents();
    },
  };
}

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
 * Shutdown must not leave a sandbox behind. Flipping `draining` only makes
 * `/health` fail — the platform's proxy stops routing here when it notices —
 * so requests keep arriving for a window. Booting one then produces a guest
 * nothing holds: no slot references it, this process is about to exit, and it
 * bills until Modal's idle timeout. Rare at MIN_CONTAINERS=1 (only a
 * redeploy shuts a replica down); routine at 0.
 */
describe("broker while draining", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("refuses to boot a new sandbox, answering a retryable 503", async () => {
    const deps = await seedAgent("shutting-down");
    mockSpawnAgentServer.mockClear();

    const brokered = await brokerSessionUrl("shutting-down", {
      ...deps,
      isDraining: () => true,
    });

    expect(brokered).toEqual({ ok: false, status: 503 });
    expect(mockSpawnAgentServer).not.toHaveBeenCalled();
    // Nothing installed either — an empty slot must not be left behind.
    expect(deps.slots.get("shutting-down")?.sandbox).toBeUndefined();
    deps.unwatch();
  });

  /**
   * The broker's 503 is the polite half; the guard sits at sandbox
   * CONSTRUCTION, which is the path `resolveSandbox` and the change stream's
   * blue-green `handoverSlot` share — the latter's boot easily outlasts the
   * shutdown grace window, so guarding only the broker left the orphan
   * reachable through the second door.
   */
  it("refuses at construction, not just at the broker", async () => {
    const seeded = await seedAgent("construction-guard");
    mockSpawnAgentServer.mockClear();
    await expect(
      resolveSandbox("construction-guard", { ...seeded, isDraining: () => true }),
    ).rejects.toThrow(/draining/);
    expect(mockSpawnAgentServer).not.toHaveBeenCalled();
    // And no empty slot is left claimed behind the refusal.
    expect(seeded.slots.get("construction-guard")).toBeUndefined();
    seeded.unwatch();
  });

  // A guest that already exists orphans nothing by being handed out, and the
  // guests outlive this process by design — cutting them off would break
  // sessions that are about to be perfectly fine.
  it("still serves a live resident", async () => {
    const deps = await seedAgent("warm");
    const first = await brokerSessionUrl("warm", deps);
    expect(first).toMatchObject({ ok: true });

    const draining = await brokerSessionUrl("warm", { ...deps, isDraining: () => true });
    expect(draining).toMatchObject({ ok: true, sessionUrl: "wss://tunnel.test:443/websocket" });
    await deps.slots.get("warm")?.sandbox?.shutdown();
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
    // `restoreMocks` (vitest.shared.ts) restores every spy before each test,
    // which strips the hoisted factory's default — so re-arm it here.
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

  it("routes a cold broker to a live peer instead of spawning a duplicate", async () => {
    // The reported bug: two replicas serving one slug each spawned a guest,
    // because the slot cache is per-replica and Modal load-balances every
    // request independently.
    const seeded = await seedAgent("shared");
    const directory = createMemorySandboxDirectory();
    const version = await seeded.store.getAgentVersion("shared");
    directory.setPeer("shared", version ?? 1, {
      sessionUrl: "wss://peer.test:443/websocket",
      guestOrigin: "wss://peer.test:443",
    });
    try {
      const brokered = await brokerSessionUrl("shared", { ...seeded, directory });
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

  /**
   * The name carries the deploy version, so a peer's sandbox for an OLD
   * version is not a match. The lease table it replaced could hand out a guest
   * running superseded code until the owner's heartbeat stopped.
   */
  it("ignores a peer running a superseded version", async () => {
    const seeded = await seedAgent("versioned");
    const directory = createMemorySandboxDirectory();
    const version = (await seeded.store.getAgentVersion("versioned")) ?? 1;
    directory.setPeer("versioned", version - 1, {
      sessionUrl: "wss://stale-peer.test:443/websocket",
      guestOrigin: "wss://stale-peer.test:443",
    });
    try {
      const brokered = await brokerSessionUrl("versioned", { ...seeded, directory });
      expect(brokered).toMatchObject({ sessionUrl: "wss://tunnel.test:443/websocket" });
    } finally {
      seeded.unwatch();
    }
  });

  it("spawns locally when the peer's agent row is gone", async () => {
    // A deleted agent's sandbox can still be RUNNING — retirement drains it
    // for minutes — and routing to it would resurrect a 404, so the version
    // read gates it.
    const seeded = await seedAgent("deleted-soon");
    const directory = createMemorySandboxDirectory();
    const version = (await seeded.store.getAgentVersion("deleted-soon")) ?? 1;
    directory.setPeer("deleted-soon", version, {
      sessionUrl: "wss://peer.test:443/websocket",
      guestOrigin: "wss://peer.test:443",
    });
    try {
      await seeded.deleteAgent();
      const brokered = await brokerSessionUrl("deleted-soon", { ...seeded, directory });
      expect(brokered).toMatchObject({ ok: false, status: 404 });
      expect(mockSpawnAgentServer).not.toHaveBeenCalled();
    } finally {
      seeded.unwatch();
    }
  });

  it("prefers its own warm resident over a peer", async () => {
    // A local resident costs nothing; the directory lookup is a round trip on
    // a path where the caller is waiting.
    const seeded = await seedAgent("warm-local");
    const directory = createMemorySandboxDirectory();
    try {
      const first = await brokerSessionUrl("warm-local", { ...seeded, directory });
      expect(first).toMatchObject({ ok: true, sessionUrl: "wss://tunnel.test:443/websocket" });
      const version = (await seeded.store.getAgentVersion("warm-local")) ?? 1;
      directory.setPeer("warm-local", version, {
        sessionUrl: "wss://peer.test:443/websocket",
        guestOrigin: "wss://peer.test:443",
      });
      const second = await brokerSessionUrl("warm-local", { ...seeded, directory });
      expect(second).toMatchObject({ sessionUrl: "wss://tunnel.test:443/websocket" });
    } finally {
      seeded.unwatch();
    }
  });

  it("spawns locally when a directory lookup fails, rather than failing the broker", async () => {
    const seeded = await seedAgent("directory-down");
    const directory = { find: () => Promise.reject(new Error("modal unreachable")) };
    try {
      await expect(
        brokerSessionUrl("directory-down", { ...seeded, directory }),
      ).resolves.toMatchObject({ ok: true, sessionUrl: "wss://tunnel.test:443/websocket" });
    } finally {
      seeded.unwatch();
    }
  });
});

/**
 * The name is what makes one deploy one sandbox fleet-wide, so losing the race
 * for it is the one remaining path to a duplicate — and it must resolve to the
 * winner's guest, not to a second spawn.
 */
describe("losing the sandbox name race", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("routes to the peer that won it", async () => {
    const seeded = await seedAgent("raced");
    const directory = createMemorySandboxDirectory();
    const version = (await seeded.store.getAgentVersion("raced")) ?? 1;
    mockSpawnAgentServer.mockImplementationOnce(() => {
      // The winner publishes as our create fails.
      directory.setPeer("raced", version, {
        sessionUrl: "wss://winner.test:443/websocket",
        guestOrigin: "wss://winner.test:443",
      });
      return Promise.reject(new SandboxNameTakenError("agent-x-v1"));
    });
    try {
      const brokered = await brokerSessionUrl("raced", { ...seeded, directory });
      expect(brokered).toMatchObject({ ok: true, sessionUrl: "wss://winner.test:443/websocket" });
    } finally {
      seeded.unwatch();
    }
  });

  it("answers a retryable 503 when the winner has not published yet", async () => {
    const seeded = await seedAgent("raced-early");
    const directory = createMemorySandboxDirectory();
    mockSpawnAgentServer.mockImplementationOnce(() =>
      Promise.reject(new SandboxNameTakenError("agent-y-v1")),
    );
    try {
      const brokered = await brokerSessionUrl("raced-early", { ...seeded, directory });
      // Retryable, never a 404: the agent exists, its sandbox is mid-boot
      // somewhere else in the fleet.
      expect(brokered).toMatchObject({ ok: false, status: 503 });
    } finally {
      seeded.unwatch();
    }
  });
});
