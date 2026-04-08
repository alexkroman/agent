// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "./sandbox.ts";
import {
  _slotInternals,
  createSlotCache,
  ensureAgent,
  registerSlot,
  resolveSandbox,
  warmAgent,
} from "./sandbox-slots.ts";
import { createTestStorage, createTestStore, makeSlot } from "./test-utils.ts";

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
  let savedIdleMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    savedIdleMs = _slotInternals.IDLE_MS;
    _slotInternals.IDLE_MS = 200;
    mockCreateSandbox.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    _slotInternals.IDLE_MS = savedIdleMs;
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

  it("evicts sandbox after idle timeout", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();

    const sandbox = await ensureAgent(slot, opts);
    expect(slot.sandbox).toBeDefined();

    await vi.advanceTimersByTimeAsync(_slotInternals.IDLE_MS + 1);

    expect(slot.sandbox).toBeUndefined();
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("concurrent calls during eviction share the same new sandbox", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();

    // Create initial sandbox
    await ensureAgent(slot, opts);
    expect(mockCreateSandbox).toHaveBeenCalledTimes(1);

    // Use a deferred promise so we control when shutdown() resolves
    let resolveShutdown!: () => void;
    const shutdownPromise = new Promise<void>((r) => {
      resolveShutdown = r;
    });
    // biome-ignore lint/style/noNonNullAssertion: sandbox is set above
    slot.sandbox!.shutdown = vi.fn(() => shutdownPromise);

    // Fire the idle timer — evictSlot acquires the lock and awaits shutdown
    vi.advanceTimersByTime(_slotInternals.IDLE_MS + 1);
    // Yield so evictSlot acquires the lock (uncontested at this point)
    await vi.advanceTimersByTimeAsync(0);

    // Two concurrent ensureAgent calls queue behind the eviction lock
    const p1 = ensureAgent(slot, opts);
    const p2 = ensureAgent(slot, opts);

    // Let shutdown complete — releases the lock
    resolveShutdown();
    const [sb1, sb2] = await Promise.all([p1, p2]);

    // Both should get the same sandbox, only one new createSandbox call
    expect(sb1).toBe(sb2);
    expect(mockCreateSandbox).toHaveBeenCalledTimes(2);
  });

  it("resets idle timer on subsequent ensureAgent calls", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();

    await ensureAgent(slot, opts);

    // Advance partway through the idle timeout
    await vi.advanceTimersByTimeAsync(_slotInternals.IDLE_MS - 50);
    expect(slot.sandbox).toBeDefined();

    // Call again to reset timer
    await ensureAgent(slot, opts);

    // Advance partway again — should NOT have evicted
    await vi.advanceTimersByTimeAsync(_slotInternals.IDLE_MS - 50);
    expect(slot.sandbox).toBeDefined();

    // Now advance past the full idle period — should evict
    await vi.advanceTimersByTimeAsync(51);
    expect(slot.sandbox).toBeUndefined();
  });

  it("evicts LRU slot at capacity instead of throwing", async () => {
    const { MAX_SLOTS } = await import("./constants.ts");

    // Create a cache and fill it to MAX_SLOTS with active sandboxes
    const slots = createSlotCache();
    const shutdowns: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const sb = makeMockSandbox();
      shutdowns.push(sb.shutdown as ReturnType<typeof vi.fn>);
      const s = makeSlot({ slug: `agent-${i}`, sandbox: sb });
      slots.set(s.slug, s);
    }

    // The LRU-oldest is agent-0. Adding one more should evict it.
    const extraSlot = makeSlot({ slug: "one-too-many" });
    slots.set(extraSlot.slug, extraSlot);
    const opts = makeEnsureOpts({ slug: "one-too-many" });

    const result = await ensureAgent(extraSlot, opts, slots);
    expect(result).toBeDefined();
    expect(mockCreateSandbox).toHaveBeenCalledOnce();

    // agent-0 should have been evicted by LRU
    expect(slots.has("agent-0")).toBe(false);
    // Its sandbox should have been shut down via the dispose callback
    expect(shutdowns[0]).toHaveBeenCalled();
  });

  it("allows spawn when active slots are below MAX_SLOTS", async () => {
    const slots = createSlotCache();
    const slot = makeSlot({ slug: "ok-agent" });
    slots.set(slot.slug, slot);
    const opts = makeEnsureOpts({ slug: "ok-agent" });

    const result = await ensureAgent(slot, opts, slots);
    expect(result).toBeDefined();
    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });

  it("rejects spawn when RSS exceeds MAX_RSS_MB", async () => {
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

  it("allows spawn when RSS is below MAX_RSS_MB", async () => {
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
    vi.useFakeTimers();
    mockCreateSandbox.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
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

describe("warmAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCreateSandbox.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pre-boots sandbox for a registered slug", async () => {
    const slots = createSlotCache();
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "warm-me",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "w",
      clientFiles: {},
    });
    registerSlot(slots, { slug: "warm-me", env: {}, credential_hashes: ["hash"] });
    await warmAgent("warm-me", { slots, store, storage, createSandbox: mockCreateSandbox });
    expect(mockCreateSandbox).toHaveBeenCalledOnce();
    expect(slots.get("warm-me")?.sandbox).toBeDefined();
  });

  it("does not throw if slug is unknown", async () => {
    const slots = createSlotCache();
    const store = createTestStore();
    const storage = createTestStorage();
    await warmAgent("unknown", { slots, store, storage, createSandbox: mockCreateSandbox });
    expect(mockCreateSandbox).not.toHaveBeenCalled();
  });
});

describe("_slotInternals", () => {
  it("gets and sets IDLE_MS", () => {
    const original = _slotInternals.IDLE_MS;
    _slotInternals.IDLE_MS = 999;
    expect(_slotInternals.IDLE_MS).toBe(999);
    _slotInternals.IDLE_MS = original;
  });
});
