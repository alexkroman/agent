// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `agent` epoch 4.
 *
 * See `./v1.ts` for what "frozen" obliges and why the imports are relative.
 *
 * **Nothing was added to this capability's own exports.** The epoch moved
 * transitively: an agent's tools take a `ToolContext`, whose `workflows` client
 * gained `wakeUp` and `stream`. What this file asserts is that declaring an
 * agent is unaffected by that — the same `agent({ workflows, tools })` shape
 * epochs 1 through 3 wrote still compiles, now with a tool that reaches the
 * wider client.
 */

import { z } from "zod";

import { agent, tool, workflow } from "../../../index.ts";

export const digest = workflow({
  description: "Summarize a link.",
  input: z.object({ url: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { url: input.url, summary: "done" };
  },
});

export const deskAgent = agent({
  name: "Contract Fixture (epoch 4)",
  greeting: "Desk here.",
  systemPrompt: "Take requests and report on them.",
  workflows: { digest },
  tools: {
    request: tool({
      description: "Start a digest.",
      inputSchema: z.object({ url: z.string() }),
      execute: async (args, ctx) => ({
        runId: await ctx.workflows.start(digest, { url: args.url }, { key: ctx.sessionId }),
      }),
    }),
    hurry: tool({
      description: "Stop waiting on the newest digest.",
      execute: async (_args, ctx) => {
        const [latest] = await ctx.workflows.find(digest, ctx.sessionId, { limit: 1 });
        return { woken: latest ? await ctx.workflows.wakeUp(latest.runId) : 0 };
      },
    }),
  },
});
