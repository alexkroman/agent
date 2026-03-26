// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestKvStore,
  createTestStore,
  createTestVectorStore,
  makeSlot,
} from "./_test-utils.ts";
import type { Sandbox } from "./sandbox.ts";
import {
  _deps,
  _slotInternals,
  type AgentSlot,
  ensureAgent,
  registerSlot,
  resolveSandbox,
} from "./sandbox-slots.ts";

// ── Mock createSandbox ──────────────────────────────────────────────────

function makeMockSandbox(): Sandbox {
  return {
    startSession: vi.fn(),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

const mockCreateSandbox = vi.fn(async () => makeMockSandbox());
_deps.createSandbox = mockCreateSandbox;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeEnsureOpts(overrides?: Record<string, unknown>) {
  const kvStore = createTestKvStore();
  return {
    getWorkerCode: vi.fn(async () => "console.log('agent');"),
    kvCtx: { kvStore, scope: { keyHash: "kh", slug: "test" } },
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
    const result = await resolveSandbox("unknown", {
      slots: new Map(),
      store,
      kvStore: createTestKvStore(),
    });
    expect(result).toBeNull();
  });

  it("lazy-discovers agent from store and creates sandbox", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "lazy-agent",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
    });

    const slots = new Map<string, AgentSlot>();
    const result = await resolveSandbox("lazy-agent", {
      slots,
      store,
      kvStore: createTestKvStore(),
    });

    expect(result).toBeDefined();
    expect(slots.has("lazy-agent")).toBe(true);
    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });

  it("strips ASSEMBLYAI_API_KEY from agentEnv", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "env-agent",
      env: { ASSEMBLYAI_API_KEY: "platform-key", CUSTOM_SECRET: "val" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
    });

    const slots = new Map<string, AgentSlot>();
    await resolveSandbox("env-agent", {
      slots,
      store,
      kvStore: createTestKvStore(),
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
      slots,
      store,
      kvStore: createTestKvStore(),
    });

    // Second call reuses sandbox
    await resolveSandbox("reuse", {
      slots,
      store,
      kvStore: createTestKvStore(),
    });

    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });

  it("passes vectorStore when provided", async () => {
    const store = createTestStore();
    await store.putAgent({
      slug: "vec-agent",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "console.log('w');",
      clientFiles: {},
    });

    const vectorStore = createTestVectorStore();
    const slots = new Map<string, AgentSlot>();

    await resolveSandbox("vec-agent", {
      slots,
      store,
      kvStore: createTestKvStore(),
      vectorStore,
    });

    expect(mockCreateSandbox).toHaveBeenCalledWith(expect.objectContaining({ vectorStore }));
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
