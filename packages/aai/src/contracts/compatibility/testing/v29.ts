// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 29.
 *
 * A template's starter spec as it was authored at epoch 29 — the three
 * deployability invariants, a subagent's guardrail called the way the runtime
 * calls it, and a context with BOTH model seams scripted in one call. It must
 * keep compiling for as long as epoch 29 is advertised as supported.
 *
 * ## What moved, and why epoch 29 survives it
 *
 * Epoch 30 ADDED `dialogResultSchema`: the envelope a gated tool answers with,
 * as a zod schema around the tool's own, for an eval reading a serialized result
 * back through `toolResultIn`. Additive: no existing signature moved, and
 * nothing a spec already called behaves differently. What it replaces is the
 * `z.object({ result, state, done })` three evals had written out, which is not
 * a call on this capability and so is not frozen here.
 *
 * Nothing here names an epoch-30 export.
 *
 * ## What this file freezes, and where a break would land
 *
 * `v28.ts` and `v28-slots.ts` freeze everything epoch 29 inherited; this file
 * names the SEVEN names epoch 29 added, which is what the per-capability
 * coverage rule asks of it. Three shapes, and each breaks in its own place:
 *
 * - **The invariants** ({@link deployable}, {@link builtinsDeclared}) are calls
 *   that take a def and answer a config or a list, so a parameter that narrows
 *   or a return that changes shape reddens at the call.
 * - **The guardrail runner** ({@link verdictOn}) takes the def, the text and a
 *   PARTIAL answer, and answers the synchronous verdict union — a runner that
 *   started returning a promise would redden the `=== true` below.
 * - **The scripted context** ({@link desk}) is an options bag written by the
 *   caller and a result read by it: {@link SCRIPT} freezes the two route tables
 *   and the pass-through override, and the three fields read off the result are
 *   the ones a spec drives and asserts on.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 29 has to be dropped with a reason.
 */

import {
  agent,
  type BuiltinTool,
  type GuardrailVerdict,
  type SubagentDef,
  subagent,
} from "@alexkroman1/aai";
import type { AgentConfig } from "@alexkroman1/aai/manifest";
import {
  commandedBuiltins,
  expectDeployable,
  expectPromptBuiltinsDeclared,
  runGuardrail,
  type ScriptedToolContext,
  type ScriptedToolContextOptions,
  scriptedToolContext,
} from "../../../sdk/testing-barrel.ts";

// ── The starter invariants ───────────────────────────────────────────────

/** The agent every starter spec opens on. */
const DEF = agent({
  name: "Frozen Desk",
  systemPrompt: "Use web_search before answering a question about prices.",
  builtinTools: ["web_search"],
});

/**
 * The platform has something to list, and the prompt's builtins are declared.
 *
 * `expectDeployable` answers the CONFIG, which is what `commandedBuiltins` reads
 * — so the two compose without a second `toAgentConfig`, and that composition is
 * frozen here on purpose.
 */
export function deployable(): AgentConfig {
  const config: AgentConfig = expectDeployable(DEF);
  const commanded: BuiltinTool[] = commandedBuiltins(config);
  return commanded.length > 0 ? config : expectDeployable(DEF);
}

/** The prompt names a builtin the def declares, and the call says which. */
export function builtinsDeclared(): BuiltinTool[] {
  return expectPromptBuiltinsDeclared(DEF);
}

// ── A guardrail, called the way the runtime calls it ─────────────────────

/** A checker whose answer has to open with a verdict word. */
const CHECKER: SubagentDef = subagent({
  name: "fact-checker",
  systemPrompt: "Open with Confirmed:, Contradicted: or Unclear:.",
  guardrail: ({ text }) =>
    /^(Confirmed|Contradicted|Unclear):/.test(text) || "Open with a verdict word.",
});

/**
 * The verdict on one answer, with the cost the guardrail is handed.
 *
 * The third argument is a PARTIAL answer spread over the runner's zero-cost
 * default, so a guardrail that judges the cost gets one without the spec
 * building a whole `SubagentAnswer`.
 */
export function verdictOn(text: string): GuardrailVerdict {
  const verdict: GuardrailVerdict = runGuardrail(CHECKER, text, { steps: 2 });
  return verdict === true ? true : `refused: ${verdict}`;
}

// ── Both model seams, scripted in one call ───────────────────────────────

/**
 * The options bag: a `generate` table keyed by system prompt, a `delegate`
 * table keyed by subagent name, and any `createToolContext` override passed
 * straight through — `sessionId` here.
 */
const SCRIPT: ScriptedToolContextOptions = {
  generate: { "You grade retrieved documents.": { object: { score: 1 } } },
  delegate: { "fact-checker": "Both claims check out." },
  sessionId: "sess_frozen",
};

/** The context a spec runs tools against, and the two fakes it asserts on. */
export function desk(): ScriptedToolContext {
  const scripted: ScriptedToolContext = scriptedToolContext(SCRIPT);
  return scripted.model.calls.length + scripted.desk.calls.length === 0
    ? scripted
    : { ctx: scripted.ctx, model: scripted.model, desk: scripted.desk };
}
