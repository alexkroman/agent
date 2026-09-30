// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeEval`'s `workflows`: a client, or a FACTORY built afresh per case
 * and per REPEAT, handed back to the case as `ctx.workflowClient`.
 *
 * FORCED into stub mode and TWO repeats at module scope, both read at
 * collection time. The repeat is the point: a downstream suite's recording
 * client was one module-level object whose log it reset by hand at the top
 * of every case, because a log carried from one repeat into the next makes
 * the second measure the first. Each case below asserts an EXACT count, and
 * counts its own passes, since a case failing only its second repeat would
 * otherwise be reported UNSTABLE and pass.
 */

import { agent, tool, workflow } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { createRecordingWorkflows, createRunSnapshot } from "@alexkroman1/aai/testing";
import { afterAll, expect, vi } from "vitest";
import { z } from "zod";
import { describeEval } from "./describe.ts";
import { toolResultIn } from "./events.ts";

vi.stubEnv("AAI_EVAL_STUB", "1");
vi.stubEnv("AAI_EVAL_REPEAT", "2");

const passes = new Map<string, number>();
const passed = (name: string): void => void passes.set(name, (passes.get(name) ?? 0) + 1);
afterAll(() => {
  // A throw rather than an `expect`: a hook is not a test.
  const counts = [...passes.values()];
  if (counts.length !== 3 || counts.some((n) => n !== 2)) {
    throw new Error(
      `every case must pass BOTH repeats; passes: ${JSON.stringify(Object.fromEntries(passes))}`,
    );
  }
});

const remind = workflow({ input: z.object({ text: z.string() }), run: async () => ({}) });

const remindMe = tool({
  description: "Set a reminder.",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }, ctx) => ({ runId: await ctx.workflows.start(remind, { text }) }),
});

const def = withTools(agent({ name: "Workflow Client Suite", workflows: { remind } }), {
  remind_me: remindMe,
});

/** A client that RECORDS what it was asked to start — the SDK's, its log typed. */
const recordingWorkflows = () => createRecordingWorkflows({ workflows: def.workflows });

const REMIND = { stubReply: [{ tool: "remind_me", args: { text: "plumber" } }, "Okay."] };

describeEval(
  def,
  (test) => {
    test(
      "a factory's client is this case's ctx.workflows, fresh on every repeat",
      async ({ session, workflowClient, workflows }) => {
        const turn = await session.say("remind me to call the plumber");
        expect(toolResultIn(turn.toolCalls, "remind_me")).toEqual({ runId: "wrun_rec_1" });
        // Typed: the log is the factory's own, and it holds THIS repeat alone.
        expect(workflowClient.started("remind").map((s) => s.input)).toEqual([{ text: "plumber" }]);
        // Recorded, never run: the run it "started" reads back as running.
        await expect(workflowClient.get("wrun_rec_1")).resolves.toMatchObject({
          status: "running",
        });
        // A suite that supplied its own client gets no engine.
        expect(workflows).toBeUndefined();
        passed("factory");
      },
      REMIND,
    );
  },
  { workflows: recordingWorkflows },
);

const cancelAll = tool({
  description: "Cancel every pending reminder.",
  execute: async (_args, ctx) => {
    const pending = (await ctx.workflows.find(remind, "kitchen")).filter(
      (run) => run.status === "running",
    );
    for (const run of pending) await ctx.workflows.cancel(run.runId);
    return { cancelled: pending.length };
  },
});

const cancelDef = withTools(agent({ name: "Seeded Runs Suite", workflows: { remind } }), {
  cancel_reminders: cancelAll,
});

describeEval(
  cancelDef,
  (test) => {
    test(
      "a case seeds the runs find answers from, and reads what was cancelled",
      async ({ session, workflowClient }) => {
        workflowClient.seed(
          createRunSnapshot({ workflow: "remind", key: "kitchen", runId: "wrun_pending" }),
          createRunSnapshot({
            workflow: "remind",
            key: "kitchen",
            runId: "wrun_done",
            status: "completed",
            output: {},
          }),
        );
        const turn = await session.say("cancel my reminders");
        expect(toolResultIn(turn.toolCalls, "cancel_reminders")).toEqual({ cancelled: 1 });
        expect(workflowClient.cancelled).toEqual(["wrun_pending"]);
        passed("seeded");
      },
      { stubReply: [{ tool: "cancel_reminders" }, "Done."] },
    );
  },
  { workflows: () => createRecordingWorkflows({ workflows: cancelDef.workflows }) },
);

describeEval(def, (test) => {
  test(
    "with no client of its own, ctx.workflowClient is the engine's",
    async ({ session, workflowClient, workflows }) => {
      await session.say("remind me to call the plumber");
      expect(workflows).toBeDefined();
      expect(workflowClient).toBe(workflows?.client);
      passed("engine");
    },
    REMIND,
  );
});
