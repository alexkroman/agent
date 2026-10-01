// Copyright 2026 the AAI authors. MIT license.
/**
 * `workflow({ onFailure })`, end to end through the engine: the hook runs as a
 * journaled step once the body's throw is classified as the RUN failing, the
 * run's own failure is what is recorded, and a redelivery does not run it again.
 */

import { type WorkflowContext, type WorkflowDef, workflow } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../../_test-utils.ts";
import type { Logger } from "../../logger.ts";
import { createWorkflowEngine } from "../engine.ts";
import { createMemoryJournal } from "../journal/backends/memory.ts";
import { createMemoryStreams } from "../streams.ts";

function world(defs: Record<string, WorkflowDef>, logger: Logger = silentLogger) {
  const journal = createMemoryJournal();
  let n = 0;
  const engine = createWorkflowEngine({
    workflows: defs,
    journal,
    streams: createMemoryStreams(),
    dispatch: () => undefined,
    newRunId: () => `wrun_${++n}`,
    logger,
  });
  return { engine, journal };
}

describe("onFailure", () => {
  test("runs as the `onFailure` step with the error and the run, before the failure is recorded", async () => {
    const seen: unknown[] = [];
    const { engine, journal } = world({
      job: workflow({
        run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
          await ctx.step(
            "work",
            () => {
              throw new Error("the provider refused");
            },
            { maxAttempts: 1 },
          );
        },
        onFailure: async (err, info) => {
          // The run is not recorded failed yet when the hook runs.
          seen.push({
            message: err.message,
            ...info,
            status: (await journal.getRun(info.runId))?.status,
          });
        },
      }),
    });
    const runId = await engine.start("job", [{ task: "summarize" }]);
    expect(await engine.execute(runId)).toBe("failed");
    expect(seen).toEqual([
      {
        message: "the provider refused",
        runId,
        workflow: "job",
        input: { task: "summarize" },
        status: "running",
      },
    ]);
    const steps = await journal.readSteps(runId);
    expect(new Map(steps.map((s) => [s.key, s.status]))).toEqual(
      new Map([
        ["work#0", "failed"],
        ["onFailure#0", "ok"],
      ]),
    );
    expect((await engine.getRun(runId))?.error?.message).toBe("the provider refused");
  });

  test("a redelivery that replays to the same failure answers the hook from the journal", async () => {
    const hook = vi.fn();
    const { engine, journal } = world({
      job: workflow({
        run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
          await ctx.step(
            "work",
            () => {
              throw new Error("boom");
            },
            { maxAttempts: 1 },
          );
        },
        onFailure: hook,
      }),
    });
    const runId = await engine.start("job", [{}]);
    // Crash after the hook step, before the terminal write: put the run back to
    // `running` and deliver again.
    await engine.execute(runId);
    await journal.setStatus(runId, "running", undefined, ["failed"]);
    expect(await engine.execute(runId)).toBe("failed");
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test("the step form takes a retry budget, and a hook that still fails is logged, not recorded", async () => {
    const warn = vi.fn();
    let attempts = 0;
    const { engine } = world(
      {
        job: workflow({
          run: () => {
            throw new Error("the body's own failure");
          },
          onFailure: {
            run: () => {
              attempts++;
              throw new Error("the device is unplugged");
            },
            maxAttempts: 2,
          },
        }),
      },
      { ...silentLogger, warn },
    );
    const runId = await engine.start("job", [{}]);
    expect(await engine.execute(runId)).toBe("failed");
    expect(attempts).toBe(2);
    expect((await engine.getRun(runId))?.error?.message).toBe("the body's own failure");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/onFailure hook failed/),
      expect.objectContaining({ runId, workflow: "job" }),
    );
  });

  test("is not run for a run that completes, or that the body suspends", async () => {
    const hook = vi.fn();
    const { engine } = world({
      ok: workflow({ run: () => "done", onFailure: hook }),
      waits: workflow({
        run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
          await ctx.sleep("later", 60_000);
        },
        onFailure: hook,
      }),
    });
    expect(await engine.execute(await engine.start("ok", [{}]))).toBe("completed");
    expect(await engine.execute(await engine.start("waits", [{}]))).toBe("running");
    expect(hook).not.toHaveBeenCalled();
  });

  test("is not run for a cancelled run", async () => {
    const hook = vi.fn();
    let engineRef: ReturnType<typeof world>["engine"] | undefined;
    const { engine } = world({
      job: workflow({
        run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
          await ctx.step("first", () => engineRef?.cancel(ctx.runId));
          await ctx.step("second", () => "never");
        },
        onFailure: hook,
      }),
    });
    engineRef = engine;
    const runId = await engine.start("job", [{}]);
    expect(await engine.execute(runId)).toBe("cancelled");
    expect(hook).not.toHaveBeenCalled();
  });
});
