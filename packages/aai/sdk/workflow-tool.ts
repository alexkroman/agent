// Copyright 2026 the AAI authors. MIT license.
/**
 * `startTool()` — the tool that starts a workflow, in one line.
 *
 * Every voice agent that owns a workflow writes the same tool: take the
 * workflow's own input, start a run, answer the turn. Hand-written it is three
 * readable lines, and a wrapper around three readable lines is usually not worth
 * having — this repo deleted a whole pattern-combinator layer
 * (`@alexkroman1/aai/patterns`) for exactly that reason.
 *
 * What makes this one different is the CORRELATION KEY. `workflow_status` can
 * only report a run that was started with one, and nothing anywhere fails when
 * an author omits it: the run works, the tool answers, and the follow-up
 * question "is it ready yet?" is silently unanswerable for the rest of the call.
 * That is the failure a default closes, and it cannot be defaulted inside
 * `start` — a page's run legitimately has no session to key on. So it is
 * defaulted HERE, at the one call site that always does.
 *
 * The second thing it removes is a duplicated schema: the tool's `inputSchema`
 * IS the workflow's `input`, so an author who writes the tool by hand either
 * restates the schema or widens it and loses the validation `start` would have
 * done anyway.
 */

import { tool } from "./define.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import type { WorkflowDef } from "./workflow.ts";

/** Options for {@link startTool}. */
export type StartToolOptions = {
  /** What the LLM reads to decide whether to call this. Required, as on any tool. */
  description: string;
  /**
   * What the tool answers once the run is journaled. Defaults to
   * `{ runId, status: "started" }`.
   *
   * The default deliberately does NOT phrase a sentence: the model composes the
   * reply, and a canned "I'll get right on that" competes with the system
   * prompt's voice rather than informing it.
   */
  reply?: (runId: string) => unknown;
  /**
   * Correlation key for the run, so a later turn — or a later call — can find
   * it. Defaults to `ctx.sessionId`, which is what makes the `workflow_status`
   * builtin able to report it.
   *
   * Override when the run belongs to something longer-lived than the session: a
   * phone number, an account id, an order.
   */
  key?: (ctx: ToolContext) => string;
};

/**
 * Build the tool that starts `workflow`.
 *
 * The tool's `inputSchema` is the workflow's own, so the LLM is shown exactly
 * the arguments the run validates against, and the run is keyed to the session
 * by default.
 *
 * @example
 * ```ts
 * import { agent, startTool, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const digest = workflow({
 *   input: z.object({ topic: z.string() }),
 *   run: ({ topic }) => ({ topic }),
 * });
 *
 * export default agent({
 *   name: "Researcher",
 *   workflows: { digest },
 *   builtinTools: ["workflow_status"],
 *   tools: {
 *     research: startTool(digest, { description: "Start overnight research on a topic" }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function startTool<P extends ToolInputSchema, R>(
  workflow: WorkflowDef<P, R>,
  options: StartToolOptions,
): ToolDef<P> {
  const { description, reply = (runId: string) => ({ runId, status: "started" }) } = options;
  const keyOf = options.key ?? ((ctx: ToolContext) => ctx.sessionId);
  return tool<P>({
    description,
    // Present only when the workflow declared one — `inputSchema` is optional on
    // both sides, so a schemaless workflow yields a schemaless tool rather than
    // an empty object schema the LLM would read as "takes no arguments".
    ...(workflow.input === undefined ? {} : { inputSchema: workflow.input }),
    execute: async (args: InferSchemaOutput<P>, ctx: ToolContext) => {
      const runId = await ctx.workflows.start(workflow, args, { key: keyOf(ctx) });
      return reply(runId);
    },
  });
}
