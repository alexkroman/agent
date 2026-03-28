// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestStorage, createTestStore, makeSlot } from "./_test-utils.ts";
import type { Sandbox } from "./sandbox.ts";
import {
  _slotInternals,
  type AgentSlot,
  ensureAgent,
  registerSlot,
  resolveSandbox,
} from "./sandbox-slots.ts";

// ── Mock createSandbox ──────────────────────────────────────────────────

function makeMockSandbox(): Sandbox {
  const shutdown = vi.fn().mockResolvedValue(undefined);
  return {
    startSession: vi.fn(),
    shutdown,
    terminate: shutdown,
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
    const slots = new Map<string, AgentSlot>();
    registerSlot(slots, { slug: "my-agent", env: {}, credential_hashes: ["hash1"] });
    expect(slots.get("my-agent")).toEqual({
      slug: "my-agent",
      keyHash: "hash1",
    });
  });

  it("uses empty string when no credential hashes", () => {
    const slots = new Map<string, AgentSlot>();
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

  it("clears initializing on failure so retry is possible", async () => {
    const slot = makeSlot();
    mockCreateSandbox.mockRejectedValueOnce(new Error("boom"));
    const opts = makeEnsureOpts();

    await expect(ensureAgent(slot, opts)).rejects.toThrow("boom");
    expect(slot.initializing).toBeUndefined();

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

    vi.advanceTimersByTime(_slotInternals.IDLE_MS + 1);

    expect(slot.sandbox).toBeUndefined();
    expect(sandbox.terminate).toHaveBeenCalledOnce();
  });

  it("concurrent calls during termination share the same new sandbox", async () => {
    const slot = makeSlot();
    const opts = makeEnsureOpts();

    // Create initial sandbox
    await ensureAgent(slot, opts);
    expect(mockCreateSandbox).toHaveBeenCalledTimes(1);

    // Use a deferred promise so we control when terminate() resolves
    let resolveTerminate!: () => void;
    const terminatePromise = new Promise<void>((r) => {
      resolveTerminate = r;
    });
    // biome-ignore lint/style/noNonNullAssertion: sandbox is set above
    slot.sandbox!.terminate = vi.fn(() => terminatePromise);

    // Trigger idle eviction — sandbox is deleted, termination starts
    vi.advanceTimersByTime(_slotInternals.IDLE_MS + 1);
    expect(slot.sandbox).toBeUndefined();
    expect(slot.terminating).toBeDefined();

    // Two concurrent ensureAgent calls while termination is in progress
    const p1 = ensureAgent(slot, opts);
    const p2 = ensureAgent(slot, opts);

    // Let termination complete
    resolveTerminate();
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
    vi.advanceTimersByTime(_slotInternals.IDLE_MS - 50);
    expect(slot.sandbox).toBeDefined();

    // Call again to reset timer
    await ensureAgent(slot, opts);

    // Advance partway again — should NOT have evicted
    vi.advanceTimersByTime(_slotInternals.IDLE_MS - 50);
    expect(slot.sandbox).toBeDefined();

    // Now advance past the full idle period — should evict
    vi.advanceTimersByTime(51);
    expect(slot.sandbox).toBeUndefined();
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
      slots: new Map(),
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

    const slots = new Map<string, AgentSlot>();
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

    const slots = new Map<string, AgentSlot>();
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

    const slots = new Map<string, AgentSlot>();
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

    const slots = new Map<string, AgentSlot>();

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

describe("_slotInternals", () => {
  it("gets and sets IDLE_MS", () => {
    const original = _slotInternals.IDLE_MS;
    _slotInternals.IDLE_MS = 999;
    expect(_slotInternals.IDLE_MS).toBe(999);
    _slotInternals.IDLE_MS = original;
  });
});
