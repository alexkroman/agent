// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `agent` epoch 5.
 *
 * See `./v1.ts` for what "frozen" obliges and why the imports are relative.
 *
 * **Nothing was added to this capability's own exports.** The epoch moved
 * transitively for the second time: an agent's tools take a `ToolContext`, whose
 * `workflows` client gained `streamTail` (epoch 4 was `wakeUp` and `stream`).
 * What this file asserts is the same thing epoch 4's did — that declaring an
 * agent is unaffected — with a tool that bounds its progress read by the tail
 * rather than waiting for an end a progress channel never reaches.
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
  name: "Contract Fixture (epoch 5)",
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
    progress: tool({
      description: "Say what the newest digest is doing.",
      execute: async (_args, ctx) => {
        const [latest] = await ctx.workflows.find(digest, ctx.sessionId, { limit: 1 });
        if (!latest) return { note: "nothing started" };
        // The tail first, and not as an optimization: an empty progress channel
        // is never closed, so reading one waits rather than answering.
        if ((await ctx.workflows.streamTail(latest.runId)) < 0) return { note: "nothing yet" };
        const stream = await ctx.workflows.stream(latest.runId, { startIndex: -1 });
        for await (const chunk of stream) return { progress: String(chunk) };
        return { note: "nothing yet" };
      },
    }),
  },
});
