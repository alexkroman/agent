// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createCoalescingRunner } from "./coalescing-runner.ts";
// `sleep(0)` is the macrotask yield these tests need, and it is the SDK's ONE
// wait — so no local `tick` alias, and no inline
// `new Promise((r) => setTimeout(r, 0))` (`guard-invariants` rules 4 and 19).
// Imported from `sdk/` rather than `host/_test-utils.ts`, which re-exports the
// same helpers while pulling in the Node-only host graph.
import { sleep } from "./sleep.ts";

// Runs are gated with `Promise.withResolvers()` directly: the local `gate()`
// alias it replaces only renamed the tool's own bookkeeping.
describe("createCoalescingRunner", () => {
  test("an idle trigger runs immediately and resolves with the run's result", async () => {
    let runs = 0;
    const runner = createCoalescingRunner(async () => {
      runs += 1;
      return `run-${runs}`;
    });
    await expect(runner.trigger()).resolves.toBe("run-1");
    expect(runs).toBe(1);
  });

  test("triggers arriving after a run settles each start a fresh run", async () => {
    let runs = 0;
    const runner = createCoalescingRunner(async () => {
      runs += 1;
      return runs;
    });
    await expect(runner.trigger()).resolves.toBe(1);
    await expect(runner.trigger()).resolves.toBe(2);
    expect(runs).toBe(2);
  });

  test("N triggers during a run coalesce into ONE trailing run, shared by all", async () => {
    const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
    let runs = 0;
    const runner = createCoalescingRunner(() => {
      const g = gates[runs];
      runs += 1;
      if (!g) throw new Error(`unexpected run ${runs}`);
      return g.promise;
    });

    const first = runner.trigger();
    await sleep(0);
    expect(runs).toBe(1);

    const t1 = runner.trigger();
    const t2 = runner.trigger();
    const t3 = runner.trigger();
    // All mid-flight triggers share one trailing promise.
    expect(t2).toBe(t1);
    expect(t3).toBe(t1);
    // The trailing run has NOT started while the first is in flight.
    await sleep(0);
    expect(runs).toBe(1);

    gates[0]?.resolve("first");
    await expect(first).resolves.toBe("first");
    await sleep(0);
    expect(runs).toBe(2); // exactly one trailing run for three triggers

    gates[1]?.resolve("second");
    await expect(t1).resolves.toBe("second");
    expect(runs).toBe(2);
  });

  test("runs never overlap: the trailing run starts only after the current settles", async () => {
    const events: string[] = [];
    let release = Promise.withResolvers<void>();
    const runner = createCoalescingRunner(async () => {
      events.push("start");
      await release.promise;
      events.push("end");
    });

    const first = runner.trigger();
    await sleep(0);
    const trailing = runner.trigger();
    await sleep(0);
    expect(events).toEqual(["start"]); // second run not started

    const firstRelease = release;
    release = Promise.withResolvers<void>();
    firstRelease.resolve();
    await first;
    await sleep(0);
    expect(events).toEqual(["start", "end", "start"]);

    release.resolve();
    await trailing;
    expect(events).toEqual(["start", "end", "start", "end"]);
  });

  test("a rejected run reaches its own callers and does not wedge later triggers", async () => {
    let runs = 0;
    const runner = createCoalescingRunner(async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom");
      return runs;
    });
    await expect(runner.trigger()).rejects.toThrow("boom");
    await expect(runner.trigger()).resolves.toBe(2);
    expect(runs).toBe(2);
  });

  test("a rejected in-flight run still starts the trailing run, whose callers see only their own outcome", async () => {
    const first = Promise.withResolvers<string>();
    let runs = 0;
    const runner = createCoalescingRunner(async () => {
      runs += 1;
      if (runs === 1) return first.promise;
      return "trailing-ok";
    });

    const p1 = runner.trigger();
    await sleep(0);
    const p2 = runner.trigger();

    first.reject(new Error("first failed"));
    await expect(p1).rejects.toThrow("first failed");
    // The trailing callers are not poisoned by the first run's failure.
    await expect(p2).resolves.toBe("trailing-ok");
    expect(runs).toBe(2);
  });

  test("a synchronously-throwing run rejects the trigger promise instead of throwing", async () => {
    const runner = createCoalescingRunner<never>(() => {
      throw new Error("sync boom");
    });
    await expect(runner.trigger()).rejects.toThrow("sync boom");
    // And the runner is not wedged.
    await expect(runner.trigger()).rejects.toThrow("sync boom");
  });

  test("triggers during the trailing run coalesce into a new trailing run", async () => {
    const gates = [
      Promise.withResolvers<number>(),
      Promise.withResolvers<number>(),
      Promise.withResolvers<number>(),
    ];
    let runs = 0;
    const runner = createCoalescingRunner(() => {
      const g = gates[runs];
      runs += 1;
      if (!g) throw new Error(`unexpected run ${runs}`);
      return g.promise;
    });

    const p1 = runner.trigger();
    await sleep(0);
    const p2 = runner.trigger(); // trailing behind run 1
    gates[0]?.resolve(1);
    await p1;
    await sleep(0);
    expect(runs).toBe(2); // trailing run in flight

    const p3 = runner.trigger(); // trailing behind run 2
    const p4 = runner.trigger();
    expect(p4).toBe(p3);
    expect(p3).not.toBe(p2);

    gates[1]?.resolve(2);
    await expect(p2).resolves.toBe(2);
    await sleep(0);
    expect(runs).toBe(3);
    gates[2]?.resolve(3);
    await expect(p3).resolves.toBe(3);
  });
});
