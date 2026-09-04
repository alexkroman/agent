// Copyright 2026 the AAI authors. MIT license.
/**
 * The dispatcher that closes the loop.
 *
 * `createWorkflowEngine`'s own specs drive `start` and `execute` separately,
 * which is what that separation is for — so what is left to pin here is that
 * something actually connects them, and the three ways a timer can be wrong: a
 * delay past `setTimeout`'s 32-bit ceiling, a pending delivery outliving the
 * engine, and a rejection escaping into a timer callback.
 */

import { type WorkflowContext, workflow } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { makeLogger, tick } from "./_test-utils.ts";
import {
  createInProcessWorkflowEngine,
  type InProcessWorkflowEngine,
} from "./workflow-in-process.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { watchRun } from "./workflow-run-reads.ts";

/** An engine over an inspectable journal, with a real dispatcher. */
function harness(
  run: (input: Record<string, unknown>, ctx: WorkflowContext) => unknown,
  journal: JournalStore = createMemoryJournal(),
): {
  engine: InProcessWorkflowEngine;
  journal: JournalStore;
  logger: ReturnType<typeof makeLogger>;
} {
  const logger = makeLogger();
  const engine = createInProcessWorkflowEngine({
    workflows: { digest: workflow({ description: "digest", run }) },
    journal,
    logger,
  });
  return { engine, journal, logger };
}

describe("a started run", () => {
  test("is executed without anybody calling execute", async () => {
    const { engine } = harness(() => "done");
    const runId = await engine.start("digest", [{}]);

    // The delivery is scheduled on a timer, so it lands on a later turn — which
    // is the point: `start` is called from inside a tool's `execute` and must not
    // run the whole body there.
    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    });
    expect(await engine.readOutput(runId)).toBe("done");
  });

  test("mints an id in the grammar the run routes accept", async () => {
    const { engine } = harness(() => "done");
    const runId = await engine.start("digest", [{}]);
    // `_workflow-run-id.ts` refuses `.`, `/` and `\` at the router, so an id
    // carrying one would 400 every read of a run that exists.
    expect(runId).toMatch(/^wrun_[0-9a-f]{32}$/);
  });

  test("gives two runs different ids", async () => {
    const { engine } = harness(() => "done");
    const [a, b] = await Promise.all([engine.start("digest", [{}]), engine.start("digest", [{}])]);
    expect(a).not.toBe(b);
  });
});

describe("a suspended run", () => {
  test("comes back when its sleep elapses", async () => {
    const after = vi.fn(() => "resumed");
    const { engine } = harness(async (_input, ctx) => {
      // Short enough to observe, long enough that the first delivery really does
      // suspend rather than walking straight through.
      await ctx.sleep("nap", 20);
      return ctx.step("after", after);
    });
    const runId = await engine.start("digest", [{}]);

    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    });
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("is re-delivered by a signal, with no timer involved", async () => {
    const { engine } = harness(async (_input, ctx) => {
      const answer = await ctx.waitFor<{ ok: boolean }>("tok_gate");
      return answer.ok;
    });
    const runId = await engine.start("digest", [{}]);

    // Parked with no deadline: nothing but the signal can end this, so a run
    // still `running` after the first delivery is the precondition.
    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
    });

    expect(await engine.signal("tok_gate", { ok: true })).toBe(true);
    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    });
    expect(await engine.readOutput(runId)).toBe(true);
  });

  test("does not busy-loop on a delay past setTimeout's 32-bit ceiling", async () => {
    // `setTimeout` fires IMMEDIATELY for a delay over 2^31-1 ms, so a run asked
    // to wait a month would wake at once, re-suspend on the same journaled wake
    // time, and spin for the life of the process. The re-arm is what stops that.
    const body = vi.fn(async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      await ctx.sleep("month", 40 * 24 * 60 * 60 * 1000);
      return "much later";
    });
    const { engine } = harness(body);
    const runId = await engine.start("digest", [{}]);

    await vi.waitFor(() => {
      expect(body).toHaveBeenCalled();
    });
    // Give the loop room to spin if it is going to.
    const walks = body.mock.calls.length;
    await sleep(30);
    expect(body.mock.calls.length).toBe(walks);
    expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
  });
});

describe("a burst of deliveries for ONE run", () => {
  /**
   * A body that parks on four hooks, races them, and then holds the walk open
   * in a step the test controls.
   *
   * The shape matters: signalling the remaining hooks while that step is in
   * flight is the burst this exists for, and it is not contrived — a fan-out of
   * `ctx.waitFor` answered at once is one `signal` per hook, and every one of
   * them dispatches.
   */
  function racer(): {
    run: (input: Record<string, unknown>, ctx: WorkflowContext) => Promise<string>;
    walks: () => number;
    slow: () => number;
    release: () => void;
  } {
    const gate = Promise.withResolvers<void>();
    let walks = 0;
    let slow = 0;
    return {
      walks: () => walks,
      slow: () => slow,
      release: () => gate.resolve(),
      run: async (_input, ctx) => {
        walks++;
        // The waits are hoisted so the race reads on ONE line, which is what
        // keeps `guard-invariants` rule 3 able to see there is no timer among
        // them — it is line-based, so a wrapped argument list is reported
        // without the elements being visible. Do not re-inline it.
        const answers = [
          ctx.waitFor<string>("tok_0"),
          ctx.waitFor<string>("tok_1"),
          ctx.waitFor<string>("tok_2"),
          ctx.waitFor<string>("tok_3"),
        ];
        const first = await Promise.race(answers);
        await ctx.step("slow", async () => {
          slow++;
          await gate.promise;
          return "held";
        });
        return first;
      },
    };
  }

  test("is COLLAPSED into one re-walk rather than raced against the walk in flight", async () => {
    // The amplification this dispatcher used to take, and the platform side
    // already refuses. A/B'd against the guard removed, on this exact body:
    // five walks, `slow` executed THREE times, and the run `failed` with
    // "step slow has 3 unfinished attempt(s) against a budget of 3" — the
    // dispatcher's own duplicates spending the author's whole retry lease on a
    // run in which nothing had died.
    const body = racer();
    const { engine } = harness(body.run);
    const runId = await engine.start("digest", [{}]);

    // Parked on all four hooks, so every signal below reaches an OPEN one.
    await vi.waitFor(() => {
      expect(body.walks()).toBe(1);
    });
    // The first answer is what lets the body past the race and into the step —
    // walk 2, held there until this test releases it.
    expect(await engine.signal("tok_0", "zero")).toBe(true);
    await vi.waitFor(() => {
      expect(body.slow()).toBe(1);
    });
    expect(body.walks()).toBe(2);

    // The burst, arriving while walk 2 is inside the step. All three are
    // accepted — nothing is dropped — and none of them may start a walk beside
    // the one in flight.
    expect(
      await Promise.all([
        engine.signal("tok_1", "one"),
        engine.signal("tok_2", "two"),
        engine.signal("tok_3", "three"),
      ]),
    ).toEqual([true, true, true]);
    await tick();
    expect(body.walks()).toBe(2);

    body.release();
    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    });
    // The run finished on the answer the race really won, and the step ran once.
    expect(await engine.readOutput(runId)).toBe("zero");
    expect(body.slow()).toBe(1);
    // Two walks, not five. The three collapsed deliveries cost one `execute`
    // against a run that is already terminal, which never reaches the body.
    expect(body.walks()).toBe(2);
  });

  test("is DEFERRED rather than dropped, so at-least-once still holds", async () => {
    // The other half. Collapsing is only safe if the collapsed delivery still
    // happens: a signal that arrives mid-walk carries an answer the walk in
    // flight may already have read past, so one re-delivery has to follow it.
    const gate = Promise.withResolvers<void>();
    let walks = 0;
    const { engine } = harness(async (_input, ctx) => {
      walks++;
      // Hoisted for the reason the case above hoists its own — see there.
      const answers = [ctx.waitFor<string>("tok_a"), ctx.waitFor<string>("tok_b")];
      const first = await Promise.race(answers);
      await ctx.step("slow", () => gate.promise);
      // A second park, so the walk that took the burst does NOT end the run —
      // which is what makes the deferred delivery observable rather than a
      // no-op against a terminal record.
      await ctx.waitFor<string>("tok_end");
      return first;
    });
    const runId = await engine.start("digest", [{}]);
    await vi.waitFor(() => {
      expect(walks).toBe(1);
    });

    expect(await engine.signal("tok_a", "a")).toBe(true);
    await vi.waitFor(() => {
      expect(walks).toBe(2);
    });
    // Mid-walk, while walk 2 is held inside the step. The `tick` is what makes
    // the case the one being tested rather than a timing accident: the dispatch
    // is a `setTimeout(0)`, so without it the delivery might land AFTER walk 2
    // resolved and never be collapsed at all.
    expect(await engine.signal("tok_b", "b")).toBe(true);
    await tick();
    expect(walks).toBe(2);

    // Walk 2 parks on `tok_end` and resolves; the collapsed delivery then runs
    // as walk 3. Without it the count stops at two and the delivery is lost.
    gate.resolve();
    await vi.waitFor(() => {
      expect(walks).toBe(3);
    });
    expect(await engine.getRun(runId)).toMatchObject({ status: "running" });

    expect(await engine.signal("tok_end", "end")).toBe(true);
    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    });
    expect(await engine.readOutput(runId)).toBe("a");
  });
});

describe("a run suspended when the engine went away", () => {
  /** A body that sleeps once and then does one step. */
  const napper =
    (ms: number, after: () => unknown) => async (_i: unknown, ctx: WorkflowContext) => {
      await ctx.sleep("nap", ms);
      return ctx.step("after", after);
    };

  test("is re-delivered by a rebuilt engine over the same journal, deadline ALREADY elapsed", async () => {
    // The unrecoverable case. `stop()` clears the timer, the deadline then
    // elapses with nothing scheduled, and no caller can reach the run: a bare
    // `wake` refuses an elapsed wait by contract, so without a boot sweep the
    // run sits `running` forever with its whole journal intact.
    const journal = createMemoryJournal();
    const after = vi.fn(() => "resumed");
    const first = harness(napper(120, after), journal);
    const runId = await first.engine.start("digest", [{}]);
    await vi.waitFor(async () => {
      expect(await first.engine.getRun(runId)).toMatchObject({ status: "running" });
    });
    first.engine.stop();
    // Past the deadline, so the rebuilt engine meets an OVERDUE wait rather than
    // one it can simply re-arm a timer for. A bare `wake` cannot reach it — which
    // is the contract, and the reason nothing else could rescue this run.
    await sleep(150);
    expect(await journal.wakeSleeps(runId, undefined)).toBe(0);

    const second = harness(napper(120, after), journal);
    await vi.waitFor(async () => {
      expect(await second.engine.getRun(runId)).toMatchObject({ status: "completed" });
    });
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("keeps a deadline that has NOT elapsed rather than firing it early", async () => {
    const journal = createMemoryJournal();
    const after = vi.fn(() => "resumed");
    const first = harness(napper(400, after), journal);
    const runId = await first.engine.start("digest", [{}]);
    await vi.waitFor(async () => {
      expect(await first.engine.getRun(runId)).toMatchObject({ status: "running" });
    });
    first.engine.stop();

    const second = harness(napper(400, after), journal);
    // The re-enqueue is a SCHEDULE, not a delivery: the step has not run yet.
    await sleep(30);
    expect(after).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect(await second.engine.getRun(runId)).toMatchObject({ status: "completed" });
    });
  });

  test("leaves a run parked on somebody else's answer alone", async () => {
    // `await ctx.waitFor(token)` with no deadline is the steady state of the
    // approval workflow the SDK documents, and `signal` is what ends it. Walking
    // it at every boot buys nothing and costs a replay per parked run per
    // `aai dev` file save.
    const journal = createMemoryJournal();
    const body = vi.fn(async (_i: Record<string, unknown>, ctx: WorkflowContext) => {
      const answer = await ctx.waitFor<{ ok: boolean }>("tok_park");
      return answer.ok;
    });
    const first = harness(body, journal);
    await first.engine.start("digest", [{}]);
    await vi.waitFor(() => {
      expect(body).toHaveBeenCalled();
    });
    first.engine.stop();
    const walks = body.mock.calls.length;

    harness(body, journal);
    await sleep(40);
    expect(body.mock.calls.length).toBe(walks);
  });

  test("is left to the platform's queue when a dispatcher was injected", async () => {
    // A deployed guest's schedule lives in the platform's queue, which has its
    // own reconcile (`aai-server/workflow-queue-reconcile.ts`). A boot sweep here
    // would be a second recovery mechanism racing it, one sandbox boot per copy.
    const journal = createMemoryJournal();
    const after = vi.fn(() => "resumed");
    const first = harness(napper(120, after), journal);
    const runId = await first.engine.start("digest", [{}]);
    await vi.waitFor(async () => {
      expect(await first.engine.getRun(runId)).toMatchObject({ status: "running" });
    });
    first.engine.stop();
    await sleep(150);

    const dispatch = vi.fn();
    createInProcessWorkflowEngine({
      workflows: { digest: workflow({ description: "digest", run: napper(120, after) }) },
      journal,
      logger: makeLogger(),
      dispatch,
    });
    await sleep(30);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await journal.getRun(runId)).toMatchObject({ status: "running" });
  });

  test("says so when the journal it was handed cannot enumerate one", async () => {
    // A durability tradeoff absent from the log reads as a bug, and this is the
    // one an author is most likely to hit by accident — `RuntimeOptions.journal`
    // takes any `JournalStore`.
    const { resumableRuns: _drop, ...opaque } = createMemoryJournal();
    const { logger } = harness(() => "done", opaque);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        "Workflow runs cannot be recovered at boot",
        expect.objectContaining({ detail: expect.stringContaining("ctx.sleep") }),
      );
    });
  });
});

describe("stop", () => {
  test("cancels a pending delivery, so a rebuilt runtime leaves nothing behind", async () => {
    // `aai dev` rebuilds its runtime on every file save. Without this each save
    // leaves the previous engine's timers running bodies from a build that is
    // gone.
    const body = vi.fn(() => "done");
    const { engine } = harness(body);
    const runId = await engine.start("digest", [{}]);
    engine.stop();

    await sleep(30);
    expect(body).not.toHaveBeenCalled();
    expect(await engine.getRun(runId)).toMatchObject({ status: "pending" });
  });

  test("refuses to schedule anything after stopping", async () => {
    const body = vi.fn(() => "done");
    const { engine } = harness(body);
    engine.stop();

    await engine.start("digest", [{}]);
    await sleep(30);
    expect(body).not.toHaveBeenCalled();
  });
});

describe("a journal that cannot answer", () => {
  test("is reported rather than becoming an unhandled rejection", async () => {
    // `execute` resolves a status for an ordinary run failure, so anything that
    // REJECTS is the store itself — which an operator needs to see, and which
    // would otherwise escape into a timer callback and end the process.
    const journal = createMemoryJournal();
    const failing: JournalStore = {
      ...journal,
      getRun: () => Promise.reject(new Error("the journal is gone")),
    };
    const { engine, logger } = harness(() => "done", failing);

    await engine.start("digest", [{}]);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        "Workflow delivery failed",
        expect.objectContaining({ error: "the journal is gone" }),
      );
    });
  });
});
/**
 * The accelerator, wired. `workflow-run-reads.test.ts` states what the signal
 * DOES; what only this file can see is whether the engine really raises it, on
 * both writes that make a run terminal and on neither of the two that do not.
 *
 * Each case asserts on the READ being taken rather than on what it answered,
 * which is the precise claim: the signal carries no snapshot, so what it can be
 * observed to do is bring a watcher's next journal read forward.
 */
describe("a run that settles in this process", () => {
  /**
   * A watcher of `runId` whose read answers `undefined` and records that it ran.
   *
   * The deadline is deliberately far out: without the signal nothing takes this
   * read inside the test's own budget, so a regression fails on the assertion
   * rather than passing quietly.
   */
  function watching(runId: string) {
    const reader = { get: vi.fn(async () => undefined) };
    const watch = watchRun(reader, runId);
    const pending = watch.next(60_000);
    return { reader, watch, pending };
  }

  test("wakes a watcher when the walk COMPLETES it", async () => {
    const { engine } = harness(() => "done");
    const runId = await engine.start("digest", [{}]);
    const { reader, watch, pending } = watching(runId);
    await pending;
    expect(reader.get).toHaveBeenCalledWith(runId);
    watch.close();
  });

  test("wakes a watcher when a CANCEL ends it", async () => {
    // The other terminal write, and the one easiest to forget: nothing about a
    // cancel goes through the walk.
    const { engine } = harness(async (_input, ctx: WorkflowContext) => {
      await ctx.sleep("hold", 60_000);
      return "done";
    });
    const runId = await engine.start("digest", [{}]);
    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
    });
    const { reader, watch, pending } = watching(runId);
    expect(await engine.cancel(runId)).toBe(true);
    await pending;
    expect(reader.get).toHaveBeenCalledWith(runId);
    watch.close();
  });

  test("does NOT wake one for a suspend, or for a cancel that ended nothing", async () => {
    // A suspended run is still `running`, and a `false` from `cancel` moved
    // nothing — so neither is a new answer, and hurrying a watcher toward one
    // would spend a platform round trip per park.
    const { engine } = harness(async (_input, ctx: WorkflowContext) => {
      await ctx.sleep("hold", 60_000);
      return "done";
    });
    const runId = await engine.start("digest", [{}]);
    await vi.waitFor(async () => {
      expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
    });
    const { reader, watch, pending } = watching(runId);
    // `setStatus`'s `expect` refuses a cancel of a run that is not there, so
    // nothing moved.
    expect(await engine.cancel("wrun_nosuch")).toBe(false);
    await tick();
    expect(reader.get).not.toHaveBeenCalled();
    watch.close();
    await expect(pending).rejects.toThrow(/Run watch closed/);
  });
});
