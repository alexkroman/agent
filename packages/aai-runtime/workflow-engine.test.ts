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
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
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

describe("the not-yet-built halves", () => {
  test("wakeUp reports nothing was sleeping", async () => {
    const { engine } = harness({ digest: () => 1 });
    const runId = await engine.start("digest", [{}]);
    expect(await engine.wakeUp(runId, undefined)).toBe(0);
  });

  test("signal reports no hook holds the token", async () => {
    const { engine } = harness();
    expect(await engine.signal("tok_whatever", {})).toBe(false);
  });
});
