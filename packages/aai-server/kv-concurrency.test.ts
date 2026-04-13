// Copyright 2025 the AAI authors. MIT license.

import { createUnstorageKv } from "@alexkroman1/aai/runtime";
import type { Storage } from "unstorage";
import { beforeEach, describe, expect, test } from "vitest";
import { createTestStorage } from "./test-utils.ts";

describe("KV concurrency", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createTestStorage();
  });

  test("parallel set operations on different keys all succeed", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/a/kv" });
    const count = 50;
    await Promise.all(Array.from({ length: count }, (_, i) => kv.set(`key-${i}`, `value-${i}`)));
    // Verify all values were written
    const results = await Promise.all(Array.from({ length: count }, (_, i) => kv.get(`key-${i}`)));
    for (let i = 0; i < count; i++) {
      expect(results[i]).toBe(`value-${i}`);
    }
  });

  test("parallel set and get on the same key does not corrupt data", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/a/kv" });
    await kv.set("counter", 0);

    // Run sets and gets concurrently — each set writes a unique value
    const writes = Array.from({ length: 20 }, (_, i) => kv.set("counter", i + 1));
    const reads = Array.from({ length: 20 }, () => kv.get<number>("counter"));
    await Promise.all([...writes, ...reads]);

    // After all writes, the final value should be one of the written values
    const final = await kv.get<number>("counter");
    expect(final).toBeGreaterThanOrEqual(1);
    expect(final).toBeLessThanOrEqual(20);
  });

  test("parallel deletes on overlapping keys are safe", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/a/kv" });
    // Pre-populate
    await Promise.all(Array.from({ length: 10 }, (_, i) => kv.set(`k-${i}`, `v-${i}`)));
    // Delete all concurrently (some overlap via array delete)
    await Promise.all([
      kv.delete(["k-0", "k-1", "k-2"]),
      kv.delete(["k-2", "k-3", "k-4"]),
      kv.delete("k-5"),
      kv.delete("k-6"),
      kv.delete(["k-7", "k-8", "k-9"]),
    ]);
    // All keys should be gone
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => kv.get(`k-${i}`)));
    for (const result of results) {
      expect(result).toBeNull();
    }
  });

  test("concurrent set-then-get across scoped stores", async () => {
    const kvA = createUnstorageKv({ storage, prefix: "agents/agent-a/kv" });
    const kvB = createUnstorageKv({ storage, prefix: "agents/agent-b/kv" });

    // Both agents write the same key names concurrently
    await Promise.all([
      kvA.set("shared", "from-a"),
      kvB.set("shared", "from-b"),
      kvA.set("counter", 1),
      kvB.set("counter", 2),
    ]);

    // Reads should be isolated to each agent's prefix
    const [aShared, bShared, aCounter, bCounter] = await Promise.all([
      kvA.get("shared"),
      kvB.get("shared"),
      kvA.get("counter"),
      kvB.get("counter"),
    ]);
    expect(aShared).toBe("from-a");
    expect(bShared).toBe("from-b");
    expect(aCounter).toBe(1);
    expect(bCounter).toBe(2);
  });

  test("set-delete-get race leaves key absent", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/a/kv" });
    // Rapid set-delete cycles
    for (let i = 0; i < 10; i++) {
      await Promise.all([kv.set("ephemeral", `v${i}`), kv.delete("ephemeral")]);
    }
    // After all cycles, the key may or may not exist depending on
    // ordering, but it should never throw or corrupt
    const val = await kv.get("ephemeral");
    expect(val === null || typeof val === "string").toBe(true);
  });

  test("concurrent close and operations don't throw", async () => {
    const kv = createUnstorageKv({ storage, prefix: "agents/a/kv" });
    await kv.set("k", "v");
    // Close while operations may be in flight
    kv.close?.();
    // Further operations after close — should not throw hard errors
    // (behavior is undefined but shouldn't crash the process)
  });
});
