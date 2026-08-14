// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 1.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import {
  isTerminal,
  TERMINAL_WORKFLOW_STATUSES,
  type TerminalWorkflowRun,
  tool,
  type WorkflowOutputOf,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowSummary,
  workflow,
} from "../../../index.ts";

/** A durable workflow, declared with an input schema and a typed return. */
export const enrichLead = workflow({
  description: "Enrich a lead from its email domain.",
  input: z.object({ email: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { domain: input.email.split("@").at(1) ?? "", score: 0 };
  },
});

export type EnrichOutput = WorkflowOutputOf<typeof enrichLead>;

/** A workflow with no input at all. */
export const nightlySweep = workflow({
  description: "Sweep stale records.",
  run() {
    return { swept: 0 };
  },
});

/** Everything `ctx.workflows` offered a tool body at epoch 1. */
export const startEnrichment = tool({
  description: "Kick off lead enrichment and report on it.",
  inputSchema: z.object({ email: z.string() }),
  async execute(args, ctx) {
    const runId = await ctx.workflows.start(enrichLead, { email: args.email }, { key: args.email });

    // Typed `get`, via the definition.
    const run = await ctx.workflows.get(runId, enrichLead);
    if (run !== undefined && isTerminal(run)) {
      const terminal: TerminalWorkflowRun<EnrichOutput> = run;
      if (terminal.status === "completed") {
        const output: EnrichOutput = terminal.output;
        return { runId, domain: output.domain };
      }
    }

    // Untyped `get`, by run id alone.
    const anyRun: WorkflowRunSnapshot | undefined = await ctx.workflows.get(runId);
    const status: WorkflowRunStatus | undefined = anyRun?.status;

    const byKey = await ctx.workflows.find(enrichLead, args.email, { limit: 5 });
    const recent = await ctx.workflows.recent(enrichLead, { limit: 5 });
    const byName = await ctx.workflows.find("enrichLead", args.email);
    const cancelled: boolean = await ctx.workflows.cancel(runId);
    const listing: WorkflowSummary[] = ctx.workflows.listing();

    return {
      runId,
      status,
      cancelled,
      found: byKey.length + recent.length + byName.length,
      known: listing.map((entry) => entry.name),
      terminalStatuses: [...TERMINAL_WORKFLOW_STATUSES],
    };
  },
});

/** Starting by NAME, the string form a page or another workflow uses. */
export const startByName = tool({
  description: "Start a workflow by name.",
  async execute(_args, ctx) {
    return { runId: await ctx.workflows.start("nightlySweep") };
  },
});
