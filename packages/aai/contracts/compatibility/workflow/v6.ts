// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 6.
 *
 * Epoch 6 adds `StartOptions.notify`, which is what makes a voice agent's "I'll
 * let you know" true: a run started from a turn finishes minutes later with no
 * turn to land in, so the agent takes an unprompted one built from the run's own
 * output. Epochs 1 through 5 are unchanged and retained, so this file
 * demonstrates only what is new.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { type StartOptions, tool, workflow } from "../../../index.ts";

export const research = workflow({
  description: "Look into a topic and report back.",
  input: z.object({ topic: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { topic: input.topic, summary: "…" };
  },
});

/** Both halves of a handoff: the durable handle, and the live announcement. */
const options: StartOptions = {
  // Survives the call — the next one finds the run by it.
  key: "caller-1",
  // Reaches THIS call, while it lasts. `true` takes the default instruction.
  notify: "Tell them the research came back, then read the summary in one sentence.",
};

export const request_research = tool({
  description: "Start researching a topic; the caller is told when it lands.",
  inputSchema: z.object({ topic: z.string() }),
  async execute(args, ctx) {
    const runId = await ctx.workflows.start(
      research,
      { topic: args.topic },
      { ...options, key: ctx.sessionId },
    );
    return { started: true, runId };
  },
});

/** The plainest spelling, for an agent happy with the default sentence. */
export const request_plain = tool({
  description: "Start researching a topic.",
  inputSchema: z.object({ topic: z.string() }),
  async execute(args, ctx) {
    return {
      runId: await ctx.workflows.start(research, { topic: args.topic }, { notify: true }),
    };
  },
});
