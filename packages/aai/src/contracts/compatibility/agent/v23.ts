// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 23.
 *
 * The `agent.ts` of a voice agent: a name, a prompt, the builtins it commands,
 * a `syncState` projection, and the subagent roster the model chooses from.
 * Written the way it was authored at epoch 23, and it must keep compiling for
 * as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 23 survives it
 *
 * Nothing in this capability's own surface. `agent()` takes what it always
 * took, and the report moved for two types it REACHES: `ToolContext`, which
 * gained `deadlineAt`, and `SubagentDef`, which gained an optional `schema`.
 * A rollup follows every type a signature touches, and `AgentParams` carries
 * both — `subagents` is a `SubagentRoster`, and a tool's context is one hop
 * further down.
 *
 * Both are additive for an author: nothing here sets a schema, nothing here
 * names `deadlineAt`, and a def written before either existed resolves to the
 * same config. {@link deskConfig} converts it the way `aai build` does, so the
 * frozen claim is about the CONFIG a deploy carries and not merely about the
 * literal type-checking.
 */

import {
  type AgentDef,
  agent,
  type BuiltinTool,
  type SubagentRoster,
  sessionSlot,
  subagent,
  type TelephonyAccess,
  type TelephonyCarrier,
} from "../../../index.ts";
import type { AgentConfig } from "../../../sdk/manifest-barrel.ts";
import { toAgentConfig } from "../../../sdk/manifest-barrel.ts";

const shiftSlot = sessionSlot("shift", () => ({ handled: 0 }));

/** Two roles the model picks between — a roster, not a call-site choice. */
const roster: SubagentRoster = [
  subagent({
    name: "explainer",
    description: "Explain a policy in plain language.",
    systemPrompt: "Explain what you are given, simply.",
    expectedOutput: "Two sentences, no jargon.",
  }),
  subagent({
    name: "counterpoint",
    description: "Argue the other side of a claim.",
    systemPrompt: "Give the strongest opposing case.",
    expectedOutput: "Three sentences.",
  }),
];

/** The builtins the prompt commands, named through the published union. */
const builtinTools: BuiltinTool[] = ["web_search", "run_code"];

/**
 * Which carriers may reach this agent — declared, not inferred.
 *
 * An epoch-23 agent that took phone calls said so here, and the union is the
 * published one rather than a string, so a carrier the platform cannot route is
 * a compile error and not a silent no-answer.
 */
const carriers: readonly TelephonyCarrier[] = ["twilio"];
export const telephony: TelephonyAccess = carriers;

/**
 * The def a deployed agent runs.
 *
 * No `llm`/`stt`/`tts`: the default all-AssemblyAI cascade is what makes it run
 * the moment it is deployed, which is the epoch-23 starter shape.
 */
export const desk: AgentDef = agent({
  name: "Policy Desk",
  systemPrompt: "Answer policy questions. Use web_search before quoting a figure.",
  greeting: "Policy desk — what can I look up?",
  builtinTools,
  subagents: roster,
  syncState: shiftSlot.projection((shift) => ({ handled: shift.handled })),
  requiredEnv: ["POLICY_API_KEY"],
  telephony,
});

/** The same conversion `aai build` and `aai deploy` run. */
export const deskConfig: AgentConfig = toAgentConfig(desk);
