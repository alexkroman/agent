/**
 * The lock itself, driven directly.
 *
 * `agent.test.ts` asserts what it BUYS — two re-scores in one step counting two
 * rounds, two screenings spending twenty-four evaluations without interleaving.
 * This is the property underneath both, stated where a reader can see it
 * without twelve model calls in the way.
 */

import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import { screeningsInFlight, withScreening } from "./screening-lock.ts";

describe("the screening lock", () => {
  test("a second screening on one call starts only when the first has finished", async () => {
    const ctx = createToolContext();
    const order: string[] = [];
    const first = Promise.withResolvers<void>();

    const a = withScreening(ctx, async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
      return "a";
    });
    const b = withScreening(ctx, async () => {
      order.push("b:start");
      return "b";
    });

    // Both were issued; only the first is running. This is the whole point —
    // without the lock `b` would already have read the state `a` is about to
    // overwrite.
    await vi.waitFor(() => {
      expect(order).toEqual(["a:start"]);
    });

    first.resolve();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  test("two calls never wait on each other, and the key is dropped when it drains", async () => {
    const one = createToolContext();
    const two = createToolContext();
    const started: string[] = [];
    const held = Promise.withResolvers<void>();

    const slow = withScreening(one, async () => {
      started.push("one");
      await held.promise;
    });
    // Two hiring managers screening at once are two sessions, so the second
    // runs to completion while the first is still scoring.
    await withScreening(two, async () => {
      started.push("two");
    });
    expect(started).toEqual(["one", "two"]);

    held.resolve();
    await slow;
    // No entry per session left behind: the lock drops a key once its chain
    // drains, which is what makes it safe on a long-lived server.
    await vi.waitFor(() => {
      expect(screeningsInFlight()).toBe(0);
    });
  });

  test("a run that throws still releases, so the next screening is not stranded", async () => {
    const ctx = createToolContext();
    await expect(
      withScreening(ctx, () => Promise.reject(new Error("the gateway said no"))),
    ).rejects.toThrow("the gateway said no");

    expect(await withScreening(ctx, () => Promise.resolve("after"))).toBe("after");
  });
});
