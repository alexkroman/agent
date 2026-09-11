// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 3.
 *
 * Epoch 4 changed nothing an agent DECLARES. What moved is one layer down:
 * `ToolDef` gained an optional `messages` field, and `AgentDef.tools` names
 * `ToolDef`, so this capability's report moved with it. That makes the promise
 * this file holds an unusually clean one — every epoch-3 declaration still
 * compiles, because none of them is about a tool's own speech.
 *
 * So the front half is an ordinary epoch-3 agent: a system prompt RESOLVER
 * rather than a string (`AgentSystemPrompt` over `AgentSessionContext`), the
 * four field groups that live on their own interfaces
 * (`PipelineVoiceTuning`, `AgentModelTuning`, `AgentGuardrails`,
 * `AgentObservation`), and the observation half wired to a session event.
 *
 * If a later epoch obliges an agent to declare its tools' speech, moves the
 * resolver's parameter, or folds one of the four interfaces back into
 * `AgentDef` with a required member, this file reddens — the signal to DROP
 * the epoch rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **The back half is a roll-call.** Coverage is measured per capability over
 * the union of its frozen examples, and the eight names below are the ones
 * `v1.ts` and `v2.ts` never reach — the four field-group interfaces and their
 * members. A fixture that names one signature freezes one signature.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so
 * the fixture would prove the CURRENT surface compiles rather than epoch 3's.
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

/** The prompt as a function of the session, resolved per model request. */
const houseRules: AgentSystemPrompt = (ctx: AgentSessionContext) =>
  `You are the support line for a bicycle shop. Session ${ctx.sessionId}.`;

/** An input guardrail: a verdict, not a rewrite. */
const noPricing: AgentGuardrail = (text) =>
  text.includes("wholesale") ? "I can't discuss wholesale pricing." : true;

/** The three groups an epoch-3 agent could declare, each as its own value. */
const limits: UsageLimits = { totalTokens: 200_000 };
const tuning: AgentModelTuning = { temperature: 0.4, maxOutputTokens: 512, usageLimits: limits };
const guardrails: AgentGuardrails = { inputGuardrails: [noPricing] };
const observation: AgentObservation = {
  events: { "user-transcript.committed": () => undefined },
};

export const supportAgent = agent({
  name: "Bike Support",
  greeting: "Bike shop, how can I help?",
  systemPrompt: houseRules,
  // Pipeline voice tuning, declared inline the way an epoch-3 agent did.
  minTurnSilenceMs: 1600,
  ...tuning,
  ...guardrails,
  ...observation,
});

/**
 * `AgentInstructions` is the RESOLVER half of `AgentSystemPrompt` — the arm a
 * per-session prompt is written as, pinned separately because `systemPrompt`
 * accepts the string too and the union would compile without it.
 */
export const instructions: AgentInstructions = (ctx) =>
  `Never quote a delivery date. Session ${ctx.sessionId}.`;
