// Copyright 2026 the AAI authors. MIT license.
import pTimeout from "p-timeout";
import { describe, expect, it, vi } from "vitest";
import { createKeyedLock, KeyedLockTimeoutError } from "./keyed-lock.ts";
// `sdk/sleep.ts` rather than `host/_test-utils.ts`: this is an `sdk/` unit test,
// and that helper module re-exports `sleep` while itself importing
// `createRuntime`, `assemblyAIS2s` and `node:fs` — the whole host graph, pulled
// in for one wait.
import { sleep } from "./sleep.ts";

// Every drain assertion below is `vi.waitFor`, never a fixed number of
// `await Promise.resolve()`s: the invariant is "the map drains", not "the map
// drains within N microtasks". A fixed count matches the cleanup chain's
// CURRENT depth, so one added `await` inside the lock turns every one of them
// into a failure that reads as a per-key leak. (Inline rather than behind a
// helper — Biome's `noMisplacedAssertion` rules an `expect` outside a test
// body out, and it is right to.)

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

    // Bounded rather than plainly awaited, for the reason spelled out on the
    // sibling case below: a lock that never handed "k" to the second acquirer
    // would leave this promise pending and the test would HANG to the suite
    // timeout rather than failing on the claim in its own name.
    await pTimeout(Promise.all([first, second]), {
      milliseconds: 500,
      message: '"k" was never handed to the second acquirer',
    });
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block different keys on each other", async () => {
    const lock = createKeyedLock();
    const releaseA = await lock("a");

    // "b" must acquire while "a" is held. Bounded rather than plainly awaited: a
    // regression that made keys block each other would hang this `await` until
    // the suite timeout fired on a test whose name explains nothing, instead of
    // failing here with the reason. `p-timeout` rather than a hand-rolled race
    // against a timer (`guard-invariants` rule 3) — the losing branch's late
    // rejection and the dangling timer are exactly what gets re-derived wrong.
    const releaseB = await pTimeout(lock("b"), {
      milliseconds: 50,
      message: '"b" blocked behind the "a" lock',
    });
    expect(releaseB).toBeTypeOf("function");

    expect(lock.size).toBe(2);
    releaseB();
    releaseA();
    await vi.waitFor(() => {
      expect(lock.size).toBe(0);
    });
  });

  it("empties the map after all locks release (no per-key leak)", async () => {
    const lock = createKeyedLock();
    expect(lock.size).toBe(0);

    const releases = await Promise.all(Array.from({ length: 20 }, (_, i) => lock(`slug-${i}`)));
    expect(lock.size).toBe(20);

    for (const release of releases) release();
    await vi.waitFor(() => {
      expect(lock.size).toBe(0);
    });
  });

  it("keeps the entry while a later acquirer is still queued", async () => {
    const lock = createKeyedLock();
    const release1 = await lock("k");
    const pending2 = lock("k");

    release1();
    // Bounded, like the different-keys case above and for the same reason:
    // `await pending2` is the whole claim of this test, and a release that
    // failed to hand the key on leaves it pending — so the failure would be a
    // suite timeout on a test whose name explains nothing, rather than a
    // message naming what did not happen. `p-timeout` rather than a hand-rolled
    // race against a timer (`guard-invariants` rule 3).
    const release2 = await pTimeout(pending2, {
      milliseconds: 500,
      message: "the queued acquirer never got the key after release",
    });
    expect(lock.size).toBe(1);

    release2();
    await vi.waitFor(() => {
      expect(lock.size).toBe(0);
    });
  });

  it("release is idempotent", async () => {
    const lock = createKeyedLock();
    const release = await lock("k");
    release();
    release();
    await vi.waitFor(() => {
      expect(lock.size).toBe(0);
    });

    // The key is fully reusable afterwards.
    const again = await lock("k");
    again();
    await vi.waitFor(() => {
      expect(lock.size).toBe(0);
    });
  });
  describe("acquire deadline", () => {
    it("rejects a waiter that never gets the key", async () => {
      const lock = createKeyedLock();
      const release = await lock("k");

      await expect(lock("k", { timeoutMs: 5 })).rejects.toBeInstanceOf(KeyedLockTimeoutError);

      release();
    });

    it("resolves normally when the key frees inside the deadline", async () => {
      const lock = createKeyedLock();
      const release = await lock("k");
      const queued = lock("k", { timeoutMs: 1000 });
      release();

      const second = await queued;
      expect(typeof second).toBe("function");
      second();
      await vi.waitFor(() => {
        expect(lock.size).toBe(0);
      });
    });

    /**
     * The property that makes a deadline safe rather than a new deadlock.
     * Every acquirer appends its own release to the key's chain, so a waiter
     * that walks away WITHOUT resolving its slot leaves one that never frees —
     * and it is the last acquirer's `tail` the next one queues behind. Before
     * the give-up-our-place step, one timed-out waiter wedged the key for the
     * life of the process.
     */
    it("a timed-out waiter does not wedge the key for those behind it", async () => {
      const lock = createKeyedLock();
      const release = await lock("k");

      await expect(lock("k", { timeoutMs: 5 })).rejects.toBeInstanceOf(KeyedLockTimeoutError);
      // Queued AFTER the abandoned slot, so it inherits it.
      const behind = lock("k", { timeoutMs: 1000 });
      release();

      const acquired = await behind;
      acquired();
      await vi.waitFor(() => {
        expect(lock.size).toBe(0);
      });
    });

    it("leaks no entry once an abandoned key drains", async () => {
      const lock = createKeyedLock();
      const release = await lock("k");
      await expect(lock("k", { timeoutMs: 5 })).rejects.toThrow(KeyedLockTimeoutError);
      release();
      await vi.waitFor(() => {
        expect(lock.size).toBe(0);
      });
    });

    it("an uncontended key never waits on the deadline", async () => {
      const lock = createKeyedLock();
      // No holder, so this resolves on the spot — a deadline must not become
      // a floor on the common case.
      const release = await lock("free", { timeoutMs: 1 });
      release();
      await vi.waitFor(() => {
        expect(lock.size).toBe(0);
      });
    });
  });
});
