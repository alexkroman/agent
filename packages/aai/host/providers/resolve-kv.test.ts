// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, it } from "vitest";
import { fsKv } from "../../sdk/providers/kv/fs.ts";
import { memoryKv } from "../../sdk/providers/kv/memory.ts";
import { redisKv } from "../../sdk/providers/kv/redis.ts";
import { s3Kv } from "../../sdk/providers/kv/s3.ts";
import { resolveKv } from "./resolve-kv.ts";

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

  it("throws when s3Kv has no AWS creds", () => {
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
});
