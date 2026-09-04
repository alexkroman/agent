// Copyright 2026 the AAI authors. MIT license.
/**
 * The bound that replaced the workflow world's worker concurrency.
 *
 * Every case here is about a number that was INVISIBLE until a guest died of it:
 * a body's `mapConcurrent(32)` used to mean "32 queued jobs, three running", and
 * with steps executing inline it meant thirty-two running. What that looks like
 * is not a failing assertion anywhere — it is a microVM exiting five seconds
 * into a fan-out, with the run's own log showing the same segments starting over
 * on every boot.
 */

import { describe, expect, test } from "vitest";
import { flush, tick } from "./_test-utils.ts";
import {
  createStepGate,
  DEFAULT_STEP_CONCURRENCY,
  resolveStepConcurrency,
  STEP_CONCURRENCY_ENV,
} from "./workflow-step-gate.ts";

/** A task that never settles until told, recording when it started. */
function pending(started: number[], id: number) {
  const { promise, resolve } = Promise.withResolvers<number>();
  return {
    resolve: () => resolve(id),
    run: async () => {
      started.push(id);
      return promise;
    },
  };
}

describe("createStepGate", () => {
  test("admits only `limit` at once, however many the body opens", async () => {
    // The regression, at its smallest. A body that opens 32 gets 3 running.
    const started: number[] = [];
    const gate = createStepGate(3);
    const tasks = Array.from({ length: 32 }, (_, i) => pending(started, i));
    for (const task of tasks) void gate(task.run);
    await flush();
    expect(started).toEqual([0, 1, 2]);
  });

  test("hands a freed slot to the LONGEST waiter, so a fan-out starts in order", async () => {
    const started: number[] = [];
    const gate = createStepGate(2);
    const tasks = Array.from({ length: 5 }, (_, i) => pending(started, i));
    for (const task of tasks) void gate(task.run);
    await flush();
    expect(started).toEqual([0, 1]);

    tasks[0]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    tasks[1]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
  });

  test("NEVER admits limit + 1, which a decrement-then-wake handoff would", async () => {
    // The race the slot transfer exists for: freeing the slot and letting the
    // woken waiter re-take it leaves a window where a caller arriving fresh sees
    // room, takes it, and the waiter increments too. Once per release under a
    // fan-out, that drifts without bound.
    //
    // Reproduced by releasing and enqueueing in the same turn, which is exactly
    // what a body's `mapConcurrent` cursor does — it starts the next item from
    // the previous one's `.then`.
    const started: number[] = [];
    const gate = createStepGate(2);
    const first = Array.from({ length: 2 }, (_, i) => pending(started, i));
    for (const task of first) void gate(task.run);
    await flush();
    const queued = pending(started, 100);
    void gate(queued.run);

    // Free one and enqueue a fresh caller in the same turn.
    first[0]?.resolve();
    const fresh = pending(started, 200);
    void gate(fresh.run);
    await tick();

    // Three tasks have been admitted in total across the two slots, never four.
    expect(started.length).toBeLessThanOrEqual(3);
  });

  test("keeps strict FIFO order across a queue far wider than the gate", async () => {
    // The head CURSOR that replaced `waiting.shift()` is a performance change,
    // so what it owes is that it changed NOTHING else: the FIFO note on
    // `createStepGate` is a promise a reader watching a fan-out relies on, and a
    // cursor plus a compacting `splice` is exactly the kind of bookkeeping that
    // drops or reorders an entry at the boundary where the prefix is dropped.
    //
    // 200 wide rather than the 5 the ordering case above uses, so the compaction
    // runs many times over one queue rather than not at all.
    const started: number[] = [];
    const gate = createStepGate(1);
    const tasks = Array.from({ length: 200 }, (_, i) => pending(started, i));
    for (const task of tasks) void gate(task.run);
    await flush();
    expect(started).toEqual([0]);
    for (const task of tasks) {
      task.resolve();
      await tick();
    }
    // Every task ran, exactly once, in the order it was queued.
    expect(started).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  test("admits exactly `limit` again after a queue has fully drained", async () => {
    // The state the cursor could leave behind: a dead prefix, or a `head` past
    // the end of an array that is never reset, either of which loses the next
    // waiter silently rather than failing. Drain the gate completely, then queue
    // a second wave through the same one.
    const started: number[] = [];
    const gate = createStepGate(2);
    const first = Array.from({ length: 6 }, (_, i) => pending(started, i));
    for (const task of first) void gate(task.run);
    await flush();
    for (const task of first) {
      task.resolve();
      await tick();
    }
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);

    const second = Array.from({ length: 4 }, (_, i) => pending(started, 100 + i));
    for (const task of second) void gate(task.run);
    await flush();
    // Two, not one and not three: the drained queue left neither a stale waiter
    // holding a slot nor a leaked count.
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 100, 101]);
    second[0]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 100, 101, 102]);
  });

  test("a slot is released when the task THROWS, not just when it resolves", async () => {
    // A step that fails still holds a slot until it settles. Leaking one per
    // failure would shrink the gate to zero over a run against a flaky provider
    // — a wedge with no error attached to it.
    const gate = createStepGate(1);
    await expect(gate(() => Promise.reject(new Error("provider is down")))).rejects.toThrow(
      "provider is down",
    );
    await expect(gate(async () => "after")).resolves.toBe("after");
  });

  test("a step NESTED inside a step does not queue behind its own parent", async () => {
    // The deadlock, at its smallest. The outer step holds the only slot while it
    // awaits the inner one, and the inner one waits for a slot the outer will not
    // release until the inner returns. Nothing errors and nothing times out: the
    // gate is per ENGINE, so at the default width sixteen such steps wedge every
    // workflow in the process. A step already holding a slot runs its nested work
    // on that slot — see `createStepGate`.
    const gate = createStepGate(1);
    await expect(gate(async () => `outer(${await gate(async () => "inner")})`)).resolves.toBe(
      "outer(inner)",
    );
  });

  test("re-entrancy does NOT widen the bound for a caller that is not nested", async () => {
    // The other half of the fix: only work reached from INSIDE a slot-holder's
    // async context is exempt. A fresh caller still queues, so the measured bound
    // (`DEFAULT_STEP_CONCURRENCY`, and the memory it stands for) still holds.
    const started: string[] = [];
    const gate = createStepGate(1);
    const { promise: holdOuter, resolve: releaseOuter } = Promise.withResolvers<void>();
    const outer = gate(async () => {
      started.push("outer");
      await gate(async () => {
        started.push("nested");
      });
      await holdOuter;
    });
    // Enqueued from OUTSIDE the outer step's context — the fan-out case, not
    // nested work — so it must wait for the slot the outer one holds.
    const sibling = gate(async () => {
      started.push("sibling");
    });
    await tick();
    expect(started).toEqual(["outer", "nested"]);

    releaseOuter();
    await Promise.all([outer, sibling]);
    expect(started).toEqual(["outer", "nested", "sibling"]);
  });

  test("runs everything eventually, rather than dropping what it queued", async () => {
    const gate = createStepGate(2);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => gate(async () => i * 2)),
    );
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});

describe("resolveStepConcurrency", () => {
  test("defaults to what a guest was MEASURED to hold", () => {
    // Sixteen, pinned because the number is the finding: 26.1 MB per concurrent
    // segment at 48 kHz stereo against Modal's GUARANTEED 1024 MB reservation is
    // 576 MB at this width, 59% of usable. It was three — graphile-worker's
    // number, inherited to restore prior behaviour and never measured — which
    // capped every fan-out at three whatever the body asked for. The constant's
    // own doc carries the table and why the reservation rather than the cap.
    expect(resolveStepConcurrency({})).toBe(DEFAULT_STEP_CONCURRENCY);
    expect(DEFAULT_STEP_CONCURRENCY).toBe(16);
  });

  test("an operator can raise it", () => {
    // Above the default, so this cannot pass by accidentally reading it.
    expect(resolveStepConcurrency({ [STEP_CONCURRENCY_ENV]: "48" })).toBe(48);
  });

  test.each([
    ["zero", "0"],
    ["negative", "-4"],
    ["fractional", "2.5"],
    ["not a number", "lots"],
    ["empty", ""],
  ])("IGNORES a %s value rather than refusing to boot", (_label, value) => {
    // Read at engine construction, where there is no good way to fail — and a
    // typo'd knob must not stop an agent booting. The boot line reports the
    // resolved number, which is where a wrong value becomes visible.
    expect(resolveStepConcurrency({ [STEP_CONCURRENCY_ENV]: value })).toBe(
      DEFAULT_STEP_CONCURRENCY,
    );
  });
});
