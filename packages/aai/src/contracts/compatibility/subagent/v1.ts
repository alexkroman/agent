// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:subagent` epoch 1.
 *
 * Epoch 2 renamed the argument the ROSTER's generated tool takes — the one
 * `agent({ subagents })` publishes under {@link DELEGATE_TOOL_NAME} — from
 * `coworker` to `subagent`, so the word an author declares, the type they
 * declare it with, and the key the model fills in are finally the same word.
 * That is a change to the tool's JSON schema and to nothing anybody compiles
 * against: not one name, field or signature on this capability moved, and the
 * epoch's own export list is byte-identical across the transition.
 *
 * Which is exactly what makes this file worth having. Everything below is
 * authored the way it was at epoch 1 — a roster of `SubagentDef`s, a typed
 * subagent whose `schema` makes `ctx.delegate` answer an `object`, a
 * `guardrail` that sends a weak answer back, and a call-site delegation that
 * names its subagent in code — and every line of it compiles unchanged after
 * the rename, because the rename was never on this side of the wire.
 *
 * If a later epoch moves the roster into a shape an author has to spell
 * differently, or makes `description` required at a CALL SITE rather than only
 * on a roster entry, this file reddens — which is the signal to DROP the epoch
 * rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 14 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import { z } from "zod";

import type {
  DelegateFn,
  DelegateOptions,
  DelegateResult,
  GuardrailVerdict,
  SubagentAnswer,
  SubagentDef,
  SubagentGuardrail,
  SubagentRoster,
  SubagentToolCall,
  ToolContext,
  TypedDelegateResult,
  TypedSubagentDef,
} from "../../../index.ts";
import { DEFAULT_GUARDRAIL_MAX_RETRIES, DELEGATE_TOOL_NAME, subagent } from "../../../index.ts";

/**
 * A guardrail that sends a thin answer back rather than accepting it — the
 * same `true | string` vocabulary an agent-level guardrail answers in.
 */
const wantsSources: SubagentGuardrail = (answer: SubagentAnswer): GuardrailVerdict =>
  answer.text.includes("http") ? true : "Cite at least one source and try again.";

/** An untyped subagent: it answers prose, and the roster reads its description. */
export const researcher = subagent({
  name: "researcher",
  description: "Finds and summarizes background on a topic.",
  systemPrompt: "Research the task and answer in three sentences with a link.",
  expectedOutput: "Three sentences and one URL.",
  guardrail: wantsSources,
  maxRetries: DEFAULT_GUARDRAIL_MAX_RETRIES,
  maxSteps: 6,
  maxOutputTokens: 400,
  temperature: 0.3,
});

/** A TYPED one: `schema` is what makes `ctx.delegate` answer an `object`. */
export const triager = subagent({
  name: "triager",
  description: "Decides how urgent an incoming report is.",
  systemPrompt: "Classify the report.",
  schema: z.object({ urgency: z.enum(["low", "high"]), why: z.string() }),
});

/** The set the MODEL picks from, published as one `delegate` tool. */
export const desk: SubagentRoster = [researcher, triager];

/** And the CALL SITE, which names its subagent in code instead. */
export async function background(ctx: ToolContext, topic: string) {
  const options: DelegateOptions = {
    task: `Research ${topic}.`,
    context: "Phone call.",
    maxSteps: 4,
  };
  const answer: DelegateResult = await ctx.delegate(researcher, options);
  const triage: TypedDelegateResult<{ urgency: "low" | "high"; why: string }> = await ctx.delegate(
    triager,
    { task: `How urgent is ${topic}?` },
  );
  return {
    text: answer.text,
    accepted: answer.accepted,
    revisions: answer.revisions,
    complaint: answer.complaint,
    urgency: triage.object.urgency,
    // What the run DID, never the tool results that stayed inside it.
    used: answer.toolCalls.map((call: SubagentToolCall) => call.name),
    steps: answer.steps,
  };
}

/** The roster's tool is named for the ACT, and that did not change either. */
export const rosterToolName: "delegate" = DELEGATE_TOOL_NAME;

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  delegateFn: DelegateFn;
  delegateOptions: DelegateOptions;
  delegateResult: DelegateResult;
  guardrailVerdict: GuardrailVerdict;
  subagentAnswer: SubagentAnswer;
  subagentDef: SubagentDef;
  subagentGuardrail: SubagentGuardrail;
  subagentRoster: SubagentRoster;
  subagentToolCall: SubagentToolCall;
  typedDelegateResult: TypedDelegateResult<{ urgency: string }>;
  typedSubagentDef: TypedSubagentDef<{ urgency: string }>;
};

export const epoch1Values = [DEFAULT_GUARDRAIL_MAX_RETRIES, DELEGATE_TOOL_NAME, subagent] as const;
