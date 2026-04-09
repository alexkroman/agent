// Copyright 2025 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createUnstorageKv } from "./unstorage-kv.ts";

function makeKv(prefix?: string) {
  const opts = prefix != null ? { storage: createStorage(), prefix } : { storage: createStorage() };
  return createUnstorageKv(opts);
}

describe("createUnstorageKv", () => {
  test("get returns null for missing key", async () => {
    const kv = makeKv();
    expect(await kv.get("nope")).toBe(null);
  });

  test("set then get with auto-serialization", async () => {
    const kv = makeKv();
    await kv.set("k1", { name: "alice", age: 30 });
    expect(await kv.get("k1")).toEqual({ name: "alice", age: 30 });
  });

  test("set then get with string value", async () => {
    const kv = makeKv();
    await kv.set("k1", "hello");
    expect(await kv.get("k1")).toBe("hello");
  });

  test("set then get with number value", async () => {
    const kv = makeKv();
    await kv.set("k1", 42);
    expect(await kv.get("k1")).toBe(42);
  });

  test("delete removes key", async () => {
    const kv = makeKv();
    await kv.set("k1", "v1");
    await kv.delete("k1");
    expect(await kv.get("k1")).toBe(null);
  });

  test("rejects oversized values", async () => {
    const kv = makeKv();
    const big = "x".repeat(65_537);
    await expect(kv.set("big", big)).rejects.toThrow("exceeds max size");
  });

  test("set with expireIn passes ttl to driver", async () => {
    const kv = makeKv();
    await kv.set("temp", "val", { expireIn: 10_000 });
    expect(await kv.get("temp")).toBe("val");
  });

  test("overwrite replaces value", async () => {
    const kv = makeKv();
    await kv.set("k", "v1");
    await kv.set("k", "v2");
    expect(await kv.get("k")).toBe("v2");
  });

  test("separate instances have isolated stores", async () => {
    const kv1 = makeKv();
    const kv2 = makeKv();
    await kv1.set("x", "from1");
    expect(await kv2.get("x")).toBe(null);
  });

  test("get with generic type", async () => {
    const kv = makeKv();
    await kv.set("user", { name: "alice", age: 30 });
    const user = await kv.get<{ name: string; age: number }>("user");
    expect(user?.name).toBe("alice");
    expect(user?.age).toBe(30);
  });

  describe("with prefix", () => {
    test("prefix isolates keys", async () => {
      const storage = createStorage();
      const kv1 = createUnstorageKv({ storage, prefix: "ns1" });
      const kv2 = createUnstorageKv({ storage, prefix: "ns2" });
      await kv1.set("key", "from-ns1");
      await kv2.set("key", "from-ns2");
      expect(await kv1.get("key")).toBe("from-ns1");
      expect(await kv2.get("key")).toBe("from-ns2");
    });
  });

  test("delete with array of keys", async () => {
    const kv = makeKv();
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    await kv.delete(["a", "c"]);
    expect(await kv.get("a")).toBe(null);
    expect(await kv.get("b")).toBe(2);
    expect(await kv.get("c")).toBe(null);
  });
});
