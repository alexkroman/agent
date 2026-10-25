// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createToolContext } from "./_testing-context.ts";
import { createRecordingWorkflows } from "./testing-recording-workflows.ts";
import { createRunSnapshot } from "./testing-workflows.ts";
import { workflow } from "./workflow.ts";

const remind = workflow({
  description: "Say a reminder when it is due",
  input: z.object({ text: z.string() }),
  run: async () => undefined,
});
const call = workflow({ description: "Place a call", run: async () => undefined });
const declared = { remind, call };

describe("createRecordingWorkflows", () => {
  test("records a start by def under its declared name, and runs nothing", async () => {
    const workflows = createRecordingWorkflows({ workflows: declared });
    const ctx = createToolContext({ workflows });
    const runId = await ctx.workflows.start(remind, { text: "laundry" }, { key: "kitchen" });

    expect(runId).toBe("wrun_rec_1");
    expect(workflows.started("remind")).toEqual([
      {
        workflow: "remind",
        def: remind,
        input: { text: "laundry" },
        options: { key: "kitchen" },
        runId,
      },
    ]);
    expect(workflows.started(remind)).toHaveLength(1);
    expect(workflows.started("call")).toEqual([]);
    expect(ctx.workflows.listing()).toEqual([{ name: "remind" }, { name: "call" }]);
  });

  test("a def not declared is refused, as the real client refuses it", async () => {
    const stray = workflow({ run: async () => undefined });
    const workflows = createRecordingWorkflows({ workflows: declared });
    await expect(workflows.start(stray, {})).rejects.toThrow(/not in `workflows`/);
  });

  test("find answers seeded runs and its own starts, newest first, by name and key", async () => {
    const workflows = createRecordingWorkflows({
      workflows: declared,
      runs: [createRunSnapshot({ workflow: "remind", key: "kitchen", runId: "wrun_pending" })],
    });
    workflows.seed(createRunSnapshot({ workflow: "remind", key: "garage", runId: "wrun_other" }));
    await workflows.start("remind", { text: "x" }, { key: "kitchen" });

    const found = await workflows.find(remind, "kitchen");
    expect(found.map((r) => r.runId)).toEqual(["wrun_rec_1", "wrun_pending"]);
    expect((await workflows.recent("remind")).map((r) => r.runId)).toEqual([
      "wrun_rec_1",
      "wrun_other",
      "wrun_pending",
    ]);
    await expect(workflows.get("wrun_other")).resolves.toMatchObject({ key: "garage" });
  });

  test("latest and live read the seeded runs by name, key and status; signalRun is recorded", async () => {
    const workflows = createRecordingWorkflows({
      workflows: declared,
      runs: [
        createRunSnapshot({
          workflow: "remind",
          key: "kitchen",
          runId: "old",
          status: "completed",
          output: 1,
        }),
        createRunSnapshot({ workflow: "remind", key: "kitchen", runId: "going" }),
        createRunSnapshot({
          workflow: "remind",
          key: "kitchen",
          runId: "newest",
          status: "failed",
          error: "x",
        }),
        createRunSnapshot({ workflow: "remind", key: "session", runId: "sess" }),
      ],
    });
    await expect(workflows.latest(remind, "kitchen")).resolves.toMatchObject({ runId: "newest" });
    await expect(workflows.live(remind, "kitchen")).resolves.toMatchObject({ runId: "going" });
    // `key` defaults to the literal "session", as the client's does.
    await expect(workflows.latest("remind")).resolves.toMatchObject({ runId: "sess" });
    await expect(workflows.live("remind", "garage")).resolves.toBeUndefined();
    await expect(
      workflows.signalRun(remind, "kitchen", "approved", { ok: 1 }, { holdMs: 0 }),
    ).resolves.toBe(true);
    expect(workflows.signals).toEqual([
      {
        workflow: "remind",
        key: "kitchen",
        label: "approved",
        payload: { ok: 1 },
        options: { holdMs: 0 },
      },
    ]);
  });

  test("cancel marks an unfinished run and records every attempt", async () => {
    const workflows = createRecordingWorkflows({
      runs: [
        createRunSnapshot({ workflow: "remind", key: "k", runId: "wrun_pending" }),
        createRunSnapshot({
          workflow: "remind",
          key: "k",
          runId: "wrun_done",
          status: "cancelled",
        }),
      ],
    });
    await expect(workflows.cancel("wrun_pending")).resolves.toBe(true);
    await expect(workflows.cancel("wrun_done")).resolves.toBe(false);
    await expect(workflows.cancel("wrun_missing")).resolves.toBe(false);
    expect(workflows.cancelled).toEqual(["wrun_pending", "wrun_done", "wrun_missing"]);
    await expect(workflows.get("wrun_pending")).resolves.toMatchObject({ status: "cancelled" });
  });

  test("the progress-channel reads reject, naming the fix", async () => {
    const workflows = createRecordingWorkflows();
    await expect(workflows.streamTail("wrun_1")).rejects.toThrow(/createRecordingWorkflows/);
  });
});
