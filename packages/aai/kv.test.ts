// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createMemoryKv } from "./kv.ts";

describe("createMemoryKv", () => {
  test("get returns null for missing key", async () => {
    const kv = createMemoryKv();
    expect(await kv.get("nope")).toBe(null);
  });

  test("set then get with auto-serialization", async () => {
    const kv = createMemoryKv();
    await kv.set("k1", { name: "alice", age: 30 });
    expect(await kv.get("k1")).toEqual({ name: "alice", age: 30 });
  });

  test("set then get with string value", async () => {
    const kv = createMemoryKv();
    await kv.set("k1", "hello");
    expect(await kv.get("k1")).toBe("hello");
  });

  test("set then get with number value", async () => {
    const kv = createMemoryKv();
    await kv.set("k1", 42);
    expect(await kv.get("k1")).toBe(42);
  });

  test("delete removes key", async () => {
    const kv = createMemoryKv();
    await kv.set("k1", "v1");
    await kv.delete("k1");
    expect(await kv.get("k1")).toBe(null);
  });

  test("delete removes multiple keys", async () => {
    const kv = createMemoryKv();
    await kv.set("k1", "v1");
    await kv.set("k2", "v2");
    await kv.set("k3", "v3");
    await kv.delete(["k1", "k3"]);
    expect(await kv.get("k1")).toBe(null);
    expect(await kv.get("k2")).toBe("v2");
    expect(await kv.get("k3")).toBe(null);
  });

  test("list returns entries matching prefix", async () => {
    const kv = createMemoryKv();
    await kv.set("user:1", { name: "alice" });
    await kv.set("user:2", { name: "bob" });
    await kv.set("post:1", { title: "hello" });
    const entries = await kv.list("user:");
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({ key: "user:1", value: { name: "alice" } });
    expect(entries[1]).toEqual({ key: "user:2", value: { name: "bob" } });
  });

  test("list returns entries sorted by key", async () => {
    const kv = createMemoryKv();
    await kv.set("c", 3);
    await kv.set("a", 1);
    await kv.set("b", 2);
    const entries = await kv.list("");
    expect(entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  test("list with reverse", async () => {
    const kv = createMemoryKv();
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { reverse: true });
    expect(entries.map((e) => e.key)).toEqual(["c", "b", "a"]);
  });

  test("list with limit", async () => {
    const kv = createMemoryKv();
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { limit: 2 });
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.key)).toEqual(["a", "b"]);
  });

  test("list with reverse and limit", async () => {
    const kv = createMemoryKv();
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { limit: 2, reverse: true });
    expect(entries.map((e) => e.key)).toEqual(["c", "b"]);
  });

  test("keys returns all keys sorted", async () => {
    const kv = createMemoryKv();
    await kv.set("b", 2);
    await kv.set("a", 1);
    await kv.set("c", 3);
    expect(await kv.keys()).toEqual(["a", "b", "c"]);
  });

  test("keys with glob pattern", async () => {
    const kv = createMemoryKv();
    await kv.set("user:1", "alice");
    await kv.set("user:2", "bob");
    await kv.set("post:1", "hello");
    expect(await kv.keys("user:*")).toEqual(["user:1", "user:2"]);
  });

  test("keys excludes expired entries", async () => {
    vi.useFakeTimers();
    const kv = createMemoryKv();
    await kv.set("alive", "1");
    await kv.set("dying", "2", { expireIn: 5000 });
    vi.advanceTimersByTime(6000);
    expect(await kv.keys()).toEqual(["alive"]);
    vi.useRealTimers();
  });

  test("rejects oversized values", async () => {
    const kv = createMemoryKv();
    const big = "x".repeat(65_537);
    await expect(kv.set("big", big)).rejects.toThrow("exceeds max size");
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test("expireIn expires entries", async () => {
      const kv = createMemoryKv();
      await kv.set("temp", "val", { expireIn: 10_000 });
      expect(await kv.get("temp")).toBe("val");
      vi.advanceTimersByTime(11_000);
      expect(await kv.get("temp")).toBe(null);
    });

    test("expired entries excluded from list", async () => {
      const kv = createMemoryKv();
      await kv.set("alive", "1");
      await kv.set("dying", "2", { expireIn: 5000 });
      vi.advanceTimersByTime(6000);
      const entries = await kv.list("");
      expect(entries.length).toBe(1);
      expect(entries[0]?.key).toBe("alive");
    });
  });

  test("overwrite replaces value", async () => {
    const kv = createMemoryKv();
    await kv.set("k", "v1");
    await kv.set("k", "v2");
    expect(await kv.get("k")).toBe("v2");
  });

  test("separate createMemoryKv calls have isolated stores", async () => {
    const kv1 = createMemoryKv();
    const kv2 = createMemoryKv();
    await kv1.set("x", "from1");
    expect(await kv2.get("x")).toBe(null);
  });

  test("get with generic type", async () => {
    const kv = createMemoryKv();
    await kv.set("user", { name: "alice", age: 30 });
    const user = await kv.get<{ name: string; age: number }>("user");
    expect(user?.name).toBe("alice");
    expect(user?.age).toBe(30);
  });

  test("list with generic type", async () => {
    const kv = createMemoryKv();
    await kv.set("item:1", { title: "first" });
    await kv.set("item:2", { title: "second" });
    const entries = await kv.list<{ title: string }>("item:");
    expect(entries[0]?.value.title).toBe("first");
    expect(entries[1]?.value.title).toBe("second");
  });

  test("keys glob rejects key shorter than pattern literal segments", async () => {
    const kv = createMemoryKv();
    await kv.set("a", "1");
    await kv.set("abc:xyz", "2");
    // Pattern "abc*xyz" requires at least 6 chars; "a" should not match
    expect(await kv.keys("abc*xyz")).toEqual(["abc:xyz"]);
    expect(await kv.keys("abcdef*")).toEqual([]);
  });

  test("keys glob handles multi-wildcard patterns", async () => {
    const kv = createMemoryKv();
    await kv.set("a:b:c", "1");
    await kv.set("a:x:c", "2");
    await kv.set("b:x:c", "3");
    expect(await kv.keys("a*c")).toEqual(["a:b:c", "a:x:c"]);
    expect(await kv.keys("a*b*c")).toEqual(["a:b:c"]);
  });

  describe("schema validation", () => {
    const UserSchema = z.object({ name: z.string(), age: z.number() });

    test("get with schema validates and returns typed value", async () => {
      const kv = createMemoryKv();
      await kv.set("user", { name: "alice", age: 30 });
      const user = await kv.get("user", UserSchema);
      expect(user).toEqual({ name: "alice", age: 30 });
    });

    test("get with schema returns null for missing key", async () => {
      const kv = createMemoryKv();
      const user = await kv.get("missing", UserSchema);
      expect(user).toBe(null);
    });

    test("get with schema throws on invalid data", async () => {
      const kv = createMemoryKv();
      await kv.set("bad", { name: 123 });
      await expect(kv.get("bad", UserSchema)).rejects.toThrow();
    });

    test("list with schema validates each entry", async () => {
      const kv = createMemoryKv();
      await kv.set("u:1", { name: "alice", age: 30 });
      await kv.set("u:2", { name: "bob", age: 25 });
      const entries = await kv.list("u:", undefined, UserSchema);
      expect(entries).toEqual([
        { key: "u:1", value: { name: "alice", age: 30 } },
        { key: "u:2", value: { name: "bob", age: 25 } },
      ]);
    });

    test("list with schema throws on invalid entry", async () => {
      const kv = createMemoryKv();
      await kv.set("u:1", { name: "alice", age: 30 });
      await kv.set("u:2", { name: 123 });
      await expect(kv.list("u:", undefined, UserSchema)).rejects.toThrow();
    });

    test("get without schema still works (trust-based cast)", async () => {
      const kv = createMemoryKv();
      await kv.set("user", { name: "alice", age: 30 });
      const user = await kv.get<{ name: string; age: number }>("user");
      expect(user).toEqual({ name: "alice", age: 30 });
    });
  });
});
