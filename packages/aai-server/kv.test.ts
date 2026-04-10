// Copyright 2025 the AAI authors. MIT license.

import { createUnstorageKv } from "aai/runtime";
import type { Storage } from "unstorage";
import { beforeEach, describe, expect, test } from "vitest";
import { createTestStorage } from "./test-utils.ts";

describe("createUnstorageKv (scoped)", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createTestStorage();
  });

  test("get returns null for missing key", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/test-agent/kv" });
    const result = await kv.get("missing");
    expect(result).toBeNull();
  });

  test("set and get round-trip", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/test-agent/kv" });
    await kv.set("k1", "v1");
    const result = await kv.get("k1");
    expect(result).toBe("v1");
  });

  test("set and get with object value", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/test-agent/kv" });
    await kv.set("k1", { hello: "world" });
    const result = await kv.get("k1");
    expect(result).toEqual({ hello: "world" });
  });

  test("delete removes key", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/test-agent/kv" });
    await kv.set("k1", "v1");
    await kv.delete("k1");
    const result = await kv.get("k1");
    expect(result).toBeNull();
  });

  test("scoping isolates different agents", async () => {
    const kvA = createUnstorageKv({ storage, prefix: "agents/agent-a/kv" });
    const kvB = createUnstorageKv({ storage, prefix: "agents/agent-b/kv" });

    await kvA.set("key", "val-a");
    await kvB.set("key", "val-b");

    expect(await kvA.get("key")).toBe("val-a");
    expect(await kvB.get("key")).toBe("val-b");
  });
});
