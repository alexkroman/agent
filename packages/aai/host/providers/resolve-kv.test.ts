// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fsKv } from "../../sdk/providers/kv/fs.ts";
import { memoryKv } from "../../sdk/providers/kv/memory.ts";
import { redisKv } from "../../sdk/providers/kv/redis.ts";
import { s3Kv } from "../../sdk/providers/kv/s3.ts";
import { resolveKv } from "./resolve-kv.ts";

// Intercept only the redis driver package (an optional peer dep that is not
// installed here); every other provider package loads for real.
const redisDriverFactory = vi.hoisted(() => vi.fn());
vi.mock("./resolve.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./resolve.ts")>();
  return {
    ...orig,
    loadProviderPackage: (name: string, label: string) =>
      name === "unstorage/drivers/redis"
        ? redisDriverFactory
        : orig.loadProviderPackage(name, label),
  };
});

describe("resolveKv", () => {
  it("resolves memoryKv to a working in-memory KV", async () => {
    const kv = resolveKv(memoryKv(), {}, "p");
    await kv.set("k", "v");
    expect(await kv.get("k")).toBe("v");
  });

  it("resolves fsKv with explicit base", () => {
    expect(() => resolveKv(fsKv({ base: "/tmp/aai-test" }), {}, "p")).not.toThrow();
  });

  it("resolves s3Kv when AWS creds are present", () => {
    expect(() =>
      resolveKv(
        s3Kv({ bucket: "b", endpoint: "https://e", region: "auto" }),
        {
          AWS_ACCESS_KEY_ID: "k",
          AWS_SECRET_ACCESS_KEY: "s",
        },
        "p",
      ),
    ).not.toThrow();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when s3Kv has no AWS creds", () => {
    // Hermetic: resolveApiKey falls back to process.env, so ambient AWS creds
    // (common in CI/cloud containers) would otherwise defeat this test.
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
    expect(() => resolveKv(s3Kv({ bucket: "b" }), {}, "p")).toThrow(/AWS_ACCESS_KEY_ID/);
  });

  it("resolves redisKv when REDIS_URL is present", () => {
    expect(() => resolveKv(redisKv(), { REDIS_URL: "redis://localhost:6379" }, "p")).not.toThrow();
  });

  it("throws when redisKv has no REDIS_URL", () => {
    expect(() => resolveKv(redisKv(), {}, "p")).toThrow(/REDIS_URL/);
  });

  it("throws on unknown kind", () => {
    expect(() => resolveKv({ kind: "nope", options: {} }, {}, "p")).toThrow(/Unknown KV provider/);
  });

  it("defers loading the redis driver until first I/O, then reuses it", async () => {
    const backing = new Map<string, unknown>();
    redisDriverFactory.mockReset().mockReturnValue({
      name: "fake-redis",
      hasItem: async (key: string) => backing.has(key),
      getItem: async (key: string) => backing.get(key) ?? null,
      setItem: async (key: string, value: unknown) => {
        backing.set(key, value);
      },
      removeItem: async (key: string) => {
        backing.delete(key);
      },
      getKeys: async () => [...backing.keys()],
    });

    const kv = resolveKv(redisKv(), { REDIS_URL: "redis://localhost:6379" }, "p");
    // Resolution alone must not touch the driver package — missing optional
    // peer deps should only surface at use-time.
    expect(redisDriverFactory).not.toHaveBeenCalled();

    await kv.set("k", { n: 1 });
    expect(redisDriverFactory).toHaveBeenCalledTimes(1);
    expect(redisDriverFactory).toHaveBeenCalledWith(
      expect.objectContaining({ url: "redis://localhost:6379" }),
    );

    expect(await kv.get("k")).toEqual({ n: 1 });
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
    // The resolved driver instance is cached across operations.
    expect(redisDriverFactory).toHaveBeenCalledTimes(1);
  });
});
