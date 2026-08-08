// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, it } from "vitest";
import { createKeyedLock } from "./_keyed-lock.ts";
import { sleep } from "./_sleep.ts";

/** Yield enough microtasks for the lock's internal cleanup chains to run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("createKeyedLock", () => {
  it("serializes holders of the same key in acquisition order", async () => {
    const lock = createKeyedLock();
    const events: string[] = [];

    const first = lock("k").then(async (release) => {
      events.push("first:start");
      await sleep(10);
      events.push("first:end");
      release();
    });
    const second = lock("k").then((release) => {
      events.push("second:start");
      release();
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block different keys on each other", async () => {
    const lock = createKeyedLock();
    const releaseA = await lock("a");

    // "b" must acquire while "a" is held. Raced against a real timer rather
    // than plainly awaited: a regression that made keys block each other
    // would hang this `await` until the suite timeout fired on a test whose
    // name explains nothing, instead of failing here with the reason.
    const releaseB = await Promise.race([lock("b"), sleep(50).then(() => null)]);
    expect(releaseB, '"b" blocked behind the "a" lock').not.toBeNull();

    expect(lock.size).toBe(2);
    releaseB?.();
    releaseA();
    await flushMicrotasks();
    expect(lock.size).toBe(0);
  });

  it("empties the map after all locks release (no per-key leak)", async () => {
    const lock = createKeyedLock();
    expect(lock.size).toBe(0);

    const releases = await Promise.all(Array.from({ length: 20 }, (_, i) => lock(`slug-${i}`)));
    expect(lock.size).toBe(20);

    for (const release of releases) release();
    await flushMicrotasks();
    expect(lock.size).toBe(0);
  });

  it("keeps the entry while a later acquirer is still queued", async () => {
    const lock = createKeyedLock();
    const release1 = await lock("k");
    const pending2 = lock("k");

    release1();
    const release2 = await pending2;
    expect(lock.size).toBe(1);

    release2();
    await flushMicrotasks();
    expect(lock.size).toBe(0);
  });

  it("release is idempotent", async () => {
    const lock = createKeyedLock();
    const release = await lock("k");
    release();
    release();
    await flushMicrotasks();
    expect(lock.size).toBe(0);

    // The key is fully reusable afterwards.
    const again = await lock("k");
    again();
    await flushMicrotasks();
    expect(lock.size).toBe(0);
  });
});
