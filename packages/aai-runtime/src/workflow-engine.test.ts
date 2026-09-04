// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine's LIFECYCLE, as distinct from the replay semantics one file over
 * and from a run that PARKS in `workflow-engine-waits.test.ts`.
 *
 * What is stated here is the part `workflow-wdk.ts` needed a speculative read,
 * two error-class predicates and a bounded cause-chain walk to get right: the
 * three-way answer to `cancel`, a redelivery of a terminal run, and a run whose
 * workflow the agent no longer declares. Each of those was a real defect against
 * the DevKit — its own module doc carries the measurements — so each is a test
 * rather than a claim.
 *
 * Durable sleeps, hooks and hook deadlines are the sibling file's; the harness
 * both use is `_workflow-engine-harness.ts`.
 */

import { workflow } from "@alexkroman1/aai";
import { publishStepReporter } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { stepReport } from "@alexkroman1/aai/step";
import { describe, expect, test, vi } from "vitest";
import { silentLogger, tick } from "./_test-utils.ts";
import { harness } from "./_workflow-engine-harness.ts";
import { createWorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { createStepReporter } from "./workflow-report.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

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

  test("STOPS a body that is running, rather than only refusing its final write", async () => {
    // The defect: `replayRun` honours `options.signal` and no production caller
    // supplied one — `deliver()` calls `execute(runId)` bare, and so does
    // `BuiltWorkflowClient.execute` — so a cancelled run ran to the end anyway.
    const ran: string[] = [];
    let ended: boolean | undefined;
    const built = harness({
      digest: async (_input, ctx) => {
        await ctx.step("one", async () => {
          ran.push("one");
          ended = await built.engine.cancel(ctx.runId);
        });
        await ctx.step("two", () => ran.push("two"));
        await ctx.step("three", () => ran.push("three"));
        return "finished anyway";
      },
    });
    const runId = await built.engine.start("digest", [{}]);
    // `cancelled` rather than a rejection: an abort this engine raised is the
    // run's own answer, not an outage for the queue to retry.
    expect(await built.engine.execute(runId)).toBe("cancelled");
    expect(ended).toBe(true);
    expect(ran).toEqual(["one"]);
  });
});

describe("a delivery whose re-enqueue fails", () => {
  const down = () => Promise.reject(new Error("queue is down"));
  /** A body that suspends, over a dispatcher that cannot reach its queue. */
  const unreachableQueue = () =>
    harness({ nap: (_i, ctx) => ctx.sleep("nap", 60_000) }, vi.fn(down));

  test("REJECTS, so the delivery is not acked for a run nothing will come back for", async () => {
    // It used to be `void send(...).catch(log)`, so `execute` resolved and
    // `deliverQueueMessage` acked — possibly before the enqueue was even
    // attempted, leaving a journal row, no queue message, and a wake sweep that
    // reads the QUEUE. Awaited, the platform retries the ORIGINAL message.
    const { engine } = unreachableQueue();
    const runId = await engine.start("nap", [{}]);
    await expect(engine.execute(runId)).rejects.toThrow("queue is down");
  });

  test("does not make `start` fallible, which is a tool call away", async () => {
    // `start` answers a run id to a tool: a broken queue must not fail the call.
    const { engine } = unreachableQueue();
    await expect(engine.start("nap", [{}])).resolves.toBe("wrun_1");
    await tick(); // the detached catch — an unhandled rejection would surface here
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

describe("the run record carries the output", () => {
  test("a completed record carries it, so a snapshot costs ONE journal read", async () => {
    // What `ctx.workflows.get()` reads. `toSnapshot` used to follow every
    // completed `getRun` with a `readOutput` — a second journal round trip, and
    // on a deployed agent a second platform POST — for a value the record it
    // already held was carrying. So the mapping out of the journal has to keep
    // it.
    const { engine } = harness({ digest: (input) => ({ echoed: input.topic }) });
    const runId = await engine.start("digest", [{ topic: "otters" }]);
    await engine.execute(runId);
    expect(await engine.getRun(runId)).toMatchObject({
      status: "completed",
      output: { echoed: "otters" },
    });
    // And `listRuns` too: `recent()` snapshots every record the listing
    // answered, so it paid one of those reads per COMPLETED run in the page.
    expect(await engine.listRuns("digest", 10)).toMatchObject([
      { runId, output: { echoed: "otters" } },
    ]);
  });

  test("a record that has not completed carries NO output key", async () => {
    // Gated on the status for the same reason `error` is: the snapshot union
    // offers `output` on `completed` alone, so a half-written value surfacing on
    // a run still in flight would read as an answer.
    const { engine } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    const record = await engine.getRun(runId);
    expect(record).toMatchObject({ status: "pending" });
    expect(record && "output" in record).toBe(false);
  });
});

describe("progress", () => {
  test("a stepReport() from inside a step reaches the run's stream", async () => {
    // The seam this proves: `stepReport()` finds its run through
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
              await stepReport("reading the page");
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
