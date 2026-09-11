// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 3.
 *
 * Epoch 4 added ONE optional field and the three types under it:
 * `agent({ lowConfidence })`, a `LowConfidencePolicy` whose `action` is a
 * `LowConfidenceAction` and whose `statistic` is a `LowConfidenceStatistic`.
 * The field acts on the recognizer's confidence in a committed turn before the
 * model sees it, and it is OPTIONAL — an epoch-3 agent declares none and
 * behaves exactly as it did, which is what this file pins.
 *
 * So the promise is the ordinary additive one: every epoch-3 declaration still
 * compiles, and the field-group interfaces it is written through
 * (`PipelineVoiceTuning` among them) still accept the same flat literal. If a
 * later epoch makes the policy required, moves it off the voice-tuning group,
 * or narrows a field an epoch-3 author was writing, this file reddens — which
 * is the signal to DROP the epoch rather than to edit the example.
 *
 * ## What it names, and why the list is short
 *
 * Epoch 3 promised 36 names and `v2.ts` beside this file already imports and
 * uses 28 of them — the gate's coverage rule is satisfied by the UNION of a
 * capability's frozen examples, so restating them here would be a copy that
 * can drift rather than a second proof. What is here is the eight names epoch
 * 3 ADDED over epoch 2 (the four field-group interfaces' own types and the
 * instruction pair), plus the declaration that exercises them.
 *
 * **Its specifiers are RELATIVE**, like every fixture here: importing the
 * package by name would resolve through its own `exports` map to whatever the
 * current build publishes, so the fixture would prove the CURRENT surface
 * compiles rather than that epoch 3's does.
 *
 * @module
 */

import type {
  AgentGuardrail,
  AgentGuardrails,
  AgentInstructions,
  AgentModelTuning,
  AgentObservation,
  AgentSessionContext,
  AgentSystemPrompt,
  UsageLimits,
} from "../../../index.ts";
import { agent } from "../../../index.ts";

/** An epoch-3 resolver: the instructions are computed per model request. */
const instructions: AgentInstructions = (ctx: AgentSessionContext) =>
  `The caller's session is ${ctx.sessionId}. Answer in one or two sentences.`;

/** An input guardrail, which is the only thing in an agent that may STOP a turn. */
const refuseShouting: AgentGuardrail = (text) =>
  text === text.toUpperCase() && text.length > 20 ? "Ask them to rephrase calmly." : true;

/**
 * The declaration an epoch-3 author wrote: a resolver for `systemPrompt`, the
 * two guardrail arrays, the sampling knobs and a token budget — every one of
 * them written FLAT, in one literal, though each arrives through a different
 * extended interface.
 */
export const desk = agent({
  name: "Front desk",
  systemPrompt: instructions,
  greeting: "Front desk, how can I help?",
  // AgentModelTuning
  temperature: 0.3,
  maxOutputTokens: 400,
  maxRetries: 2,
  resetToolChoice: true,
  usageLimits: { totalTokens: 120_000 },
  // AgentGuardrails
  inputGuardrails: [refuseShouting],
  outputGuardrails: [() => true],
  // AgentObservation
  events: { "tool.called": (event) => void event.toolName },
});

// ── The rest of what epoch 3 added over epoch 2.

export type Epoch3Types = {
  agentGuardrail: AgentGuardrail;
  agentGuardrails: AgentGuardrails;
  agentInstructions: AgentInstructions;
  agentModelTuning: AgentModelTuning;
  agentObservation: AgentObservation;
  agentSessionContext: AgentSessionContext;
  agentSystemPrompt: AgentSystemPrompt;
  usageLimits: UsageLimits;
};
