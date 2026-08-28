// Copyright 2026 the AAI authors. MIT license.
/**
 * FROZEN authoring example — `aai:subagent`, epoch 3.
 *
 * Moved with the `AgentParams` split. Delegation is unchanged and epoch 3 is
 * RETAINED: this is how a subagent was declared and run from a tool.
 */

import { z } from "zod";
import {
  type DelegateOptions,
  type DelegateResult,
  type SubagentDef,
  subagent,
  type ToolContext,
  tool,
} from "../../../index.ts";

/** Note `instructions`, not `systemPrompt` — the epoch-3 spelling. */
export const researcher: SubagentDef = subagent({
  name: "Researcher",
  instructions: "Find the answer and cite the page you found it on.",
  maxSteps: 8,
});

export const research = tool({
  description: "Research a question in depth",
  inputSchema: z.object({ question: z.string() }),
  async execute({ question }, ctx: ToolContext) {
    const options: DelegateOptions = { task: question };
    const result: DelegateResult = await ctx.delegate(researcher, options);
    return { answer: result.text };
  },
});
