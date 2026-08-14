// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 2.
 *
 * Epoch 2 added the synchronous wait — `MAX_WORKFLOW_WAIT_MS` and
 * `clampWorkflowWait`, the published cap on how long a caller may block on a
 * run and the helper that applies it. Everything epoch 1 could express still
 * compiles (see `./v1.ts`, retained for that reason); this file covers only
 * what epoch 2 added.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { clampWorkflowWait, MAX_WORKFLOW_WAIT_MS, tool, workflow } from "../../../index.ts";

export const settle = workflow({
  description: "Settle an invoice.",
  input: z.object({ invoiceId: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { invoiceId: input.invoiceId, settled: true };
  },
});

/**
 * A caller reproducing the host's own clamp before asking for a wait — the
 * reason the cap is published rather than merely enforced.
 */
export const waitBudget: number = clampWorkflowWait(90_000);
export const unspecifiedBudget: number = clampWorkflowWait(undefined);
export const cap: number = MAX_WORKFLOW_WAIT_MS;

export const startAndWait = tool({
  description: "Settle an invoice and report the outcome.",
  inputSchema: z.object({ invoiceId: z.string() }),
  async execute(args, ctx) {
    const runId = await ctx.workflows.start(settle, { invoiceId: args.invoiceId });
    return { runId, waitedFor: clampWorkflowWait(MAX_WORKFLOW_WAIT_MS + 1) };
  },
});
