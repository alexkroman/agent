// Copyright 2025 the AAI authors. MIT license.
import { MAX_VALUE_SIZE } from "@alexkroman1/aai/kv";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentScope } from "./scope-token.ts";

type StoreEntry = { value: string; px?: number | undefined };
const store = new Map<string, StoreEntry>();

const redisMethods = {
  scan: vi.fn(async (_cursor: string, opts: { match: string }) => {
    const pattern = opts.match.replace(/\*/g, ".*");
    const regex = new RegExp(`^${pattern}$`);
    const keys = [...store.keys()].filter((k) => regex.test(k));
    return ["0", keys] as [string, string[]];
  }),
  get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
  set: vi.fn(async (key: string, value: string, opts?: { px: number }) => {
    const entry: StoreEntry = { value };
    if (opts?.px !== undefined) entry.px = opts.px;
    store.set(key, entry);
  }),
  del: vi.fn(async (key: string) => {
    store.delete(key);
  }),
  pipeline: vi.fn(() => {
    const ops: string[] = [];
    return {
      get(key: string) {
        ops.push(key);
      },
      async exec() {
        return ops.map((k) => store.get(k)?.value ?? null);
      },
    };
  }),
};

vi.mock("@upstash/redis", () => ({
  Redis: class MockRedis {
    scan = redisMethods.scan;
    get = redisMethods.get;
    set = redisMethods.set;
    del = redisMethods.del;
    pipeline = redisMethods.pipeline;
  },
}));

const SCOPE: AgentScope = { keyHash: "abc", slug: "test-agent" };
const PREFIX = "kv:abc:test-agent:";

// Dynamic import so the mock is active
const { createKvStore } = await import("./kv.ts");

describe("createKvStore", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  test("get returns value for existing key", async () => {
    const kv = createKvStore("http://localhost", "token");
    store.set(`${PREFIX}mykey`, { value: "hello" });
    const result = await kv.get(SCOPE, "mykey");
    expect(result).toBe("hello");
    expect(redisMethods.get).toHaveBeenCalledWith(`${PREFIX}mykey`);
  });

  test("get returns null for missing key", async () => {
    const kv = createKvStore("http://localhost", "token");
    const result = await kv.get(SCOPE, "missing");
    expect(result).toBeNull();
  });

  test("set stores value without TTL", async () => {
    const kv = createKvStore("http://localhost", "token");
    await kv.set(SCOPE, "k1", "v1");
    expect(redisMethods.set).toHaveBeenCalledWith(`${PREFIX}k1`, "v1");
  });

  test("set stores value with TTL in milliseconds", async () => {
    const kv = createKvStore("http://localhost", "token");
    await kv.set(SCOPE, "k1", "v1", 5000);
    expect(redisMethods.set).toHaveBeenCalledWith(`${PREFIX}k1`, "v1", { px: 5000 });
  });

  test("set rejects value exceeding max size", async () => {
    const kv = createKvStore("http://localhost", "token");
    const largeValue = "x".repeat(MAX_VALUE_SIZE + 1);
    await expect(kv.set(SCOPE, "k1", largeValue)).rejects.toThrow("exceeds max size");
  });

  test("del removes key", async () => {
    const kv = createKvStore("http://localhost", "token");
    await kv.del(SCOPE, "k1");
    expect(redisMethods.del).toHaveBeenCalledWith(`${PREFIX}k1`);
  });

  test("keys returns stripped keys matching pattern", async () => {
    const kv = createKvStore("http://localhost", "token");
    store.set(`${PREFIX}note:1`, { value: "a" });
    store.set(`${PREFIX}note:2`, { value: "b" });

    const keys = await kv.keys(SCOPE, "note:*");
    expect(redisMethods.scan).toHaveBeenCalledWith("0", { match: `${PREFIX}note:*` });
    expect(keys).toEqual(expect.arrayContaining(["note:1", "note:2"]));
  });

  test("keys without pattern uses wildcard", async () => {
    const kv = createKvStore("http://localhost", "token");
    await kv.keys(SCOPE);
    expect(redisMethods.scan).toHaveBeenCalledWith("0", { match: `${PREFIX}*` });
  });

  test("list returns entries sorted with parsed JSON values", async () => {
    const kv = createKvStore("http://localhost", "token");
    store.set(`${PREFIX}note:a`, { value: JSON.stringify({ text: "first" }) });
    store.set(`${PREFIX}note:b`, { value: JSON.stringify({ text: "second" }) });
    store.set(`${PREFIX}note:c`, { value: "raw-string" });

    const entries = await kv.list(SCOPE, "note:");
    expect(entries).toHaveLength(3);
    expect(entries).toMatchObject([
      { key: "note:a", value: { text: "first" } },
      { key: "note:b", value: { text: "second" } },
      { key: "note:c", value: "raw-string" },
    ]);
  });

  test("list returns empty array for no matches", async () => {
    const kv = createKvStore("http://localhost", "token");
    const entries = await kv.list(SCOPE, "nothing:");
    expect(entries).toEqual([]);
  });

  test("list respects limit option", async () => {
    const kv = createKvStore("http://localhost", "token");
    store.set(`${PREFIX}item:a`, { value: '"v1"' });
    store.set(`${PREFIX}item:b`, { value: '"v2"' });
    store.set(`${PREFIX}item:c`, { value: '"v3"' });

    const entries = await kv.list(SCOPE, "item:", { limit: 2 });
    expect(entries).toHaveLength(2);
  });

  test("list respects reverse option", async () => {
    const kv = createKvStore("http://localhost", "token");
    store.set(`${PREFIX}item:a`, { value: '"v1"' });
    store.set(`${PREFIX}item:b`, { value: '"v2"' });

    const entries = await kv.list(SCOPE, "item:", { reverse: true });
    expect(entries).toMatchObject([{ key: "item:b" }, { key: "item:a" }]);
  });

  test("set ignores zero or negative TTL", async () => {
    const kv = createKvStore("http://localhost", "token");
    await kv.set(SCOPE, "k1", "v1", 0);
    expect(redisMethods.set).toHaveBeenCalledWith(`${PREFIX}k1`, "v1");

    await kv.set(SCOPE, "k2", "v2", -100);
    expect(redisMethods.set).toHaveBeenCalledWith(`${PREFIX}k2`, "v2");
  });

  test("scoping isolates different agents", async () => {
    const kv = createKvStore("http://localhost", "token");
    const scope1: AgentScope = { keyHash: "hash1", slug: "agent-a" };
    const scope2: AgentScope = { keyHash: "hash2", slug: "agent-b" };

    await kv.set(scope1, "key", "val1");
    await kv.set(scope2, "key", "val2");

    expect(redisMethods.set).toHaveBeenCalledWith("kv:hash1:agent-a:key", "val1");
    expect(redisMethods.set).toHaveBeenCalledWith("kv:hash2:agent-b:key", "val2");
  });

  test("list skips null values from pipeline", async () => {
    const kv = createKvStore("http://localhost", "token");
    store.set(`${PREFIX}item:a`, { value: '"val"' });
    // Simulate a key that scan returns but pipeline GET returns null for (expired between scan and get)
    redisMethods.scan.mockResolvedValueOnce(["0", [`${PREFIX}item:a`, `${PREFIX}item:gone`]]);
    redisMethods.pipeline.mockReturnValueOnce({
      get(_key: string) {
        // no-op for pipeline mock
      },
      async exec() {
        return ['"val"', null];
      },
    });

    const entries = await kv.list(SCOPE, "item:");
    expect(entries).toHaveLength(1);
    expect(entries).toMatchObject([{ key: "item:a" }]);
  });
});
