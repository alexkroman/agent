// Copyright 2026 the AAI authors. MIT license.
/**
 * resolveSandbox's deploy-version invalidation (see sandbox-resolve.ts +
 * agent-store.ts): a deploy on another replica — or the studio service —
 * must make this replica rebuild its resident sandbox at the next session
 * start, and a delete must stop it resolving. Secret changes deliberately
 * do NOT move sandboxes (they apply on the next deploy/rebuild). The
 * vmReady-failure resolution paths are covered in sandbox.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_SANDBOX_MS, RETIRE_POLL_MS } from "./constants.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import type { RpcConnection } from "./rpc-transport.ts";
import type { Sandbox } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox-resolve.ts";
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

async function seedAgent(slug: string) {
  const store = createTestStore();
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
  // Spy that calls through: the resolver's cache drop must actually happen
  // for the rebuild to read the freshly deployed record.
  const invalidate = vi.spyOn(store, "invalidate");
  return {
    slots: createSlotCache(),
    store,
    invalidate,
    redeploy: () => put('export default { name: "t2" };'),
  };
}

describe("resolveSandbox deploy-version invalidation", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the resident sandbox while the deploy version is unchanged", async () => {
    const deps = await seedAgent("stable");
    const first = await resolveSandbox("stable", deps);
    const second = await resolveSandbox("stable", deps);
    expect(second).toBe(first);
    expect(deps.invalidate).not.toHaveBeenCalled();
    await first?.shutdown();
  });

  it("rebuilds (and drops row caches) after another replica's deploy", async () => {
    const deps = await seedAgent("redeployed");
    const first = await resolveSandbox("redeployed", deps);
    expect(first).not.toBeNull();

    // A deploy elsewhere bumps the agents row's version.
    await deps.redeploy();

    const second = await resolveSandbox("redeployed", deps);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // The rebuild must not read a pre-mutation cached row.
    expect(deps.invalidate).toHaveBeenCalledWith("redeployed");
    // The rebuilt sandbox is current: a third resolve reuses it.
    await expect(resolveSandbox("redeployed", deps)).resolves.toBe(second);
    await second?.shutdown();
  });

  it("a deleted agent stops resolving (version reads null)", async () => {
    const deps = await seedAgent("gone");
    const first = await resolveSandbox("gone", deps);
    expect(first).not.toBeNull();

    // Delete on another replica: row gone.
    await deps.store.deleteAgent("gone");

    await expect(resolveSandbox("gone", deps)).resolves.toBeNull();
  });

  it("a secret change does NOT retire the resident sandbox", async () => {
    const deps = await seedAgent("secretly-updated");
    const first = await resolveSandbox("secretly-updated", deps);
    expect(first).not.toBeNull();

    // Secret mutations bump nothing: they take effect on the next deploy.
    await deps.store.putEnv("secretly-updated", { NEW_KEY: "v" });

    await expect(resolveSandbox("secretly-updated", deps)).resolves.toBe(first);
    await first?.shutdown();
  });

  it("an unreadable version store degrades to serving the resident sandbox", async () => {
    const deps = await seedAgent("db-blip");
    const first = await resolveSandbox("db-blip", deps);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    deps.store.getAgentVersion = () => Promise.reject(new Error("db down"));
    // A session start must not die on the invalidation check.
    await expect(resolveSandbox("db-blip", deps)).resolves.toBe(first);
    expect(warn).toHaveBeenCalled();
    await first?.shutdown();
  });
});

/**
 * The version check above only runs when a session is brokered on THIS
 * replica. A deploy elsewhere therefore leaves a sandbox serving pre-deploy
 * code for as long as nobody re-brokers here — indefinitely if it holds
 * sessions, since the plain idle probe re-arms on any live count. The idle
 * timer is the backstop, so it consults the version too.
 */
describe("idle sweep retires superseded sandboxes without a new broker", () => {
  beforeEach(() => {
    // `performance` too — retirement's drain deadline is measured with
    // performance.now(), which vitest leaves real by default.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("detaches and drops row caches after another replica's deploy", async () => {
    const deps = await seedAgent("orphaned");
    const sandbox = await resolveSandbox("orphaned", deps);
    expect(sandbox).not.toBeNull();
    // Busy guest: the plain session probe would keep re-arming the timer.
    let live = 4;
    vi.spyOn(sandbox as Sandbox, "activeSessions").mockImplementation(() => Promise.resolve(live));
    const shutdown = vi.spyOn(sandbox as Sandbox, "shutdown");

    await deps.redeploy();
    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    // Off the slot immediately, so the next broker builds the new bundle...
    expect(deps.slots.get("orphaned")?.sandbox).toBeUndefined();
    // The rebuild must read the freshly deployed row, not a cached one.
    expect(deps.invalidate).toHaveBeenCalledWith("orphaned");
    // ...but the four calls on it are not hung up on.
    expect(shutdown).not.toHaveBeenCalled();

    live = 0;
    await vi.advanceTimersByTimeAsync(RETIRE_POLL_MS + 1);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("leaves a current resident alone", async () => {
    const deps = await seedAgent("fresh");
    const sandbox = await resolveSandbox("fresh", deps);
    vi.spyOn(sandbox as Sandbox, "activeSessions").mockResolvedValue(1);
    const shutdown = vi.spyOn(sandbox as Sandbox, "shutdown");

    await vi.advanceTimersByTimeAsync(IDLE_SANDBOX_MS + 1);

    expect(shutdown).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
  });
});
