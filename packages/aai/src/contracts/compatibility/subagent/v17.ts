// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:subagent` epoch 17.
 *
 * The same desk as {@link ../subagent/v16.ts}, written the epoch-17 way: the
 * checker declares a `schema`, and the tool reads the PARSED verdict instead of
 * a sentence it must find a word in. Written the way it was authored at epoch
 * 17, and it must keep compiling for as long as that epoch is advertised as
 * supported.
 *
 * ## What moved, and why epoch 17 survives it
 *
 * Epoch 18 EXPORTS two names epoch 17 could not spell: `TypedSubagentDef` and
 * `TypedDelegateResult`, the two halves of the typed surface. Nothing about the
 * behaviour changed with them — a schema-declaring subagent already answered
 * with a parsed `object` at epoch 17, because `subagent()` and `DelegateFn` are
 * OVERLOADED and the types were reached through inference rather than by name.
 *
 * So this file names NEITHER, deliberately, and that is the frozen claim: an
 * author who never writes the type down still gets it. {@link verdictOf}
 * returns the parsed union by inference alone, and would stop compiling if the
 * overload stopped selecting.
 */

import { z } from "zod";
import {
  DELEGATE_TOOL_NAME,
  type SubagentGuardrail,
  subagent,
  type ToolContext,
  type ToolDef,
  tool,
} from "../../../index.ts";

const Verdict = z.object({
  verdict: z.enum(["confirmed", "contradicted", "unclear"]),
  detail: z.string().min(1),
});

/**
 * A checker whose answer SHAPE is the schema's, not a sentence prefix's.
 *
 * No `guardrail`: at epoch 17 the split was already the documented one — a
 * schema settles the shape, a guardrail judges what a shape cannot express.
 */
export const checker = subagent({
  name: "checker",
  description: "Check one claim against the web.",
  systemPrompt: "Check ONE claim. 'unclear' is a real answer.",
  expectedOutput: "`detail` is one sentence naming what you found.",
  schema: Verdict,
  builtinTools: ["web_search"],
  maxSteps: 2,
});

/**
 * The tool that delegates, reading the parsed object.
 *
 * `result.object` is typed by inference off `checker`'s schema — the return
 * annotation below is what proves it, since a widened `unknown` would not
 * satisfy it.
 */
export const verifyClaim: ToolDef = tool({
  description: "Check a claim the desk already said out loud.",
  inputSchema: z.object({ claim: z.string().min(1) }),
  async execute({ claim }, ctx) {
    const result = await ctx.delegate(checker, { task: claim });
    if (!result.accepted) {
      return { verdict: null, detail: result.text, unusable: result.complaint };
    }
    return { verdict: result.object.verdict, detail: result.object.detail };
  },
});

/**
 * A guardrail BESIDE a schema — the split epoch 17 documents.
 *
 * The schema settles that `verdict` is one of three words; this is the
 * judgement no shape can express, and a subagent may declare both.
 */
export const citesSomething: SubagentGuardrail = ({ toolCalls }) =>
  toolCalls.length > 0 || "Search before answering — say what you looked at.";

/** The name a ROSTERED delegation reaches the model under. */
export const rosterToolName: string = DELEGATE_TOOL_NAME;

/**
 * The parsed union, by INFERENCE and with no type written down.
 *
 * The return annotation is the proof: `result.object` would be `unknown` if the
 * overload stopped selecting on `checker`'s schema, and `unknown` does not
 * satisfy this signature. An epoch-17 author had no name for the type and did
 * not need one.
 */
export async function verdictOf(
  ctx: ToolContext,
  claim: string,
): Promise<"confirmed" | "contradicted" | "unclear"> {
  const result = await ctx.delegate(checker, { task: claim });
  return result.object.verdict;
}
