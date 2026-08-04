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
import { createMemorySandboxRegistry } from "./sandbox-registry.ts";
import { brokerSessionUrl, resolveSandbox, watchAgentInvalidation } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { appDbSecretName, createMemorySecretStore } from "./secret-store.ts";
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
    // The cold rebuild itself reads fresh (one invalidate); a warm resident
    // costs nothing more.
    deps.invalidate.mockClear();
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

    // The queued handler ran after the attach: version mismatch → retired.
    await vi.waitFor(() => {
      expect(deps.slots.get("mid-rebuild")?.sandbox).toBeUndefined();
    });
    // The next broker rebuilds at the row's current version and stays put.
    const fresh = await resolveSandbox("mid-rebuild", deps);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(stale);
    await expect(resolveSandbox("mid-rebuild", deps)).resolves.toBe(fresh);
    await fresh?.shutdown();
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

describe("cross-replica sandbox registry", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedWithRegistry(slug: string) {
    const deps = await seedAgent(slug);
    const registry = createMemorySandboxRegistry("this-replica");
    return { ...deps, registry, opts: { ...deps, registry } };
  }

  it("a resident sandbox registers itself with its session URL", async () => {
    const { opts, registry, unwatch } = await seedWithRegistry("registered");
    const register = vi.spyOn(registry, "register");
    const sandbox = await resolveSandbox("registered", opts);
    expect(sandbox).not.toBeNull();
    // The first heartbeat runs on attach (no timer wait needed).
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith("registered", expect.any(String), expect.any(Number));
    });
    await sandbox?.shutdown();
    unwatch();
  });

  it("the broker routes a cold slug to a live peer sandbox instead of spawning", async () => {
    const { opts, registry, unwatch } = await seedWithRegistry("shared");
    registry.registerPeer("shared", "wss://peer.tunnel/session", 1);

    const brokered = await brokerSessionUrl("shared", opts);
    expect(brokered).toEqual({ ok: true, sessionUrl: "wss://peer.tunnel/session" });
    // No local sandbox was built.
    expect(opts.slots.get("shared")?.sandbox).toBeUndefined();
    unwatch();
  });

  it("a warm local resident wins over peers", async () => {
    const { opts, registry, unwatch } = await seedWithRegistry("local-first");
    const sandbox = await resolveSandbox("local-first", opts);
    registry.registerPeer("local-first", "wss://peer.tunnel/session", 0);

    const brokered = await brokerSessionUrl("local-first", opts);
    expect(brokered.ok).toBe(true);
    if (brokered.ok) expect(brokered.sessionUrl).not.toBe("wss://peer.tunnel/session");
    await sandbox?.shutdown();
    unwatch();
  });

  it("peers at session capacity are passed over for a local spawn", async () => {
    const { opts, registry, unwatch } = await seedWithRegistry("saturated");
    registry.registerPeer("saturated", "wss://full.tunnel/session", 2);

    const brokered = await brokerSessionUrl("saturated", {
      ...opts,
      scale: { maxSessionsPerSandbox: 2, maxSandboxes: 4 },
    });
    expect(brokered.ok).toBe(true);
    if (brokered.ok) expect(brokered.sessionUrl).not.toBe("wss://full.tunnel/session");
    // The local spawn happened.
    expect(opts.slots.get("saturated")?.sandbox).toBeDefined();
    await (opts.slots.get("saturated")?.sandbox as Sandbox | undefined)?.shutdown();
    unwatch();
  });

  it("a deleted agent's lingering registry row cannot resurrect it", async () => {
    const { opts, registry, unwatch } = await seedWithRegistry("deleted-peer");
    registry.registerPeer("deleted-peer", "wss://ghost.tunnel/session", 0);
    await opts.store.deleteAgent("deleted-peer");
    await settleEvents();

    const brokered = await brokerSessionUrl("deleted-peer", opts);
    expect(brokered).toEqual({ ok: false, status: 404 });
    unwatch();
  });

  it("a broken registry never fails a broker request", async () => {
    const { opts, unwatch } = await seedWithRegistry("registry-down");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      register: () => Promise.reject(new Error("db down")),
      unregister: () => Promise.reject(new Error("db down")),
      listPeers: () => Promise.reject(new Error("db down")),
    };
    const brokered = await brokerSessionUrl("registry-down", { ...opts, registry: broken });
    expect(brokered.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    await (opts.slots.get("registry-down")?.sandbox as Sandbox | undefined)?.shutdown();
    unwatch();
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
    mockCreateSandboxVm.mockClear();

    const sandbox = await resolveSandbox("stored-app", {
      slots: createSlotCache(),
      store,
      secrets,
      appDb,
    });
    expect(sandbox).not.toBeNull();

    // The guest connects to its OWN scoped database directly — the app-db
    // credential rides in the env, and no db handle stays host-side.
    const vmOpts = mockCreateSandboxVm.mock.calls[0]?.[0] as {
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
    mockCreateSandboxVm.mockClear();
    const sandbox = await resolveSandbox("no-storage", deps);
    const vmOpts = mockCreateSandboxVm.mock.calls[0]?.[0] as {
      env: Record<string, string>;
    };
    expect(vmOpts.env).toEqual({});
    await sandbox?.shutdown();
    deps.unwatch();
  });
});
