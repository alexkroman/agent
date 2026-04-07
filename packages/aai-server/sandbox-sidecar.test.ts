// Copyright 2025 the AAI authors. MIT license.
import type { Kv } from "@alexkroman1/aai/kv";
import { KvRequestSchema } from "@alexkroman1/aai/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSidecar, type Sidecar } from "./sandbox-sidecar.ts";
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
    const res = await fetch(`${sidecar.url}/kv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "get", key: "test" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects requests with wrong auth token", async () => {
    const sidecar = await startSidecar();
    const { status } = await post(sidecar, "/kv", { op: "get", key: "test" }, "wrong-token");
    expect(status).toBe(401);
  });

  test("rejects non-POST requests", async () => {
    const sidecar = await startSidecar();
    const res = await fetch(`${sidecar.url}/kv`, {
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

    const { status, data } = await post(sidecar, "/kv", { op: "get", key: "test-key" });
    expect(status).toBe(200);
    expect(data).toEqual({ saved: true });
    expect(kv.get).toHaveBeenCalledWith("test-key");
  });

  test("KV get returns null for missing key", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    const { status, data } = await post(sidecar, "/kv", { op: "get", key: "missing" });
    expect(status).toBe(200);
    expect(data).toBeNull();
  });

  test("KV set stores value", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    const { status } = await post(sidecar, "/kv", { op: "set", key: "k", value: "v" });
    expect(status).toBe(200);
    expect(kv.set).toHaveBeenCalledWith("k", "v", undefined);
  });

  test("KV set with expireIn passes options through", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    await post(sidecar, "/kv", {
      op: "set",
      key: "ttl-key",
      value: "data",
      expireIn: 60_000,
    });
    expect(kv.set).toHaveBeenCalledWith("ttl-key", "data", { expireIn: 60_000 });
  });

  test("KV del removes key", async () => {
    const kv = createMockKv();
    const sidecar = await startSidecar(kv);
    const { status } = await post(sidecar, "/kv", { op: "del", key: "k" });
    expect(status).toBe(200);
    expect(kv.delete).toHaveBeenCalledWith("k");
  });

  test("KV list returns entries", async () => {
    const kv = createMockKv();
    (kv.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: "k1", value: "v1" }]);
    const sidecar = await startSidecar(kv);
    const { status, data } = await post(sidecar, "/kv", { op: "list", prefix: "" });
    expect(status).toBe(200);
    expect(data).toEqual([{ key: "k1", value: "v1" }]);
  });

  test("KV keys returns list", async () => {
    const kv = createMockKv();
    (kv.keys as ReturnType<typeof vi.fn>).mockResolvedValue(["k1", "k2"]);
    const sidecar = await startSidecar(kv);
    const { status, data } = await post(sidecar, "/kv", { op: "keys" });
    expect(status).toBe(200);
    expect(data).toEqual(["k1", "k2"]);
  });

  test("unknown KV op returns 400", async () => {
    const sidecar = await startSidecar();
    const { status } = await post(sidecar, "/kv", { op: "unknown" });
    expect(status).toBe(400);
  });

  test("invalid JSON body returns 400", async () => {
    const sidecar = await startSidecar();
    const res = await fetch(`${sidecar.url}/kv`, {
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

    const { status, data } = await post(sidecar, "/host/session/event", {
      type: "user_transcript",
    });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(
      "/session/event",
      JSON.stringify({ type: "user_transcript" }),
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

    await post(sidecarAlpha, "/kv", { op: "set", key: "shared", value: "alpha-data" });
    const { data } = await post(sidecarBeta, "/kv", { op: "get", key: "shared" });

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
      fetch(`${url}/kv`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-token": AUTH_TOKEN },
        body: JSON.stringify({ op: "get", key: "k" }),
      }),
    ).rejects.toThrow();
  });

  // ── KV error handling ──────────────────────────────────────────────

  test("KV get returns 500 when kv.get throws", async () => {
    const kv = createMockKv();
    (kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("storage offline"));
    const sidecar = await startSidecar(kv);

    const { status, data } = await post(sidecar, "/kv", { op: "get", key: "k" });
    expect(status).toBe(500);
    expect(data).toEqual({ error: "storage offline" });
  });

  test("KV set returns 500 when kv.set throws", async () => {
    const kv = createMockKv();
    (kv.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("write failed"));
    const sidecar = await startSidecar(kv);

    const { status, data } = await post(sidecar, "/kv", { op: "set", key: "k", value: "v" });
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

// ── KV Bridge Schema (KvRequestSchema from protocol.ts) ─────────────────

describe("KV bridge schema validation", () => {
  test("get accepts valid key", () => {
    expect(KvRequestSchema.safeParse({ op: "get", key: "mykey" }).success).toBe(true);
  });

  test("get rejects missing key", () => {
    expect(KvRequestSchema.safeParse({ op: "get" }).success).toBe(false);
  });

  test("get rejects empty key", () => {
    expect(KvRequestSchema.safeParse({ op: "get", key: "" }).success).toBe(false);
  });

  test("get rejects non-string key", () => {
    expect(KvRequestSchema.safeParse({ op: "get", key: 42 }).success).toBe(false);
  });

  test("set accepts key + value", () => {
    expect(KvRequestSchema.safeParse({ op: "set", key: "k", value: "v" }).success).toBe(true);
  });

  test("set accepts complex values", () => {
    expect(KvRequestSchema.safeParse({ op: "set", key: "k", value: "str" }).success).toBe(true);
  });

  test("set accepts expireIn", () => {
    expect(
      KvRequestSchema.safeParse({ op: "set", key: "k", value: "v", expireIn: 5000 }).success,
    ).toBe(true);
  });

  test("set rejects non-positive expireIn", () => {
    expect(
      KvRequestSchema.safeParse({ op: "set", key: "k", value: "v", expireIn: 0 }).success,
    ).toBe(false);
    expect(
      KvRequestSchema.safeParse({ op: "set", key: "k", value: "v", expireIn: -1 }).success,
    ).toBe(false);
  });

  test("set rejects non-integer expireIn", () => {
    expect(
      KvRequestSchema.safeParse({ op: "set", key: "k", value: "v", expireIn: 1.5 }).success,
    ).toBe(false);
  });

  test("set rejects missing key", () => {
    expect(KvRequestSchema.safeParse({ op: "set", value: "v" }).success).toBe(false);
  });

  test("del accepts valid key", () => {
    expect(KvRequestSchema.safeParse({ op: "del", key: "k" }).success).toBe(true);
  });

  test("del rejects missing key", () => {
    expect(KvRequestSchema.safeParse({ op: "del" }).success).toBe(false);
  });

  test("list accepts prefix only", () => {
    expect(KvRequestSchema.safeParse({ op: "list", prefix: "ns:" }).success).toBe(true);
    expect(KvRequestSchema.safeParse({ op: "list", prefix: "" }).success).toBe(true);
  });

  test("list accepts all options", () => {
    expect(
      KvRequestSchema.safeParse({ op: "list", prefix: "", limit: 100, reverse: true }).success,
    ).toBe(true);
  });

  test("list rejects missing prefix", () => {
    expect(KvRequestSchema.safeParse({ op: "list" }).success).toBe(false);
  });

  test("list rejects non-positive limit", () => {
    expect(KvRequestSchema.safeParse({ op: "list", prefix: "", limit: 0 }).success).toBe(false);
  });

  test("list rejects non-boolean reverse", () => {
    expect(KvRequestSchema.safeParse({ op: "list", prefix: "", reverse: "yes" }).success).toBe(
      false,
    );
  });

  test("keys accepts empty (no pattern)", () => {
    expect(KvRequestSchema.safeParse({ op: "keys" }).success).toBe(true);
  });

  test("keys accepts pattern", () => {
    expect(KvRequestSchema.safeParse({ op: "keys", pattern: "user:*" }).success).toBe(true);
  });

  test("keys rejects non-string pattern", () => {
    expect(KvRequestSchema.safeParse({ op: "keys", pattern: 42 }).success).toBe(false);
  });

  test("unknown op rejected", () => {
    expect(KvRequestSchema.safeParse({ op: "update", key: "k" }).success).toBe(false);
  });

  test("non-object rejected", () => {
    expect(KvRequestSchema.safeParse("key").success).toBe(false);
  });
});
