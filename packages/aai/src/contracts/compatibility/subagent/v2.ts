// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:subagent` epoch 2.
 *
 * Epoch 3 changed nothing about declaring a subagent or delegating to one.
 * What moved is `ToolDef` — it gained an optional `messages` field, the
 * agent's own speech around a tool call — and `ToolContext` carries
 * `ctx.delegate`, so this capability's report moved with it. A subagent's own
 * tools are `ToolDef`s too.
 *
 * The promise is that an epoch-2 roster and an epoch-2 `ctx.delegate` call
 * both still compile: a `subagent()` with a guardrail and retries, a TYPED one
 * whose `schema` makes the answer an `object`, the roster the model routes
 * over, and the in-code call site that names its subagent instead.
 *
 * Coverage is per capability over the union of frozen examples, and `v1.ts`
 * already names all fourteen of this one's exports, so this file is about the
 * transition rather than a roll-call. Its specifiers are RELATIVE, so it
 * proves epoch 2's surface compiles rather than the current build's.
 *
 * @module
 */

import { z } from "zod";

import type { SubagentRoster, ToolContext } from "../../../index.ts";
import { subagent } from "../../../index.ts";

export const researcher = subagent({
  name: "researcher",
  description: "Finds and summarizes background on a topic.",
  systemPrompt: "Research the task and answer in three sentences with a link.",
  guardrail: (answer) => (answer.text.includes("http") ? true : "Cite a source."),
  maxRetries: 2,
});

export const triager = subagent({
  name: "triager",
  description: "Decides how urgent an incoming report is.",
  systemPrompt: "Classify the report.",
  schema: z.object({ urgency: z.enum(["low", "high"]) }),
});

/** The set the MODEL picks from, published as one `delegate` tool. */
export const desk: SubagentRoster = [researcher, triager];

/** And the call site that names its subagent in code instead. */
export async function urgency(ctx: ToolContext, report: string): Promise<"low" | "high"> {
  const result = await ctx.delegate(triager, { task: report });
  return result.object.urgency;
}
