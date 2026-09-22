// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 10.
 *
 * Epoch 11 added ONE optional field, `AgentDef.personas` — a roster of
 * speakers the session hands the caller between (`aai:persona` is that
 * capability's own contract). Nothing an epoch-9 author wrote moved to reach
 * it: an agent that declares no roster is emitted the byte-identical prompt it
 * was at epoch 10, its tool table is filled by the same paths, and `HOST_ONLY_
 * AGENT_FIELDS` gained an entry without changing what `toAgentConfig` does to
 * any field an author already had.
 *
 * ## What this file has to name
 *
 * `v1.ts` through `v9.ts` are retained and between them name every export of
 * epoch 10 but ONE: `UserTurnLimit`, the type epoch 10 itself added and no
 * earlier example could carry. So the cap is declared below as a standalone
 * typed value. The rest is written around the presets — the field-group
 * interface built as a typed value and spread in, the name type an author
 * annotates a list with, and the shipped text read back — because that is the
 * shape an epoch-10 author had that a persona's `systemPrompt` sits BESIDE
 * from epoch 11 on: the agent's own prompt, presets and cap included, holds
 * under every persona.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
 *
 * @module
 */

import type {
  AgentDef,
  AgentVoicePresets,
  UserTurnLimit,
  VoicePresetName,
} from "../../../index.ts";
import { agent, VOICE_PRESETS } from "../../../index.ts";

/** The two presets a front desk that spells codes back turns on. */
const presets: readonly VoicePresetName[] = ["echoVerification", "natoAlphabet"];

/** The field group as a standalone typed value — independently constructible. */
const reliability: AgentVoicePresets = { voicePresets: presets };

/** Epoch 10's own addition: the bound on a caller who never pauses. */
const oneTurn: UserTurnLimit = { maxWords: 120, maxDurationMs: 45_000 };

/** An epoch-10 agent: presets spread in, and no roster anywhere in it. */
export const desk: AgentDef = agent({
  name: "Front desk",
  systemPrompt: "Verify the caller, then answer in one or two sentences.",
  greeting: "Front desk. How can I help?",
  userTurnLimit: oneTurn,
  ...reliability,
});

/** The shipped text, read back — printed while tuning, asserted on in a spec. */
export function presetText(name: VoicePresetName): string {
  return VOICE_PRESETS[name];
}
