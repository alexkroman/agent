// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine's LIFECYCLE, as distinct from the replay semantics one file over.
 *
 * What is stated here is the part `workflow-wdk.ts` needed a speculative read,
 * two error-class predicates and a bounded cause-chain walk to get right: the
 * three-way answer to `cancel`, a redelivery of a terminal run, and a run whose
 * workflow the agent no longer declares. Each of those was a real defect against
 * the DevKit — its own module doc carries the measurements — so each is a test
 * rather than a claim.
 */

import { type WorkflowCtx, workflow } from "@alexkroman1/aai";
import { publishStepReporter } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { report } from "@alexkroman1/aai/step";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { createStepReporter } from "./workflow-report.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

/** A workflow body, as the engine's registry holds one. */
type Body = (input: Record<string, unknown>, ctx: WorkflowCtx) => unknown;

/**
 * An engine over a memory journal, with dispatch held back.
 *
 * `dispatch` is a spy rather than an executor, because `start` and `execute`
 * being separate is the property most of these tests turn on — an engine that
 * ran the run inline would make every assertion below about a run that had
 * already finished.
 */
function harness(bodies: Record<string, Body> = {}): {
  engine: WorkflowEngine;
  journal: JournalStore;
  dispatch: ReturnType<typeof vi.fn>;
} {
  const journal = createMemoryJournal();
  const dispatch = vi.fn();
  const workflows = Object.fromEntries(
    Object.entries(bodies).map(([name, run]) => [
      name,
      // The real declaration path, so a def here is the shape `agent({ workflows })`
      // holds rather than an object literal that happens to have a `run`.
      workflow({ description: name, run }),
    ]),
  );
  let n = 0;
  const engine = createWorkflowEngine({
    workflows,
    journal,
    streams: createMemoryStreams(),
    dispatch,
    newRunId: () => `wrun_${++n}`,
    logger: silentLogger,
  });
  return { engine, journal, dispatch };
}

describe("start", () => {
  test("creates a pending run and hands it to the dispatcher", async () => {
    const { engine, dispatch } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{ topic: "otters" }]);
    expect(runId).toBe("wrun_1");
    expect(dispatch).toHaveBeenCalledWith("wrun_1");
    expect(await engine.getRun(runId)).toMatchObject({
      runId: "wrun_1",
      workflowName: "digest",
      status: "pending",
    });
  });

  test("refuses a workflow the agent does not declare, without minting a run", async () => {
    const { engine, dispatch } = harness({ digest: () => "done" });
    await expect(engine.start("nope", [{}])).rejects.toThrow(/no workflow declared/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("refuses more than one input argument", async () => {
    // The DevKit's `start` was variadic; a body takes one input. A second
    // argument would be silently dropped, so it is refused instead.
    const { engine } = harness({ digest: () => "done" });
    await expect(engine.start("digest", [{}, {}])).rejects.toThrow(/one input/);
  });
});

describe("execute", () => {
  test("runs the body and completes the run with its output", async () => {
    const { engine } = harness({ digest: (input) => ({ echoed: input.topic }) });
    const runId = await engine.start("digest", [{ topic: "otters" }]);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    expect(await engine.readOutput(runId)).toEqual({ echoed: "otters" });
  });

  test("fails the run when the body throws", async () => {
    const { engine } = harness({
      digest: () => {
        throw new Error("no good");
      },
    });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.execute(runId)).toBe("failed");
    expect(await engine.getRun(runId)).toMatchObject({
      status: "failed",
      error: { message: "no good" },
    });
  });

  test("answers undefined for a run that does not exist", async () => {
    const { engine } = harness();
    expect(await engine.execute("wrun_nope")).toBeUndefined();
  });

  test("is a no-op on a redelivery of a run that already finished", async () => {
    // The platform's queue acks on a 200, so a delivery whose ack was lost
    // arrives again after the run is over. That is ordinary, not an error.
    const body = vi.fn(() => "done");
    const { engine } = harness({ digest: body });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.execute(runId)).toBe("completed");
    expect(body).toHaveBeenCalledTimes(1);
  });

  test("does not overwrite a run cancelled while its body was in flight", async () => {
    const { engine, journal } = harness({
      digest: async () => {
        // Cancelled mid-body: the body still runs to the end, and what the
        // cancel decided is what the run is recorded as.
        await journal.setStatus("wrun_1", "cancelled", undefined, ["pending", "running"]);
        return "finished anyway";
      },
    });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.execute(runId)).toBe("cancelled");
    expect(await engine.getRun(runId)).toMatchObject({ status: "cancelled" });
  });

  test("fails a run whose workflow the agent no longer declares", async () => {
    // A redeploy that renamed or removed a workflow, with a run still in
    // flight. Leaving it `pending` forever is the silent version of failing it.
    const { engine, journal } = harness({ digest: () => "done" });
    await journal.createRun({
      runId: "wrun_orphan",
      workflow: "removed-in-a-redeploy",
      status: "pending",
      createdAt: Date.now(),
      input: {},
    });
    expect(await engine.execute("wrun_orphan")).toBe("failed");
    expect(await engine.getRun("wrun_orphan")).toMatchObject({
      error: { message: expect.stringContaining("no longer declared") },
    });
  });

  test("fails a run whose stored input is not a record", async () => {
    const body = vi.fn(() => "done");
    const { engine, journal } = harness({ digest: body });
    await journal.createRun({
      runId: "wrun_bad",
      workflow: "digest",
      status: "pending",
      createdAt: Date.now(),
      input: "not an object",
    });
    expect(await engine.execute("wrun_bad")).toBe("failed");
    expect(body).not.toHaveBeenCalled();
  });
});

describe("cancel", () => {
  test("reports true when this call is what ended the run", async () => {
    const { engine } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.cancel(runId)).toBe(true);
    expect(await engine.getRun(runId)).toMatchObject({ status: "cancelled" });
  });

  test("reports false for a run that had already finished", async () => {
    // The two-tabs race: a run that completed between the render and the click.
    // Against the DevKit this answered a 500 on the public API.
    const { engine } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.cancel(runId)).toBe(false);
  });

  test("reports false for a run that was already cancelled", async () => {
    const { engine } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    await engine.cancel(runId);
    expect(await engine.cancel(runId)).toBe(false);
  });

  test("reports false for a run that never existed", async () => {
    // The local world answered `true` here — "this call ended it", about a run
    // that never was — while `get` 404'd and `wake` said 0. One read of three
    // disagreeing with the other two is the bug this pins.
    const { engine } = harness();
    expect(await engine.cancel("wrun_totally_made_up_id")).toBe(false);
  });
});

describe("listRuns", () => {
  test("returns newest first, filtered to one declared key, capped at limit", async () => {
    const { engine } = harness({ a: () => 1, b: () => 2 });
    await engine.start("a", [{}]);
    await engine.start("b", [{}]);
    const third = await engine.start("a", [{}]);
    const runs = await engine.listRuns("a", 10);
    expect(runs.map((r) => r.runId)).toEqual([third, "wrun_1"]);
    expect(await engine.listRuns("a", 1)).toHaveLength(1);
  });
});

describe("readOutput", () => {
  test("answers undefined for a run that has not completed, rather than waiting", async () => {
    // The DevKit's `returnValue` polled a pending run at 1s intervals with no
    // ceiling, so a speculative read turned a snapshot into a wait for the run.
    const { engine } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    await expect(engine.readOutput(runId)).resolves.toBeUndefined();
  });
});

describe("durable sleep", () => {
  test("leaves a suspended run `running` and schedules its next delivery", async () => {
    // Not a terminal state and not `pending`: the run IS in progress, it is just
    // not executing. That is the status a caller polling it should see.
    const { engine, dispatch } = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep(60_000);
        return "eventually";
      },
    });
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();

    expect(await engine.execute(runId)).toBe("running");
    expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
    const [id, at] = dispatch.mock.calls[0] ?? [];
    expect(id).toBe(runId);
    expect(at).toBeGreaterThan(Date.now());
  });

  test("does not re-dispatch a run cancelled while it was waiting", async () => {
    const { engine, journal, dispatch } = harness({
      digest: async (_input, ctx) => {
        await journal.setStatus("wrun_1", "cancelled", undefined, ["running"]);
        await ctx.sleep(60_000);
        return "unreachable";
      },
    });
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();
    expect(await engine.execute(runId)).toBe("cancelled");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("wake ends the wait, reports how many it stopped, and re-delivers", async () => {
    const after = vi.fn(() => "ran");
    const { engine, dispatch } = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep(60_000);
        return ctx.step("after", after);
      },
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    dispatch.mockClear();

    expect(await engine.wakeUp(runId, undefined)).toBe(1);
    // Re-delivered so the woken body actually continues, rather than waiting out
    // the deadline it was just told to skip.
    expect(dispatch).toHaveBeenCalledWith(runId);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toBe("ran");
  });

  test("a wake on a run that is not waiting reports 0 and costs no delivery", async () => {
    const { engine, dispatch } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();
    expect(await engine.wakeUp(runId, undefined)).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a wake on a run that never existed reports 0", async () => {
    const { engine } = harness();
    expect(await engine.wakeUp("wrun_nope", undefined)).toBe(0);
  });

  test("a wake naming a correlation id ends only that wait", async () => {
    const { engine } = harness({
      digest: async (_input, ctx) => {
        await ctx.sleep(60_000, { correlationId: "review" });
        return "published";
      },
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.wakeUp(runId, ["something-else"])).toBe(0);
    expect(await engine.wakeUp(runId, ["review"])).toBe(1);
  });

  test("resumes past the wait once its deadline has passed, with no wake", async () => {
    const { engine } = harness({
      digest: async (_input, ctx) => {
        // Already elapsed, so the second delivery walks straight through.
        await ctx.sleep(-1);
        return "through";
      },
    });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.execute(runId)).toBe("completed");
  });
});

describe("hooks", () => {
  /** A body that parks on one token and reports what it was sent. */
  const parking = {
    digest: async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      const answer = await ctx.waitFor<{ approved: boolean }>("tok_review");
      return { approved: answer.approved };
    },
  };

  test("parks the body with NO next delivery scheduled", async () => {
    // The property that distinguishes a hook from a sleep: nothing but a signal
    // ends it, so scheduling a delivery would poll a run parked for a week.
    const { engine, dispatch } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();

    expect(await engine.execute(runId)).toBe("running");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a signal delivers the payload, re-delivers the run, and it completes", async () => {
    const { engine, dispatch } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    dispatch.mockClear();

    expect(await engine.signal("tok_review", { approved: true })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(runId);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ approved: true });
  });

  test("reports false for a token nothing holds", async () => {
    const { engine } = harness(parking);
    expect(await engine.signal("tok_nobody_is_waiting", {})).toBe(false);
  });

  test("reports false for a second signal on the same token", async () => {
    // A body is replayed and must read the FIRST payload every time, or two
    // walks of it diverge. So the second signal is not a second resolution.
    const { engine } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.signal("tok_review", { approved: true })).toBe(true);
    expect(await engine.signal("tok_review", { approved: false })).toBe(false);
    await engine.execute(runId);
    expect(await engine.readOutput(runId)).toEqual({ approved: true });
  });

  test("reports false for a token whose run already finished", async () => {
    // The ORDINARY case rather than an error: the run moved past its wait.
    const { engine } = harness(parking);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await engine.signal("tok_review", { approved: true });
    await engine.execute(runId);
    expect(await engine.getRun(runId)).toMatchObject({ status: "completed" });
    expect(await engine.signal("tok_review", { approved: true })).toBe(false);
  });

  test("frees a DERIVED token when its run ends, so the next run can reuse it", async () => {
    // The SDK tells authors to derive a hook token from the run's own input, and
    // `recap-workflow` derives `retention:<sessionId>` — so a token that outlived
    // its run could serve exactly ONE run ever. A caller asking for a second
    // recap in one session hit `claimHook`'s conflict, which is NOT a suspend, so
    // the saga's catch compensated and deleted that transcript too.
    const { engine } = harness(parking);
    const first = await engine.start("digest", [{}]);
    await engine.execute(first);
    await engine.signal("tok_review", { approved: true });
    await engine.execute(first);
    expect(await engine.getRun(first)).toMatchObject({ status: "completed" });

    // Same token, second run — the ordinary shape, not an edge case.
    const second = await engine.start("digest", [{}]);
    expect(await engine.execute(second)).toBe("running");
    expect(await engine.signal("tok_review", { approved: false })).toBe(true);
    await engine.execute(second);
    expect(await engine.readOutput(second)).toEqual({ approved: false });
  });

  test("frees the token on a run that FAILED too, not only one that completed", async () => {
    const { engine, journal } = harness(parking);
    const first = await engine.start("digest", [{}]);
    await engine.execute(first);
    await journal.setStatus(first, "failed", { error: { message: "gave up" } }, ["running"]);

    const second = await engine.start("digest", [{}]);
    expect(await engine.execute(second)).toBe("running");
    expect(await engine.signal("tok_review", { approved: true })).toBe(true);
  });

  test("fails a run whose token another LIVE run already holds", async () => {
    // One signal would resolve whichever wait the store found first and the
    // other would never end, so it is a bug worth failing the run over.
    const { engine } = harness({ ...parking, second: parking.digest });
    const first = await engine.start("digest", [{}]);
    await engine.execute(first);
    const clash = await engine.start("second", [{}]);
    expect(await engine.execute(clash)).toBe("failed");
    expect(await engine.getRun(clash)).toMatchObject({
      error: { message: expect.stringContaining("already held by") },
    });
  });

  test("a body may wait on a hook AFTER a step, resuming past the step", async () => {
    const work = vi.fn(() => "researched");
    const { engine } = harness({
      digest: async (_input, ctx) => {
        const notes = await ctx.step("research", work);
        const answer = await ctx.waitFor<{ ok: boolean }>("tok_gate");
        return { notes, ok: answer.ok };
      },
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await engine.signal("tok_gate", { ok: true });
    expect(await engine.execute(runId)).toBe("completed");
    // The step is answered from the journal on the resume, not re-run.
    expect(work).toHaveBeenCalledTimes(1);
    expect(await engine.readOutput(runId)).toEqual({ notes: "researched", ok: true });
  });
});

describe("progress", () => {
  test("a report() from inside a step reaches the run's stream", async () => {
    // The seam this proves: `report()` finds its run through
    // `workflow-run-context.ts` rather than through the DevKit's
    // `getWritable()`, and the executor enters that context per STEP so the
    // line is attributed to the right one.
    const journal = createMemoryJournal();
    const streams = createMemoryStreams();
    const engine = createWorkflowEngine({
      workflows: {
        digest: workflow({
          description: "digest",
          run: async (_input, ctx) => {
            await ctx.step("research", async () => {
              await report("reading the page");
            });
            return "done";
          },
        }),
      },
      journal,
      streams,
      dispatch: () => undefined,
      newRunId: () => "wrun_1",
      logger: silentLogger,
    });

    // The reporter is a process-global slot, so it is published for this test
    // and taken back down — `publishStepReporter` returns nothing, so the
    // `finally` publishes `undefined` rather than calling a restore.
    publishStepReporter(createStepReporter(silentLogger));
    try {
      const runId = await engine.start("digest", [{}]);
      expect(await engine.execute(runId)).toBe("completed");
    } finally {
      publishStepReporter(undefined);
    }

    expect(await streams.read("wrun_1", {})).toEqual([{ index: 0, value: "reading the page" }]);
    expect(await engine.streamTail("wrun_1", {})).toBe(0);
  });
});

describe("a hook with a deadline", () => {
  /** A body that waits for an answer but not forever — Temporal's `timeoutOrUserAction`. */
  const gated = {
    digest: async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      const answer = await ctx.waitFor<{ keep: boolean }>("tok_gate", { timeoutMs: 60_000 });
      return { kept: answer?.keep ?? false, answered: answer !== undefined };
    },
  };

  /** The same gate with a window short enough for a spec to outlive. */
  const briefly = {
    digest: async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      const answer = await ctx.waitFor<{ keep: boolean }>("tok_gate", { timeoutMs: 1 });
      return { kept: answer?.keep ?? false, answered: answer !== undefined };
    },
  };

  test("suspends with the deadline scheduled, so an unanswered window still ends", async () => {
    // The difference from an unbounded wait: THIS one schedules a delivery,
    // because the window closing is an event the engine owns.
    const { engine, dispatch } = harness(gated);
    const runId = await engine.start("digest", [{}]);
    dispatch.mockClear();

    expect(await engine.execute(runId)).toBe("running");
    const [id, at] = dispatch.mock.calls[0] ?? [];
    expect(id).toBe(runId);
    expect(at).toBeGreaterThan(Date.now());
  });

  test("an answer inside the window wins", async () => {
    const { engine } = harness(gated);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    expect(await engine.signal("tok_gate", { keep: true })).toBe(true);
    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ kept: true, answered: true });
  });

  test("a closed window resolves undefined, so the body takes its safe default", async () => {
    // `undefined` rather than a throw: a window closing is an outcome a body
    // branches on. The deadline is let ELAPSE rather than woken, because a bare
    // wake deliberately no longer reaches a hook's deadline — see below.
    const { engine } = harness(briefly);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await sleep(5);

    expect(await engine.execute(runId)).toBe("completed");
    expect(await engine.readOutput(runId)).toEqual({ kept: false, answered: false });
  });

  test("a bare wakeUp does NOT close the window — it is for schedules, not approvals", async () => {
    // The hook's deadline is journaled through the same primitive as a
    // `ctx.sleep`, and without a `kind` on the record the two were
    // indistinguishable: a "send it now" tool calling `wakeUp(runId)` to cut a
    // SCHEDULE short also closed any pending approval window on that run — a
    // body cancelling a human approval it never asked to cancel.
    const { engine } = harness(gated);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);

    expect(await engine.wakeUp(runId, undefined)).toBe(0);
    // Still parked, so the answer can still arrive.
    expect(await engine.getRun(runId)).toMatchObject({ status: "running" });
    expect(await engine.signal("tok_gate", { keep: true })).toBe(true);
    await engine.execute(runId);
    expect(await engine.readOutput(runId)).toEqual({ kept: true, answered: true });
  });

  test("a signal that arrives after the window closed is refused", async () => {
    // So a caller cannot be told their answer was taken when it was not — and,
    // more to the point, so the next replay cannot read a payload and take the
    // answered branch after the body already took the other one.
    const { engine } = harness(briefly);
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    await sleep(5);
    await engine.execute(runId);

    expect(await engine.signal("tok_gate", { keep: true })).toBe(false);
  });

  test("the deadline is decided ONCE, so a replay cannot extend the window", async () => {
    const journal = createMemoryJournal();
    const engine = createWorkflowEngine({
      workflows: { digest: workflow({ description: "d", run: gated.digest }) },
      journal,
      streams: createMemoryStreams(),
      dispatch: () => undefined,
      newRunId: () => "wrun_1",
      logger: silentLogger,
    });
    const runId = await engine.start("digest", [{}]);
    await engine.execute(runId);
    const first = await journal.claimSleep(runId, "hookTimeout!0", 0, undefined);
    await engine.execute(runId);
    const second = await journal.claimSleep(runId, "hookTimeout!0", 0, undefined);
    expect(second.wakeAt).toBe(first.wakeAt);
  });
});

describe("step execution is BOUNDED, whatever the body opens", () => {
  test("a fan-out of 32 runs `stepConcurrency` at a time", async () => {
    // The regression this exists for, at the level that matters: the gate's own
    // spec proves the gate, and this proves the ENGINE applies it. Removing
    // `gate` from `replayRun`'s options in `workflow-engine.ts` fails only here.
    //
    // What it prevented: `mapConcurrent(32)` meant "32 queued jobs, three
    // running" under the DevKit's world and "thirty-two running" once steps
    // executed inline. A 50-minute recording opened 32 transcriptions against a
    // 640 MB in-flight budget and the microVM died five seconds later — before
    // any settled, so nothing journaled and every redelivery redid all 32.
    const running: number[] = [];
    const release: (() => void)[] = [];
    let n = 0;
    const engine = createWorkflowEngine({
      workflows: {
        fanout: workflow({
          description: "fanout",
          run: async (_input, ctx) =>
            Promise.all(
              Array.from({ length: 32 }, (_, i) =>
                ctx.step(`segment${i}`, async () => {
                  running.push(i);
                  await new Promise<void>((resolve) => release.push(resolve));
                  running.pop();
                  return i;
                }),
              ),
            ),
        }),
      },
      journal: createMemoryJournal(),
      streams: createMemoryStreams(),
      dispatch: vi.fn(),
      newRunId: () => `wrun_${++n}`,
      logger: silentLogger,
      stepConcurrency: 4,
    });

    const runId = await engine.start("fanout", [{}]);
    void engine.execute(runId);
    // A real elapsed wait rather than `vi.waitFor`: the assertion is that the
    // count STOPS at four and stays there, which a poller that succeeds the
    // moment it sees four cannot distinguish from one that overshot and came
    // back down.
    await sleep(200);
    expect(running.length).toBe(4);

    // And the queue drains rather than deadlocking — 32 admitted in total, four
    // at a time.
    const seen = new Set<number>(running);
    for (let i = 0; i < 40 && release.length > 0; i++) {
      release.shift()?.();
      await sleep(5);
      for (const id of running) seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(4);
  });
});
