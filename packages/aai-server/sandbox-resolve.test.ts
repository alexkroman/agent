// Copyright 2026 the AAI authors. MIT license.
/**
 * resolveSandbox's slug-epoch invalidation (see sandbox-resolve.ts +
 * platform-epoch.ts): a deploy/secret/storage mutation on another replica —
 * or the studio service — must make this replica rebuild its resident
 * sandbox at the next session start. The vmReady-failure resolution paths
 * are covered in sandbox.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySlugEpochs } from "./platform-epoch.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import type { RpcConnection } from "./rpc-transport.ts";
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
  await store.putAgent({
    slug,
    env: {},
    worker: 'export default { name: "t" };',
    clientFiles: {},
    credential_hashes: ["hash"],
    agentConfig: TEST_AGENT_CONFIG,
  });
  const invalidate = vi.fn();
  return {
    slots: createSlotCache(),
    store: Object.assign(store, { invalidate }),
    invalidate,
    slugEpochs: createMemorySlugEpochs(),
  };
}

describe("resolveSandbox epoch invalidation", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the resident sandbox while the epoch is unchanged", async () => {
    const deps = await seedAgent("stable");
    const first = await resolveSandbox("stable", deps);
    const second = await resolveSandbox("stable", deps);
    expect(second).toBe(first);
    expect(deps.invalidate).not.toHaveBeenCalled();
    await first?.shutdown();
  });

  it("rebuilds (and drops bundle caches) after another replica's mutation", async () => {
    const deps = await seedAgent("redeployed");
    const first = await resolveSandbox("redeployed", deps);
    expect(first).not.toBeNull();

    // A deploy/secret/storage mutation elsewhere bumps the slug's epoch.
    await deps.slugEpochs.bump("redeployed");

    const second = await resolveSandbox("redeployed", deps);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // The rebuild must not read pre-mutation cached artifacts.
    expect(deps.invalidate).toHaveBeenCalledWith("redeployed");
    // The rebuilt sandbox is current: a third resolve reuses it.
    await expect(resolveSandbox("redeployed", deps)).resolves.toBe(second);
    await second?.shutdown();
  });

  it("a deleted agent stops resolving once the epoch advances", async () => {
    const deps = await seedAgent("gone");
    const first = await resolveSandbox("gone", deps);
    expect(first).not.toBeNull();

    // Delete on another replica: bundle gone, epoch bumped.
    await deps.store.deleteAgent("gone");
    await deps.slugEpochs.bump("gone");

    await expect(resolveSandbox("gone", deps)).resolves.toBeNull();
  });

  it("without an epoch store, residents are reused (dev behavior)", async () => {
    const deps = await seedAgent("dev-mode");
    const { slugEpochs: _unused, ...withoutEpochs } = deps;
    const first = await resolveSandbox("dev-mode", withoutEpochs);
    const second = await resolveSandbox("dev-mode", withoutEpochs);
    expect(second).toBe(first);
    await first?.shutdown();
  });

  it("an unreadable epoch store degrades to serving the resident sandbox", async () => {
    const deps = await seedAgent("db-blip");
    const first = await resolveSandbox("db-blip", deps);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    deps.slugEpochs.get = () => Promise.reject(new Error("db down"));
    // A session start must not die on the invalidation check.
    await expect(resolveSandbox("db-blip", deps)).resolves.toBe(first);
    expect(warn).toHaveBeenCalled();
    await first?.shutdown();
  });
});
