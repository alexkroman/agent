// Copyright 2026 the AAI authors. MIT license.
// The concurrency bound behind POST /deploy's body handling (_semaphore.ts).

import { describe, expect, test } from "vitest";
import { createSemaphore } from "./_semaphore.ts";

/** Yield enough turns for queued acquires to settle. */
const flush = () => new Promise((r) => setImmediate(r));

describe("createSemaphore", () => {
  test("hands out up to `limit` slots immediately", async () => {
    const sem = createSemaphore(2);
    expect(await sem.acquire(50)).toBeTypeOf("function");
    expect(await sem.acquire(50)).toBeTypeOf("function");
    expect(sem.active).toBe(2);
  });

  test("a caller past the limit waits, then gets the released slot", async () => {
    const sem = createSemaphore(1);
    const first = await sem.acquire(1000);
    let granted = false;
    const second = sem.acquire(1000).then((slot) => {
      granted = slot !== null;
      return slot;
    });
    await flush();
    expect(granted).toBe(false);
    expect(sem.waiting).toBe(1);

    first?.();
    expect(await second).toBeTypeOf("function");
    expect(sem.waiting).toBe(0);
  });

  test("acquire resolves null once the wait lapses", async () => {
    const sem = createSemaphore(1);
    await sem.acquire(1000);
    expect(await sem.acquire(10)).toBeNull();
  });

  test("a lapsed waiter is dropped, not left to be handed a slot it can't release", async () => {
    // The deadlock this guards: hand the slot to a timed-out waiter and it is
    // gone for good, because that waiter already returned null to its caller.
    const sem = createSemaphore(1);
    const held = await sem.acquire(1000);
    expect(await sem.acquire(10)).toBeNull();
    expect(sem.waiting).toBe(0);

    held?.();
    expect(sem.active).toBe(0);
    expect(await sem.acquire(10)).toBeTypeOf("function");
  });

  test("release is idempotent — a double release does not free two slots", async () => {
    const sem = createSemaphore(1);
    const slot = await sem.acquire(50);
    slot?.();
    slot?.();
    expect(sem.active).toBe(0);
    await sem.acquire(50);
    expect(sem.active).toBe(1);
  });

  test("slots go to waiters in FIFO order", async () => {
    const sem = createSemaphore(1);
    const held = await sem.acquire(1000);
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      sem.acquire(1000).then((slot) => {
        order.push(n);
        return slot;
      }),
    );
    await flush();
    held?.();
    for (const w of waiters) (await w)?.();
    expect(order).toEqual([1, 2, 3]);
  });

  test("never exceeds the limit under a burst", async () => {
    const sem = createSemaphore(3);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        const slot = await sem.acquire(2000);
        peak = Math.max(peak, sem.active);
        await flush();
        slot?.();
      }),
    );
    expect(peak).toBe(3);
    expect(sem.active).toBe(0);
  });

  test("rejects a nonsense limit rather than silently unbounding", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createSemaphore(bad)).toThrow(/positive integer/);
    }
  });
});
