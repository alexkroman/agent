// Copyright 2025 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createMockToolContext } from "../host/_test-utils.ts";
import { createUnstorageKv } from "../host/unstorage-kv.ts";
import { memoryTools } from "./memory-tools.ts";

function setup() {
  const kv = createUnstorageKv({ storage: createStorage() });
  const tools = memoryTools();
  const ctx = createMockToolContext({ kv });
  return { kv, tools, ctx };
}

describe("memoryTools", () => {
  test("returns four tools", () => {
    const tools = memoryTools();
    expect(Object.keys(tools)).toEqual([
      "save_memory",
      "recall_memory",
      "list_memories",
      "forget_memory",
    ]);
  });

  describe("save_memory", () => {
    test("saves a value and returns the key", async () => {
      const { tools, ctx, kv } = setup();
      const result = await tools.save_memory.execute({ key: "user:name", value: "Alice" }, ctx);
      expect(result).toEqual({ saved: "user:name" });
      expect(await kv.get("user:name")).toBe("Alice");
    });

    test("saves an empty string value", async () => {
      const { tools, ctx, kv } = setup();
      const result = await tools.save_memory.execute({ key: "empty", value: "" }, ctx);
      expect(result).toEqual({ saved: "empty" });
      expect(await kv.get("empty")).toBe("");
    });

    test("overwrites an existing key", async () => {
      const { tools, ctx, kv } = setup();
      await tools.save_memory.execute({ key: "k", value: "v1" }, ctx);
      await tools.save_memory.execute({ key: "k", value: "v2" }, ctx);
      expect(await kv.get("k")).toBe("v2");
    });
  });

  describe("recall_memory", () => {
    test("returns found:true for existing key", async () => {
      const { tools, ctx } = setup();
      await tools.save_memory.execute({ key: "color", value: "blue" }, ctx);
      const result = await tools.recall_memory.execute({ key: "color" }, ctx);
      expect(result).toEqual({ found: true, key: "color", value: "blue" });
    });

    test("returns found:false for non-existent key", async () => {
      const { tools, ctx } = setup();
      const result = await tools.recall_memory.execute({ key: "missing" }, ctx);
      expect(result).toEqual({ found: false, key: "missing" });
    });

    test("returns found:false after key is forgotten", async () => {
      const { tools, ctx } = setup();
      await tools.save_memory.execute({ key: "tmp", value: "data" }, ctx);
      await tools.forget_memory.execute({ key: "tmp" }, ctx);
      const result = await tools.recall_memory.execute({ key: "tmp" }, ctx);
      expect(result).toEqual({ found: false, key: "tmp" });
    });
  });

  describe("list_memories", () => {
    test("lists all keys when no prefix", async () => {
      const { tools, ctx } = setup();
      await tools.save_memory.execute({ key: "a:1", value: "x" }, ctx);
      await tools.save_memory.execute({ key: "b:2", value: "y" }, ctx);
      const result = await tools.list_memories.execute({}, ctx);
      expect(result).toEqual({ count: 2, keys: ["a:1", "b:2"] });
    });

    test("filters keys by prefix", async () => {
      const { tools, ctx } = setup();
      await tools.save_memory.execute({ key: "user:name", value: "Alice" }, ctx);
      await tools.save_memory.execute({ key: "user:age", value: "30" }, ctx);
      await tools.save_memory.execute({ key: "project:status", value: "active" }, ctx);
      const result = (await tools.list_memories.execute({ prefix: "user:" }, ctx)) as {
        count: number;
        keys: string[];
      };
      expect(result.count).toBe(2);
      expect(result.keys).toContain("user:name");
      expect(result.keys).toContain("user:age");
    });

    test("returns empty when no keys match prefix", async () => {
      const { tools, ctx } = setup();
      await tools.save_memory.execute({ key: "a:1", value: "x" }, ctx);
      const result = await tools.list_memories.execute({ prefix: "z:" }, ctx);
      expect(result).toEqual({ count: 0, keys: [] });
    });

    test("lists all keys with empty string prefix", async () => {
      const { tools, ctx } = setup();
      await tools.save_memory.execute({ key: "x", value: "1" }, ctx);
      const result = await tools.list_memories.execute({ prefix: "" }, ctx);
      expect(result).toEqual({ count: 1, keys: ["x"] });
    });

    test("returns empty when store is empty", async () => {
      const { tools, ctx } = setup();
      const result = await tools.list_memories.execute({}, ctx);
      expect(result).toEqual({ count: 0, keys: [] });
    });
  });

  describe("forget_memory", () => {
    test("deletes an existing key", async () => {
      const { tools, ctx, kv } = setup();
      await tools.save_memory.execute({ key: "k", value: "v" }, ctx);
      const result = await tools.forget_memory.execute({ key: "k" }, ctx);
      expect(result).toEqual({ deleted: "k" });
      expect(await kv.get("k")).toBeNull();
    });

    test("no-ops when deleting a non-existent key", async () => {
      const { tools, ctx } = setup();
      const result = await tools.forget_memory.execute({ key: "nope" }, ctx);
      expect(result).toEqual({ deleted: "nope" });
    });
  });
});
