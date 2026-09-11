// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 4.
 *
 * Epoch 5 gave `AgentDef` one optional field — `twoTier`, the fast/slow split
 * that puts a second model behind the first — plus the `TwoTierConfig` and
 * `SlowTierEffort` types that shape it and four `DEFAULT_SLOW_TIER_*` /
 * `MAX_STATE_DIGEST_CHARS` constants that document its defaults. It is purely
 * additive and OFF unless declared, and this file is the evidence: `desk` below
 * is a complete epoch-4 declaration in which `twoTier` does not appear, and an
 * agent that omits it sends the bytes it always sent and allocates nothing.
 *
 * That last clause is the part worth freezing. "Still compiles" would be met by
 * a `twoTier` that defaulted to on; what epoch 4 was promised is that an agent
 * written before the field existed behaves identically, which is why the field
 * is optional AND its omission is the whole off-switch.
 *
 * The front half is built on epoch 4's own additions, since a fixture for an
 * epoch should look like code written AT it. Epoch 4 added eleven names in
 * three groups, and all three appear below:
 *
 * - **Voice presets** — `voicePresets`, typed by `VoicePresetName`, whose
 *   shipped text is `VOICE_PRESETS`. Declared through the `AgentVoicePresets`
 *   interface as a standalone typed value and spread in, which is what proves
 *   that fifth field group is independently constructible.
 * - **Endpointing rules** — the four-type hierarchy (`EndpointingRuleBase` and
 *   the `assistant`/`user`/`both` narrowings it feeds, unioned as
 *   `EndpointingRule`), written as a named table so the discriminated union is
 *   exercised on all three arms rather than on whichever one an inline literal
 *   happened to pick.
 * - **The low-confidence band** — `LowConfidencePolicy` with its
 *   `LowConfidenceAction` and `LowConfidenceStatistic` vocabularies named
 *   rather than inlined.
 *
 * That is the whole promise. If a later epoch makes `twoTier` required or
 * default-on, narrows an endpointing rule's discriminant, or turns a
 * low-confidence band into a required field, this file reddens — the signal to
 * DROP the epoch rather than to edit the example.
 *
 * **Only epoch 4's eleven names are rolled up here.** Coverage is measured per
 * CAPABILITY over the union of its frozen examples, and `v1.ts`, `v2.ts` and
 * `v3.ts` between them already name epoch 3's thirty-six; this file is about
 * what epoch 4 ADDED.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so the
 * fixture would prove the CURRENT surface compiles rather than that epoch 4's
 * does.
 *
 * @module
 */

import type {
  AgentVoicePresets,
  AssistantEndpointingRule,
  BothEndpointingRule,
  EndpointingRule,
  EndpointingRuleBase,
  LowConfidenceAction,
  LowConfidencePolicy,
  LowConfidenceStatistic,
  UserEndpointingRule,
  VoicePresetName,
} from "../../../index.ts";
import { agent, VOICE_PRESETS } from "../../../index.ts";

/**
 * The fields every rule carries, named once and spread into each arm below —
 * which is the reason `EndpointingRuleBase` is exported rather than being an
 * implementation detail of the union.
 */
const shortWait: EndpointingRuleBase = { timeoutMs: 400, flags: "i" };

/** The agent just read something out, so the caller will pause mid-identifier. */
const afterReadback: AssistantEndpointingRule = {
  ...shortWait,
  type: "assistant",
  timeoutMs: 2400,
  regex: "read that back|confirm the (order|account) number",
};

/** A transcript that currently ends in digits is a caller part-way through a number. */
const midNumber: UserEndpointingRule = {
  ...shortWait,
  type: "user",
  timeoutMs: 2000,
  regex: "\\d\\s*$",
};

/**
 * The one-word answers, COMPOSED from a list rather than written as one
 * literal — the convention `endpointing-rules.ts` follows for the same reason:
 * biome's `noSecrets` reads a punctuation-dense pattern as a high-entropy
 * string. It reads better too, each entry being one thing a caller says.
 */
const ONE_WORD_ANSWERS = ["yes", "no", "yeah", "nope"].join("|");

/** Both sides must match: a yes/no question answered in one word. */
const closedQuestion: BothEndpointingRule = {
  ...shortWait,
  type: "both",
  assistantRegex: "\\?\\s*$",
  userRegex: `^(${ONE_WORD_ANSWERS})\\b`,
};

/**
 * The table as the union, in declaration order — first match wins, so the two
 * specific rules precede the general one.
 */
const endpointingRules: readonly EndpointingRule[] = [afterReadback, midNumber, closedQuestion];

/** Epoch 4's two vocabularies, named rather than inlined. */
const onSoftTurn: LowConfidenceAction = "clarify";
const perWord: LowConfidenceStatistic = "minWord";

/**
 * `minWord` fires far more often than `mean` at the same thresholds, so the
 * bands are lowered to match — which is the pairing an author has to get right
 * and therefore the one worth freezing.
 */
const lowConfidence: LowConfidencePolicy = {
  discardBelow: 0.15,
  actionBelow: 0.35,
  action: onSoftTurn,
  phrase: "Sorry, I didn't catch that — could you say it once more?",
  statistic: perWord,
};

/**
 * The fifth field group built as a standalone typed value and spread into
 * `agent()`, rather than written flat. Both spellings were available at epoch
 * 4; this one is what proves the interface is independently constructible.
 */
const presets: AgentVoicePresets = {
  voicePresets: ["echoVerification", "smartMatching", "natoAlphabet"],
};

/**
 * A preset's shipped TEXT, read off the published table. An author reaches for
 * this to see what a name costs before turning it on — `VOICE_PRESETS` is the
 * price list the field's own doc points at.
 */
export const natoText: string = VOICE_PRESETS.natoAlphabet;

/** The narrowed name type, named so a config-driven list stays checked. */
const deskPresets: readonly VoicePresetName[] = presets.voicePresets ?? [];

/**
 * The declaration an epoch-4 author wrote: the three new groups beside the
 * ordinary fields, and no `twoTier` anywhere.
 */
export const desk = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences. Never guess an order number.",
  greeting: "Front desk, how can I help?",
  voice: "michael",
  llm: "claude-sonnet-4-6",
  // PipelineVoiceTuning, epoch 4's half.
  endpointingRules,
  lowConfidence,
  // AgentVoicePresets, spread rather than written flat.
  ...presets,
  // And the rest of an ordinary declaration.
  description: "Answers the front desk line.",
  maxSteps: 8,
});

/** The same list written flat, which epoch 4 also allowed. */
export const spelledDesk = agent({
  name: "Spelled desk",
  systemPrompt: "Spell every identifier back.",
  voicePresets: deskPresets,
});
