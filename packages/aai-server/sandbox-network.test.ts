// Copyright 2025 the AAI authors. MIT license.
import type { Kv } from "@alexkroman1/aai/kv";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { _kvSchemas, buildNetworkAdapter, buildNetworkPolicy } from "./sandbox-network.ts";
import { createMockKv } from "./test-utils.ts";

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
    (kv.keys as ReturnType<typeof vi.fn>).mockResolvedValue(["k1", "k2"]);
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
    (kv.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: "k1", value: "v1" }]);
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

  // ── Host event handling ────────────────────────────────────────────

  test("host.internal routes to onHostEvent handler", async () => {
    const kv = createMockKv();
    const handler = vi.fn();
    const adapter = buildNetworkAdapter(kv, handler);

    const result = await adapter.fetch("http://host.internal/session/event", {
      method: "POST",
      headers: { "x-session-id": "sess-1" },
      body: JSON.stringify({ type: "turn" }),
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith("/session/event", JSON.stringify({ type: "turn" }), {
      "x-session-id": "sess-1",
    });
  });

  test("host.internal returns 500 when no handler configured", async () => {
    const kv = createMockKv();
    // No onHostEvent handler provided
    const adapter = buildNetworkAdapter(kv);

    const result = await adapter.fetch("http://host.internal/event", {
      method: "POST",
      body: "{}",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: "Host event handler not configured",
    });
  });

  test("host.internal passes null body when not provided", async () => {
    const kv = createMockKv();
    const handler = vi.fn();
    const adapter = buildNetworkAdapter(kv, handler);

    await adapter.fetch("http://host.internal/ping", {
      method: "POST",
    });

    expect(handler).toHaveBeenCalledWith("/ping", null, {});
  });

  // ── KV isolation via adapter ────────────────────────────────────────

  test("KV adapter does not allow access outside its scoped instance", async () => {
    // Two adapters with different KV instances simulate two agents
    const kvAlpha = createMockKv();
    const kvBeta = createMockKv();

    const adapterAlpha = buildNetworkAdapter(kvAlpha);
    const adapterBeta = buildNetworkAdapter(kvBeta);

    // Alpha writes
    await adapterAlpha.fetch("http://kv.internal/set", {
      method: "POST",
      body: JSON.stringify({ key: "shared-name", value: "alpha-data" }),
    });

    // Beta reads the same key name — should hit beta's KV, not alpha's
    const result = await adapterBeta.fetch("http://kv.internal/get", {
      method: "POST",
      body: JSON.stringify({ key: "shared-name" }),
    });

    // Beta's KV was never written to, so it returns null
    expect(JSON.parse(result.body)).toBeNull();
    // Alpha's KV got the set call
    expect(kvAlpha.set).toHaveBeenCalledWith("shared-name", "alpha-data", undefined);
    // Beta's KV only got the get call
    expect(kvBeta.set).not.toHaveBeenCalled();
  });

  test("KV set with expireIn passes options through", async () => {
    const kv = createMockKv();
    const adapter = buildNetworkAdapter(kv);

    await adapter.fetch("http://kv.internal/set", {
      method: "POST",
      body: JSON.stringify({ key: "ttl-key", value: "data", options: { expireIn: 60_000 } }),
    });

    expect(kv.set).toHaveBeenCalledWith("ttl-key", "data", { expireIn: 60_000 });
  });
});

// ── KV Bridge Schemas (isolate -> host) ────────────────────────────────

describe("KV bridge schemas", () => {
  const { KvGetSchema, KvSetSchema, KvDelSchema, KvListSchema, KvKeysSchema } = _kvSchemas;

  // ── KvGetSchema ──

  test("KvGetSchema accepts valid key", () => {
    expect(KvGetSchema.safeParse({ key: "mykey" }).success).toBe(true);
  });

  test("KvGetSchema rejects missing key", () => {
    expect(KvGetSchema.safeParse({}).success).toBe(false);
  });

  test("KvGetSchema rejects non-string key", () => {
    expect(KvGetSchema.safeParse({ key: 42 }).success).toBe(false);
    expect(KvGetSchema.safeParse({ key: null }).success).toBe(false);
  });

  test("KvGetSchema rejects non-object", () => {
    expect(KvGetSchema.safeParse("key").success).toBe(false);
  });

  // ── KvSetSchema ──

  test("KvSetSchema accepts key + value", () => {
    expect(KvSetSchema.safeParse({ key: "k", value: "v" }).success).toBe(true);
  });

  test("KvSetSchema accepts complex values", () => {
    expect(KvSetSchema.safeParse({ key: "k", value: { nested: true } }).success).toBe(true);
    expect(KvSetSchema.safeParse({ key: "k", value: [1, 2, 3] }).success).toBe(true);
    expect(KvSetSchema.safeParse({ key: "k", value: null }).success).toBe(true);
  });

  test("KvSetSchema accepts options with expireIn", () => {
    expect(
      KvSetSchema.safeParse({ key: "k", value: "v", options: { expireIn: 5000 } }).success,
    ).toBe(true);
  });

  test("KvSetSchema rejects non-positive expireIn", () => {
    expect(KvSetSchema.safeParse({ key: "k", value: "v", options: { expireIn: 0 } }).success).toBe(
      false,
    );
    expect(KvSetSchema.safeParse({ key: "k", value: "v", options: { expireIn: -1 } }).success).toBe(
      false,
    );
  });

  test("KvSetSchema rejects non-integer expireIn", () => {
    expect(
      KvSetSchema.safeParse({ key: "k", value: "v", options: { expireIn: 1.5 } }).success,
    ).toBe(false);
  });

  test("KvSetSchema rejects missing key", () => {
    expect(KvSetSchema.safeParse({ value: "v" }).success).toBe(false);
  });

  // ── KvDelSchema ──

  test("KvDelSchema accepts valid key", () => {
    expect(KvDelSchema.safeParse({ key: "k" }).success).toBe(true);
  });

  test("KvDelSchema rejects missing key", () => {
    expect(KvDelSchema.safeParse({}).success).toBe(false);
  });

  // ── KvListSchema ──

  test("KvListSchema accepts prefix only", () => {
    expect(KvListSchema.safeParse({ prefix: "ns:" }).success).toBe(true);
    expect(KvListSchema.safeParse({ prefix: "" }).success).toBe(true);
  });

  test("KvListSchema accepts all options", () => {
    expect(KvListSchema.safeParse({ prefix: "", limit: 100, reverse: true }).success).toBe(true);
  });

  test("KvListSchema rejects missing prefix", () => {
    expect(KvListSchema.safeParse({}).success).toBe(false);
  });

  test("KvListSchema rejects non-positive limit", () => {
    expect(KvListSchema.safeParse({ prefix: "", limit: 0 }).success).toBe(false);
    expect(KvListSchema.safeParse({ prefix: "", limit: -5 }).success).toBe(false);
  });

  test("KvListSchema rejects non-boolean reverse", () => {
    expect(KvListSchema.safeParse({ prefix: "", reverse: "yes" }).success).toBe(false);
  });

  // ── KvKeysSchema ──

  test("KvKeysSchema accepts empty object", () => {
    expect(KvKeysSchema.safeParse({}).success).toBe(true);
  });

  test("KvKeysSchema accepts pattern", () => {
    expect(KvKeysSchema.safeParse({ pattern: "user:*" }).success).toBe(true);
  });

  test("KvKeysSchema rejects non-string pattern", () => {
    expect(KvKeysSchema.safeParse({ pattern: 42 }).success).toBe(false);
  });
});

// ── KV Bridge Invalid Payload Rejection ────────────────────────────────

describe("KV bridge rejects invalid payloads", () => {
  const { KvGetSchema, KvSetSchema, KvDelSchema, KvListSchema } = _kvSchemas;

  test("KV get rejects malformed body (missing key)", () => {
    expect(KvGetSchema.safeParse({}).success).toBe(false);
  });

  test("KV set rejects missing key field", () => {
    expect(KvSetSchema.safeParse({ value: "data" }).success).toBe(false);
  });

  test("KV del rejects missing key field", () => {
    expect(KvDelSchema.safeParse({}).success).toBe(false);
  });

  test("KV list rejects missing prefix", () => {
    expect(KvListSchema.safeParse({}).success).toBe(false);
  });

  test("KV set rejects non-string key", () => {
    expect(KvSetSchema.safeParse({ key: 42, value: "v" }).success).toBe(false);
  });

  test("KV list rejects non-integer limit", () => {
    expect(KvListSchema.safeParse({ prefix: "", limit: 1.5 }).success).toBe(false);
  });
});
