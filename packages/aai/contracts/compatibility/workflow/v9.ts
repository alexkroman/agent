// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow` epoch 9.
 *
 * Epoch 9 is what is LEFT on the root barrel once the RUN vocabulary moved to
 * `@alexkroman1/aai/workflow-api`: DECLARING a workflow, and the type of the
 * handle `ToolContext` hands a tool.
 *
 * The line is who READS a thing. An `agent.ts` declares a workflow, so
 * `workflow()` and `WorkflowDef` are beside `agent()` and `tool()`. A page
 * renders a run, a script polls one, and a tool annotating what
 * `ctx.workflows.get()` returned is doing the same job from inside — so the
 * option bags, the snapshot union, its guard, `WorkflowOutputOf` and the wait
 * cap are on the subpath that already existed for exactly that audience. See
 * `../workflow-api/v9.ts`.
 *
 * Starting a run is UNCHANGED and needs no import at all: `ctx.workflows.start`
 * takes the def and returns a `string`.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { agent, tool, type WorkflowDef, workflow } from "../../../index.ts";

export const digest = workflow({
  description: "Research a topic overnight and store the result",
  input: z.object({ topic: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { topic: input.topic, summary: "…" };
  },
});

/** A helper that takes a declaration — the reason `WorkflowDef` stays on the root. */
export function describe(def: WorkflowDef): string {
  return def.description ?? "(undescribed)";
}

/**
 * The tool that starts one. Passing the DEF rather than its name is what types
 * the input against the workflow's own schema and turns a misspelling into a
 * compile error; `key` is what lets a later turn — or a later CALL — find it.
 */
export const research = tool({
  description: "Kick off overnight research on a topic",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }, ctx) => {
    const runId = await ctx.workflows.start(digest, { topic }, { key: ctx.sessionId });
    return `Working on it — run ${runId}.`;
  },
});

export default agent({
  name: "Researcher",
  workflows: { digest },
});
