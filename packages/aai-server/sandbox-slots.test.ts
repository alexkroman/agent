// Copyright 2025 the AAI authors. MIT license.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IsolateConfig } from "./rpc-schemas.ts";
import type { Sandbox } from "./sandbox.ts";
import { createSlotCache, ensureAgent, registerSlot, resolveSandbox } from "./sandbox-slots.ts";
import { createTestStorage, createTestStore, makeSlot, TEST_AGENT_CONFIG } from "./test-utils.ts";

// ── Mock createSandbox ──────────────────────────────────────────────────

function makeMockSandbox(): Sandbox {
  return {
    startSession: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
  };
}

const mockCreateSandbox = vi.fn(async () => makeMockSandbox());

// ── Helpers ──────────────────────────────────────────────────────────────

function makeEnsureOpts(overrides?: Record<string, unknown>) {
  const storage = createTestStorage();
  return {
    createSandbox: mockCreateSandbox,
    getWorkerCode: vi.fn(async () => "console.log('agent');"),
    storage,
    slug: "test",
    getApiKey: vi.fn(async () => "api-key"),
    getAgentEnv: vi.fn(async () => ({ SECRET: "val" })),
    getAgentConfig: vi.fn(async () => TEST_AGENT_CONFIG),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("registerSlot", () => {
  it("registers a slot from agent metadata", () => {
    const slots = createSlotCache();
    registerSlot(slots, { slug: "my-agent", env: {}, credential_hashes: ["hash1"] });
    expect(slots.get("my-agent")).toEqual({
      slug: "my-agent",
      keyHash: "hash1",
    });
  });

  it("uses empty string when no credential hashes", () => {
    const slots = createSlotCache();
    registerSlot(slots, { slug: "agent", env: {}, credential_hashes: [] });
    expect(slots.get("agent")?.keyHash).toBe("");
  });
});

describe("ensureAgent", () => {
  beforeEach(() => {
    mockCreateSandbox.mockClear();
  });

  it("returns existing sandbox without calling createSandbox", async () => {
    const sandbox = makeMockSandbox();
    const slot = makeSlot({ sandbox });
    const opts = makeEnsureOpts();

    const result = await ensureAgent(slot, opts);
    expect(result).toBe(sandbox);
    expect(mockCreateSandbox).not.toHaveBeenCalled();
  });

  it("spawns a new sandbox when none exists", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();

    const result = await ensureAgent(slot, opts);
    expect(result).toBeDefined();
    expect(result.startSession).toBeDefined();
    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });

  it("throws when worker code not found", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts({ getWorkerCode: vi.fn(async () => null) });

    await expect(ensureAgent(slot, opts)).rejects.toThrow("Worker code not found");
  });

  it("deduplicates concurrent initialization calls", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();

    const [a, b] = await Promise.all([ensureAgent(slot, opts), ensureAgent(slot, opts)]);
    expect(a).toBe(b);
    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });

  it("allows retry after failure", async () => {
    const slot = makeSlot();
    mockCreateSandbox.mockRejectedValueOnce(new Error("boom"));
    const opts = makeEnsureOpts();

    await expect(ensureAgent(slot, opts)).rejects.toThrow("boom");

    // Retry should work
    mockCreateSandbox.mockResolvedValueOnce(makeMockSandbox());
    const result = await ensureAgent(slot, opts);
    expect(result).toBeDefined();
  });

  it("evicts coldest slot when RSS exceeds limit", async () => {
    const slots = createSlotCache();

    // Fill cache with some agents
    const coldSandbox = makeMockSandbox();
    const coldSlot = makeSlot({ slug: "cold-agent", sandbox: coldSandbox });
    slots.set(coldSlot.slug, coldSlot);

    const warmSandbox = makeMockSandbox();
    const warmSlot = makeSlot({ slug: "warm-agent", sandbox: warmSandbox });
    slots.set(warmSlot.slug, warmSlot);

    // Access warm-agent so cold-agent is LRU
    slots.get("warm-agent");

    // New agent arrives while RSS is over the limit
    const newSlot = makeSlot({ slug: "new-agent" });
    slots.set(newSlot.slug, newSlot);
    const opts = makeEnsureOpts({ slug: "new-agent" });

    const orig = process.memoryUsage;
    let callCount = 0;
    process.memoryUsage = Object.assign(() => {
      callCount++;
      // First call: over limit (triggers eviction), second call: under limit
      const rss = callCount <= 1 ? 2000 * 1024 * 1024 : 500 * 1024 * 1024;
      return { ...orig(), rss };
    }, orig);

    try {
      const result = await ensureAgent(newSlot, opts, slots);
      expect(result).toBeDefined();
      // cold-agent should have been evicted
      expect(slots.has("cold-agent")).toBe(false);
      expect(coldSandbox.shutdown).toHaveBeenCalled();
      // warm-agent should still be there
      expect(slots.has("warm-agent")).toBe(true);
    } finally {
      process.memoryUsage = orig;
    }
  });

  it("throws MemoryPressureError when no slots to evict", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();
    const orig = process.memoryUsage;
    process.memoryUsage = Object.assign(() => ({ ...orig(), rss: 2000 * 1024 * 1024 }), orig);
    try {
      await expect(ensureAgent(slot, opts)).rejects.toThrow("Memory pressure");
      expect(mockCreateSandbox).not.toHaveBeenCalled();
    } finally {
      process.memoryUsage = orig;
    }
  });

  it("allows spawn when RSS is below limit", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();
    const orig = process.memoryUsage;
    process.memoryUsage = Object.assign(() => ({ ...orig(), rss: 500 * 1024 * 1024 }), orig);
    try {
      const result = await ensureAgent(slot, opts);
      expect(result).toBeDefined();
    } finally {
      process.memoryUsage = orig;
    }
  });
});

describe("resolveSandbox", () => {
  beforeEach(() => {
    mockCreateSandbox.mockClear();
  });

  it("returns null when slug not found in slots or store", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    const result = await resolveSandbox("unknown", {
      createSandbox: mockCreateSandbox,
      slots: createSlotCache(),
      store,
      storage,
    });
    expect(result).toBeNull();
  });

  it("lazy-discovers agent from store and creates sandbox", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "lazy-agent",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
      agentConfig: TEST_AGENT_CONFIG,
    });

    const slots = createSlotCache();
    const result = await resolveSandbox("lazy-agent", {
      createSandbox: mockCreateSandbox,
      slots,
      store,
      storage,
    });

    expect(result).toBeDefined();
    expect(slots.has("lazy-agent")).toBe(true);
    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });

  it("strips ASSEMBLYAI_API_KEY from agentEnv", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "env-agent",
      env: { ASSEMBLYAI_API_KEY: "platform-key", CUSTOM_SECRET: "val" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
      agentConfig: TEST_AGENT_CONFIG,
    });

    const slots = createSlotCache();
    await resolveSandbox("env-agent", {
      createSandbox: mockCreateSandbox,
      slots,
      store,
      storage,
    });

    expect(mockCreateSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "platform-key",
        agentEnv: { CUSTOM_SECRET: "val" },
      }),
    );
  });

  it("reuses existing slot", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "reuse",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
      agentConfig: TEST_AGENT_CONFIG,
    });

    const slots = createSlotCache();
    registerSlot(slots, { slug: "reuse", env: {}, credential_hashes: ["hash"] });

    await resolveSandbox("reuse", {
      createSandbox: mockCreateSandbox,
      slots,
      store,
      storage,
    });

    // Second call reuses sandbox
    await resolveSandbox("reuse", {
      createSandbox: mockCreateSandbox,
      slots,
      store,
      storage,
    });

    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });

  it("passes storage and slug to createSandbox", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "vec-agent",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
      agentConfig: TEST_AGENT_CONFIG,
    });

    const slots = createSlotCache();

    await resolveSandbox("vec-agent", {
      createSandbox: mockCreateSandbox,
      slots,
      store,
      storage,
    });

    expect(mockCreateSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ storage, slug: "vec-agent" }),
    );
  });
});

describe("resolveSandbox with agentConfig", () => {
  const testConfig: IsolateConfig = {
    name: "config-agent",
    systemPrompt: "Be helpful",
    greeting: "Hello",
    toolSchemas: [],
    hasState: false,
    hooks: {
      onConnect: false,
      onDisconnect: false,
      onError: false,
      onUserTranscript: false,
      maxStepsIsFn: false,
    },
  };

  beforeEach(() => {
    mockCreateSandbox.mockClear();
  });

  it("passes stored agentConfig to createSandbox", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "config-agent",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
      agentConfig: testConfig,
    });

    const slots = createSlotCache();
    await resolveSandbox("config-agent", {
      createSandbox: mockCreateSandbox,
      slots,
      store,
      storage,
    });

    expect(mockCreateSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: testConfig,
      }),
    );
  });

  it("always passes agentConfig to createSandbox", async () => {
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "config-agent2",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
      agentConfig: testConfig,
    });

    const slots = createSlotCache();
    await resolveSandbox("config-agent2", {
      createSandbox: mockCreateSandbox,
      slots,
      store,
      storage,
    });

    expect(mockCreateSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: testConfig,
      }),
    );
  });
});
