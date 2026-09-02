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

import { type WorkflowCtx, workflow } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import {
  createInProcessWorkflowEngine,
  type InProcessWorkflowEngine,
} from "./workflow-in-process.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";

/** An engine over an inspectable journal, with a real dispatcher. */
function harness(
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => unknown,
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
      await ctx.sleep(20);
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
    const body = vi.fn(async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      await ctx.sleep(40 * 24 * 60 * 60 * 1000);
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

describe("a run suspended when the engine went away", () => {
  /** A body that sleeps once and then does one step. */
  const napper = (ms: number, after: () => unknown) => async (_i: unknown, ctx: WorkflowCtx) => {
    await ctx.sleep(ms);
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
    const body = vi.fn(async (_i: Record<string, unknown>, ctx: WorkflowCtx) => {
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
