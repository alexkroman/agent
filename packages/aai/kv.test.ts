// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSqliteKv } from "./sqlite-kv.ts";

describe("createSqliteKv", () => {
  test("get returns null for missing key", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    expect(await kv.get("nope")).toBe(null);
  });

  test("set then get with auto-serialization", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("k1", { name: "alice", age: 30 });
    expect(await kv.get("k1")).toEqual({ name: "alice", age: 30 });
  });

  test("set then get with string value", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("k1", "hello");
    expect(await kv.get("k1")).toBe("hello");
  });

  test("set then get with number value", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("k1", 42);
    expect(await kv.get("k1")).toBe(42);
  });

  test("delete removes key", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("k1", "v1");
    await kv.delete("k1");
    expect(await kv.get("k1")).toBe(null);
  });

  test("list returns entries matching prefix", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("user:1", { name: "alice" });
    await kv.set("user:2", { name: "bob" });
    await kv.set("post:1", { title: "hello" });
    const entries = await kv.list("user:");
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({ key: "user:1", value: { name: "alice" } });
    expect(entries[1]).toEqual({ key: "user:2", value: { name: "bob" } });
  });

  test("list returns entries sorted by key", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("c", 3);
    await kv.set("a", 1);
    await kv.set("b", 2);
    const entries = await kv.list("");
    expect(entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  test("list with reverse", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { reverse: true });
    expect(entries.map((e) => e.key)).toEqual(["c", "b", "a"]);
  });

  test("list with limit", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { limit: 2 });
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.key)).toEqual(["a", "b"]);
  });

  test("list with reverse and limit", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.set("c", 3);
    const entries = await kv.list("", { limit: 2, reverse: true });
    expect(entries.map((e) => e.key)).toEqual(["c", "b"]);
  });

  test("keys returns all keys sorted", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("b", 2);
    await kv.set("a", 1);
    await kv.set("c", 3);
    expect(await kv.keys()).toEqual(["a", "b", "c"]);
  });

  test("keys with glob pattern", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("user:1", "alice");
    await kv.set("user:2", "bob");
    await kv.set("post:1", "hello");
    expect(await kv.keys("user:*")).toEqual(["user:1", "user:2"]);
  });

  test("keys excludes expired entries", async () => {
    vi.useFakeTimers();
    try {
      const kv = createSqliteKv({ path: ":memory:" });
      await kv.set("alive", "1");
      await kv.set("dying", "2", { expireIn: 5000 });
      vi.advanceTimersByTime(6000);
      expect(await kv.keys()).toEqual(["alive"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects oversized values", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    const big = "x".repeat(65_537);
    await expect(kv.set("big", big)).rejects.toThrow("exceeds max size");
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test("expireIn expires entries", async () => {
      const kv = createSqliteKv({ path: ":memory:" });
      await kv.set("temp", "val", { expireIn: 10_000 });
      expect(await kv.get("temp")).toBe("val");
      vi.advanceTimersByTime(11_000);
      expect(await kv.get("temp")).toBe(null);
    });

    test("expired entries excluded from list", async () => {
      const kv = createSqliteKv({ path: ":memory:" });
      await kv.set("alive", "1");
      await kv.set("dying", "2", { expireIn: 5000 });
      vi.advanceTimersByTime(6000);
      const entries = await kv.list("");
      expect(entries.length).toBe(1);
      expect(entries[0]?.key).toBe("alive");
    });
  });

  test("overwrite replaces value", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("k", "v1");
    await kv.set("k", "v2");
    expect(await kv.get("k")).toBe("v2");
  });

  test("separate instances have isolated stores", async () => {
    const kv1 = createSqliteKv({ path: ":memory:" });
    const kv2 = createSqliteKv({ path: ":memory:" });
    await kv1.set("x", "from1");
    expect(await kv2.get("x")).toBe(null);
  });

  test("get with generic type", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("user", { name: "alice", age: 30 });
    const user = await kv.get<{ name: string; age: number }>("user");
    expect(user?.name).toBe("alice");
    expect(user?.age).toBe(30);
  });

  test("list with generic type", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("item:1", { title: "first" });
    await kv.set("item:2", { title: "second" });
    const entries = await kv.list<{ title: string }>("item:");
    expect(entries[0]?.value.title).toBe("first");
    expect(entries[1]?.value.title).toBe("second");
  });

  test("keys glob rejects key shorter than pattern literal segments", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("a", "1");
    await kv.set("abc:xyz", "2");
    expect(await kv.keys("abc*xyz")).toEqual(["abc:xyz"]);
    expect(await kv.keys("abcdef*")).toEqual([]);
  });

  test("keys glob handles multi-wildcard patterns", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("a:b:c", "1");
    await kv.set("a:x:c", "2");
    await kv.set("b:x:c", "3");
    expect(await kv.keys("a*c")).toEqual(["a:b:c", "a:x:c"]);
    expect(await kv.keys("a*b*c")).toEqual(["a:b:c"]);
  });

  test("keys glob starting with wildcard scans all keys", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("foo:bar", "1");
    await kv.set("baz:bar", "2");
    await kv.set("foo:qux", "3");
    expect(await kv.keys("*:bar")).toEqual(["baz:bar", "foo:bar"]);
  });

  test("keys with plain prefix (no glob) returns matching keys", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("app:config:a", "1");
    await kv.set("app:config:b", "2");
    await kv.set("app:data:x", "3");
    expect(await kv.keys("app:config:")).toEqual(["app:config:a", "app:config:b"]);
  });

  test("close clears interval and closes database", async () => {
    const kv = createSqliteKv({ path: ":memory:" });
    await kv.set("k", "v");
    expect(await kv.get("k")).toBe("v");
    kv.close?.();
    // After close, database operations should throw
    expect(() => kv.get("k")).toThrow();
  });

  test("data persists across instances with same file", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = join(tmpdir(), `aai-kv-persist-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "test.db");
    try {
      const kv1 = createSqliteKv({ path: dbPath });
      await kv1.set("persist", "hello");
      const kv2 = createSqliteKv({ path: dbPath });
      expect(await kv2.get("persist")).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
