// Copyright 2025 the AAI authors. MIT license.
import type { Kv } from "@alexkroman1/aai/kv";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildNetworkAdapter, buildNetworkPolicy } from "./sandbox-network.ts";

vi.mock("secure-exec", () => ({
  createDefaultNetworkAdapter: () => ({
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: "default",
      url: "",
      redirected: false,
    }),
  }),
}));

function createMockKv(): Kv {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null) as Kv["get"],
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    keys: vi.fn(async () => ["k1", "k2"]),
    list: vi.fn(async () => [{ key: "k1", value: "v1" }]) as Kv["list"],
  };
}

// ── buildNetworkPolicy ──────────────────────────────────────────────────

describe("buildNetworkPolicy", () => {
  const policy = buildNetworkPolicy();

  test("allows all ops", () => {
    expect(policy({ op: "listen" })).toEqual({ allow: true });
    expect(policy({ op: "dns", hostname: "example.com" })).toEqual({ allow: true });
    expect(policy({ op: "fetch", url: "https://example.com" })).toEqual({ allow: true });
  });
});

// ── buildNetworkAdapter ─────────────────────────────────────────────────

describe("buildNetworkAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("delegates non-KV calls to default adapter", async () => {
    const kv = createMockKv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));

    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("https://example.com/api", { method: "GET" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.body).toBe("default");
  });

  test("KV get returns value", async () => {
    const kv = createMockKv();
    kv.get = vi.fn(async () => ({ saved: true })) as Kv["get"];

    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("http://kv.internal/get", {
      method: "POST",
      body: JSON.stringify({ key: "test-key" }),
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.body)).toEqual({ saved: true });
    expect(kv.get).toHaveBeenCalledWith("test-key");
  });

  test("KV get returns null for missing key", async () => {
    const kv = createMockKv();
    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("http://kv.internal/get", {
      method: "POST",
      body: JSON.stringify({ key: "missing" }),
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.body)).toBeNull();
  });

  test("KV set stores value", async () => {
    const kv = createMockKv();
    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("http://kv.internal/set", {
      method: "POST",
      body: JSON.stringify({ key: "k", value: "v" }),
    });

    expect(result.ok).toBe(true);
    expect(kv.set).toHaveBeenCalledWith("k", "v", undefined);
  });

  test("KV del removes key", async () => {
    const kv = createMockKv();
    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("http://kv.internal/del", {
      method: "POST",
      body: JSON.stringify({ key: "k" }),
    });

    expect(result.ok).toBe(true);
    expect(kv.delete).toHaveBeenCalledWith("k");
  });

  test("KV keys returns list", async () => {
    const kv = createMockKv();
    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("http://kv.internal/keys", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.body)).toEqual(["k1", "k2"]);
  });

  test("KV list returns entries", async () => {
    const kv = createMockKv();
    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("http://kv.internal/list", {
      method: "POST",
      body: JSON.stringify({ prefix: "" }),
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.body)).toEqual([{ key: "k1", value: "v1" }]);
  });

  test("unknown KV path returns 400", async () => {
    const kv = createMockKv();
    const adapter = buildNetworkAdapter(kv);
    const result = await adapter.fetch("http://kv.internal/unknown", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });
});
