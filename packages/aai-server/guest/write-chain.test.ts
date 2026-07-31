// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createWriteChain } from "./write-chain.ts";

describe("createWriteChain", () => {
  test("writes run strictly in enqueue order", async () => {
    const chain = createWriteChain();
    const order: number[] = [];
    const gate = Promise.withResolvers<void>();
    const first = chain.enqueue(async () => {
      await gate.promise;
      order.push(1);
    });
    const second = chain.enqueue(async () => {
      order.push(2);
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  test("synchronous fast path: an accepted write chains nothing", async () => {
    let calls = 0;
    const chain = createWriteChain();
    // Returning undefined means "accepted outright" (no backpressure).
    await chain.enqueue(() => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  test("a failing write routes to onError and later writes still run", async () => {
    const errors: unknown[] = [];
    const chain = createWriteChain((err) => errors.push(err));
    const failed = chain.enqueue(() => Promise.reject(new Error("EPIPE")));
    let ran = false;
    const next = chain.enqueue(async () => {
      ran = true;
    });
    // enqueue's promises never reject — one bad write must not become an
    // unhandled rejection or wedge the serializer.
    await expect(failed).resolves.toBeUndefined();
    await next;
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("EPIPE");
  });

  test("a throwing onError does not poison the chain", async () => {
    const chain = createWriteChain(() => {
      throw new Error("logger exploded");
    });
    await chain.enqueue(() => Promise.reject(new Error("boom")));
    let ran = false;
    await chain.enqueue(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("the chain drains back to the fast path", async () => {
    const chain = createWriteChain();
    await chain.enqueue(() => Promise.resolve());
    // After draining, an accepted-outright write resolves without waiting on
    // any previous link (fast path restored).
    let sync = false;
    void chain.enqueue(() => {
      sync = true;
    });
    expect(sync).toBe(true);
  });
});
