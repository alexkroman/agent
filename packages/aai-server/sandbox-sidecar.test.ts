// Copyright 2025 the AAI authors. MIT license.
import type { Kv } from "@alexkroman1/aai/kv";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _kvSchemas, createSidecar, type Sidecar } from "./sandbox-sidecar.ts";
import { createMockKv } from "./test-utils.ts";

const AUTH_TOKEN = "test-sidecar-token";

/** Helper to POST JSON to a sidecar endpoint. */
async function post(sidecar: Sidecar, path: string, body: unknown, token = AUTH_TOKEN) {
  const res = await fetch(`${sidecar.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// ── Sidecar server ─────────────────────────────────────────────────────

describe("createSidecar", () => {
  const sidecars: Sidecar[] = [];

  afterEach(async () => {
    await Promise.all(
      sidecars.map((s) =>
        s.close().catch(() => {
          /* ignore */
        }),
      ),
    );
    sidecars.length = 0;
  });

  async function startSidecar(kv?: Kv, handler?: Parameters<typeof createSidecar>[2]) {
    const s = await createSidecar(kv ?? createMockKv(), AUTH_TOKEN, handler);
    sidecars.push(s);
    return s;
  }

  test("starts and listens on loopback", async () => {
    const sidecar = await startSidecar();
    expect(sidecar.port).toBeGreaterThan(0);
    expect(sidecar.url).toBe(`http://127.0.0.1:${sidecar.port}`);
  });

  test("rejects requests without auth token", async () => {
    const sidecar = await startSidecar();
    const res = await fetch(`${sidecar.url}/kv/get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "test" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects requests with wrong auth token", async () => {
    const sidecar = await startSidecar();
    const { status } = await post(sidecar, "/kv/get", { key: "test" }, "wrong-token");
    expect(status).toBe(401);
  });

  test("rejects non-POST requests", async () => {
    const sidecar = await startSidecar();
    const res = await fetch(`${sidecar.url}/kv/get`, {
      method: "GET",
      headers: { "x-harness-token": AUTH_TOKEN },
    });
    expect(res.status).toBe(405);
  });

  test("returns 404 for unknown paths", async () => {
    const sidecar = await startSidecar();
    const { status } = await post(sidecar, "/unknown", {});
    expect(status).toBe(404);
  });

  // ── KV operations ──────────────────────────────────────────────────

  test("KV get returns value", async () => {
    const kv = createMockKv();
    kv.get = vi.fn(async () => ({ saved: true })) as Kv["get"];
    const sidecar = await startSidecar(kv);

    const { status, data } = await post(sidecar, "/kv/get", { key: "test-key" });
    expect(status).toBe(200);
    expect(data).toEqual({ saved: true });
    expect(kv.get).toHaveBeenCalledWith("test-key");
  });

  test("KV get returns null for missing key", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    const { status, data } = await post(sidecar, "/kv/get", { key: "missing" });
    expect(status).toBe(200);
    expect(data).toBeNull();
  });

  test("KV set stores value", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    const { status } = await post(sidecar, "/kv/set", { key: "k", value: "v" });
    expect(status).toBe(200);
    expect(kv.set).toHaveBeenCalledWith("k", "v", undefined);
  });

  test("KV set with expireIn passes options through", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    await post(sidecar, "/kv/set", {
      key: "ttl-key",
      value: "data",
      options: { expireIn: 60_000 },
    });
    expect(kv.set).toHaveBeenCalledWith("ttl-key", "data", { expireIn: 60_000 });
  });

  test("KV del removes key", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    const { status } = await post(sidecar, "/kv/del", { key: "k" });
    expect(status).toBe(200);
    expect(kv.delete).toHaveBeenCalledWith("k");
  });

  test("KV list returns entries", async () => {
    const kv = createMockKv();
    (kv.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: "k1", value: "v1" }]);
    const sidecar = await startSidecar(kv);
    const { status, data } = await post(sidecar, "/kv/list", { prefix: "" });
    expect(status).toBe(200);
    expect(data).toEqual([{ key: "k1", value: "v1" }]);
  });

  test("KV keys returns list", async () => {
    const kv = createMockKv();
    (kv.keys as ReturnType<typeof vi.fn>).mockResolvedValue(["k1", "k2"]);
    const sidecar = await startSidecar(kv);
    const { status, data } = await post(sidecar, "/kv/keys", {});
    expect(status).toBe(200);
    expect(data).toEqual(["k1", "k2"]);
  });

  test("unknown KV op returns 400", async () => {
    const sidecar = await startSidecar();
    const { status } = await post(sidecar, "/kv/unknown", {});
    expect(status).toBe(400);
  });

  test("invalid JSON body returns 400", async () => {
    const sidecar = await startSidecar();
    const res = await fetch(`${sidecar.url}/kv/get`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": AUTH_TOKEN },
      body: "not json{",
    });
    expect(res.status).toBe(400);
  });

  // ── Host event handling ────────────────────────────────────────────

  test("host event routes to handler", async () => {
    const handler = vi.fn();
    const sidecar = await startSidecar(undefined, handler);

    const { status, data } = await post(sidecar, "/host/session/event", { type: "turn" });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(
      "/session/event",
      JSON.stringify({ type: "turn" }),
      expect.objectContaining({ "x-harness-token": AUTH_TOKEN }),
    );
  });

  test("host event returns 500 when no handler configured", async () => {
    const sidecar = await startSidecar();
    const { status } = await post(sidecar, "/host/event", {});
    expect(status).toBe(500);
  });

  // ── KV isolation ───────────────────────────────────────────────────

  test("KV isolation between two sidecars", async () => {
    const kvAlpha = createMockKv();
    const kvBeta = createMockKv();

    const sidecarAlpha = await startSidecar(kvAlpha);
    const sidecarBeta = await startSidecar(kvBeta);

    await post(sidecarAlpha, "/kv/set", { key: "shared", value: "alpha-data" });
    const { data } = await post(sidecarBeta, "/kv/get", { key: "shared" });

    expect(data).toBeNull();
    expect(kvAlpha.set).toHaveBeenCalledWith("shared", "alpha-data", undefined);
    expect(kvBeta.set).not.toHaveBeenCalled();
  });

  // ── close() lifecycle ──────────────────────────────────────────────

  test("close() stops accepting connections", async () => {
    const sidecar = await startSidecar();
    const url = sidecar.url;
    await sidecar.close();
    // Remove from tracked list since we closed manually
    sidecars.splice(sidecars.indexOf(sidecar), 1);

    await expect(
      fetch(`${url}/kv/get`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-token": AUTH_TOKEN },
        body: JSON.stringify({ key: "k" }),
      }),
    ).rejects.toThrow();
  });

  // ── KV error handling ──────────────────────────────────────────────

  test("KV get returns 500 when kv.get throws", async () => {
    const kv = createMockKv();
    (kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("storage offline"));
    const sidecar = await startSidecar(kv);

    const { status, data } = await post(sidecar, "/kv/get", { key: "k" });
    expect(status).toBe(500);
    expect(data).toEqual({ error: "storage offline" });
  });

  test("KV set returns 500 when kv.set throws", async () => {
    const kv = createMockKv();
    (kv.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("write failed"));
    const sidecar = await startSidecar(kv);

    const { status, data } = await post(sidecar, "/kv/set", { key: "k", value: "v" });
    expect(status).toBe(500);
    expect(data).toEqual({ error: "write failed" });
  });

  // ── Host event error handling ──────────────────────────────────────

  test("host event returns 500 when handler throws", async () => {
    const handler = vi.fn(() => {
      throw new Error("handler crashed");
    });
    const sidecar = await startSidecar(undefined, handler);

    const { status, data } = await post(sidecar, "/host/event", {});
    expect(status).toBe(500);
    expect(data).toEqual({ error: "handler crashed" });
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
