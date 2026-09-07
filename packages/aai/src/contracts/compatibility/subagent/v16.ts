// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:subagent` epoch 16.
 *
 * A desk that delegates: one subagent declared at module scope with an
 * `expectedOutput` and a `guardrail`, a second on a ROSTER for the model to
 * choose from, and the tool that hands one a bounded task. Written the way it
 * was authored at epoch 16, and it must keep compiling for as long as that
 * epoch is advertised as supported.
 *
 * ## What moved, and why epoch 16 survives it
 *
 * Epoch 17 ADDED `SubagentDef.schema` — an optional shape for the final
 * message — plus the two types that carry it (`TypedSubagentDef`,
 * `TypedDelegateResult`), and turned `DelegateFn` into an OVERLOAD: a subagent
 * declaring a schema answers with a parsed `object`, one that does not answers
 * with the same `DelegateResult` it always did.
 *
 * An overload is the additive shape here, and it is why nothing below moves.
 * Making `DelegateFn` generic instead would have put a type parameter on every
 * `ctx.delegate` call, and a plain `SubagentDef` would then have answered with
 * an `object` field typed `unknown` that is `undefined` at run time — a
 * property this file's {@link summarizeFindings} would be able to read and
 * never get a value from. The second overload keeps it absent.
 *
 * Nothing here declares a schema, deliberately: this file is evidence about
 * epoch 16's surface, and the guardrail below is exactly the shape epoch 17
 * suggests a schema for. Both still work, which is the claim.
 */

import { z } from "zod";
import {
  DEFAULT_GUARDRAIL_MAX_RETRIES,
  type DelegateResult,
  type GuardrailVerdict,
  type SubagentAnswer,
  type SubagentDef,
  type SubagentRoster,
  type SubagentToolCall,
  subagent,
  type ToolDef,
  tool,
} from "../../../index.ts";

/** The verdicts the desk can act on — carried as a sentence PREFIX at epoch 16. */
const PREFIXES = ["Confirmed:", "Contradicted:", "Unclear:"] as const;

/**
 * A checker whose answer shape is policed by a guardrail.
 *
 * The epoch-17 way to say this is `schema`; the guardrail still compiles and
 * still runs, which is what this file is here to prove.
 */
export const checker: SubagentDef = subagent({
  name: "checker",
  description: "Check one claim against the web.",
  systemPrompt: "Check ONE claim. 'Unclear' is a real answer.",
  expectedOutput: `One sentence starting with one of ${PREFIXES.join(" ")}.`,
  guardrail: ({ text }: SubagentAnswer): GuardrailVerdict =>
    PREFIXES.some((prefix) => text.trimStart().startsWith(prefix)) ||
    `Start with exactly one of ${PREFIXES.join(" ")}.`,
  maxRetries: DEFAULT_GUARDRAIL_MAX_RETRIES,
  builtinTools: ["web_search"],
  maxSteps: 2,
});

/** A second role, on the ROSTER — the model picks it by description. */
export const explainer: SubagentDef = subagent({
  name: "explainer",
  description: "Explain a finding in plain language.",
  systemPrompt: "Explain what you are given, simply.",
  expectedOutput: "Two sentences, no jargon.",
});

/** `agent({ subagents })` takes this; a rostered call is untyped by design. */
export const roster: SubagentRoster = [checker, explainer];

/** How many searches an attempt paid for. */
export function searchesIn(calls: readonly SubagentToolCall[]): number {
  return calls.filter((call) => call.name === "web_search").length;
}

/**
 * The tool that delegates — the plain overload, answering a `DelegateResult`.
 *
 * `accepted` is read rather than assumed: a guardrail that ran out of retries
 * returns the last REJECTED answer, and a desk on a live call needs to know it
 * is quoting one.
 */
export const verifyClaim: ToolDef = tool({
  description: "Check a claim the desk already said out loud.",
  inputSchema: z.object({ claim: z.string().min(1) }),
  async execute({ claim }, ctx) {
    const result: DelegateResult = await ctx.delegate(checker, {
      task: claim,
      context: "The desk asserted this earlier in the call.",
    });
    return {
      verdict: result.text,
      searches: searchesIn(result.toolCalls),
      revisions: result.revisions,
      ...(result.accepted ? {} : { unusable: result.complaint }),
    };
  },
});

/** Reading a rostered answer, which has no parsed object at either epoch. */
export async function summarizeFindings(
  delegate: (sub: SubagentDef, options: { task: string }) => Promise<DelegateResult>,
  findings: readonly string[],
): Promise<string> {
  const answer = await delegate(explainer, { task: findings.join("\n") });
  return answer.text;
}
