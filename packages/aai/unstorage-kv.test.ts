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

  test("list returns entries matching prefix", async () => {
    const kv = makeKv();
    await kv.set("user:1", { name: "alice" });
    await kv.set("user:2", { name: "bob" });
    await kv.set("post:1", { title: "hello" });
    const entries = await kv.list("user:");
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({ key: "user:1", value: { name: "alice" } });
    expect(entries[1]).toEqual({ key: "user:2", value: { name: "bob" } });
  });

  test("list returns entries sorted by key", async () => {
    const kv = makeKv();
    await kv.set("c", 3);
    await kv.set("a", 1);
    await kv.set("b", 2);
    const entries = await kv.list("");
    expect(entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  test("list with reverse", async () => {
    const kv = makeKv();
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { reverse: true });
    expect(entries.map((e) => e.key)).toEqual(["c", "b", "a"]);
  });

  test("list with limit", async () => {
    const kv = makeKv();
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { limit: 2 });
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.key)).toEqual(["a", "b"]);
  });

  test("list with reverse and limit", async () => {
    const kv = makeKv();
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { limit: 2, reverse: true });
    expect(entries.map((e) => e.key)).toEqual(["c", "b"]);
  });

  test("keys returns all keys sorted", async () => {
    const kv = makeKv();
    await kv.set("b", 2);
    await kv.set("a", 1);
    await kv.set("c", 3);
    expect(await kv.keys()).toEqual(["a", "b", "c"]);
  });

  test("keys with glob pattern", async () => {
    const kv = makeKv();
    await kv.set("user:1", "alice");
    await kv.set("user:2", "bob");
    await kv.set("post:1", "hello");
    expect(await kv.keys("user:*")).toEqual(["user:1", "user:2"]);
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

  test("list with generic type", async () => {
    const kv = makeKv();
    await kv.set("item:1", { title: "first" });
    await kv.set("item:2", { title: "second" });
    const entries = await kv.list<{ title: string }>("item:");
    expect(entries[0]?.value.title).toBe("first");
    expect(entries[1]?.value.title).toBe("second");
  });

  test("keys glob rejects key shorter than pattern literal segments", async () => {
    const kv = makeKv();
    await kv.set("a", "1");
    await kv.set("abc:xyz", "2");
    expect(await kv.keys("abc*xyz")).toEqual(["abc:xyz"]);
    expect(await kv.keys("abcdef*")).toEqual([]);
  });

  test("keys glob handles multi-wildcard patterns", async () => {
    const kv = makeKv();
    await kv.set("a:b:c", "1");
    await kv.set("a:x:c", "2");
    await kv.set("b:x:c", "3");
    expect(await kv.keys("a*c")).toEqual(["a:b:c", "a:x:c"]);
    expect(await kv.keys("a*b*c")).toEqual(["a:b:c"]);
  });

  test("keys glob starting with wildcard scans all keys", async () => {
    const kv = makeKv();
    await kv.set("foo:bar", "1");
    await kv.set("baz:bar", "2");
    await kv.set("foo:qux", "3");
    expect(await kv.keys("*:bar")).toEqual(["baz:bar", "foo:bar"]);
  });

  test("keys with plain prefix (no glob) returns matching keys", async () => {
    const kv = makeKv();
    await kv.set("app:config:a", "1");
    await kv.set("app:config:b", "2");
    await kv.set("app:data:x", "3");
    expect(await kv.keys("app:config:*")).toEqual(["app:config:a", "app:config:b"]);
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

    test("list with prefix scopes correctly", async () => {
      const storage = createStorage();
      const kv = createUnstorageKv({ storage, prefix: "agents/my-agent/kv" });
      await kv.set("user:1", "alice");
      await kv.set("user:2", "bob");
      const entries = await kv.list("user:");
      expect(entries.length).toBe(2);
      expect(entries[0]?.key).toBe("user:1");
    });

    test("keys with prefix strips prefix from results", async () => {
      const storage = createStorage();
      const kv = createUnstorageKv({ storage, prefix: "myprefix" });
      await kv.set("a", 1);
      await kv.set("b", 2);
      expect(await kv.keys()).toEqual(["a", "b"]);
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
