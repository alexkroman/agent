// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 7.
 *
 * **Epoch 7 is a RIPPLE, not a change to this capability.** `StartOptions`
 * gained `notify` — ask to be told when a run finishes — and this capability's
 * report mentions that type through a public signature, so its hash moved while
 * nothing an author writes here did. `aai:workflow` epoch 6 is where the
 * addition is demonstrated.
 *
 * So this file is epoch 6's example, re-frozen: what it proves is exactly
 * what a re-frozen epoch should prove — that the authoring shape still compiles
 * against current source. See `../agent/v1.ts` for what "frozen" obliges and why
 * the imports are relative.
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
