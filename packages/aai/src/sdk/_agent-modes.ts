// Copyright 2026 the AAI authors. MIT license.
/**
 * The RUN-TIME half of the `agent()` union: which mode a declaration is in,
 * and which fields that mode does not have.
 *
 * The type half is `agent-params.ts`, where each member is cut from `AgentDef`
 * by subtracting field lists. This module refuses the same fields for a caller
 * the type never saw — a raw `export default {...}`, a JSON config, a spread
 * options bag — and its tables are written against those same lists: each one
 * `satisfies` a `Record` over the field-list TYPE, so a field added to a list
 * and not to its table is a compile error here, not a knob some mode accepts
 * and never honours. That replaces a hand-kept `PIPELINE_ONLY_TUNING` table and
 * two bespoke gates (`assertPipelineTuning`, `assertSilencePolicy`) with one
 * rule: a field belongs to the members it appears in, and nowhere else.
 *
 * The two refusals with their own, longer argument stay where they are and run
 * FIRST, so their sentence wins: `assertSamplingScope` (the model-request knobs
 * on S2S) and `assertGuardrailScope` (a guardrail outside the pipeline).
 *
 * An `_`-internal module: plumbing between `define.ts` and the config
 * boundary, not API.
 */

import type { GuardrailField } from "./agent-guardrails.ts";
import { AGENT_MODES, type AgentMode } from "./agent-mode.ts";
import { MODEL_TUNING_FIELDS } from "./agent-model-tuning.ts";
import type {
  PipelineOnlyField,
  TextOnlyExcludedField,
  WorkflowAppOnlyField,
} from "./agent-params.ts";

function isAgentMode(value: unknown): value is AgentMode {
  return (AGENT_MODES as readonly unknown[]).includes(value);
}

/** The two pipeline-only STAGES — split from the tuning for the workflow app's sake. */
const PIPELINE_STAGES = {
  stt: "the pipeline's speech-to-text stage",
  tts: "the pipeline's text-to-speech stage",
} as const satisfies Record<Extract<PipelineOnlyField, "stt" | "tts">, string>;

/**
 * What each pipeline-only field is FOR, in the words a refusal quotes. With
 * {@link PIPELINE_STAGES}, total over {@link PipelineOnlyField} minus the
 * guardrails (which `assertGuardrailScope` refuses with its own argument) — and
 * EXACT, since each is a literal under its own `satisfies`: a field on one of
 * these tables and on no member is a compile error too.
 */
const PIPELINE_TUNING = {
  turnTaking: "the pipeline's turn-taking tuning",
  interruption: "the pipeline's barge-in tuning",
  silence: "the pipeline's dead-air cover and silence nudge",
  errorPhrase: "the phrase the pipeline speaks when a turn fails",
  startFailurePhrase: "the phrase the pipeline speaks when a provider fails to open",
} as const satisfies Record<Exclude<PipelineOnlyField, GuardrailField | "stt" | "tts">, string>;

/** Both halves — the shape every non-pipeline member subtracts. */
const PIPELINE_ONLY = { ...PIPELINE_STAGES, ...PIPELINE_TUNING };

/** The two fields a text agent drops beyond the pipeline-only ones. */
const TEXT_EXCLUDED = {
  sttPrompt: "biases a transcriber, and a text agent has none",
  telephony: "admits a phone call, which is audio, and a text agent has no audio path",
} as const satisfies Record<TextOnlyExcludedField, string>;

/**
 * What a workflow app refuses beyond the pipeline-only tuning. Total over
 * {@link WorkflowAppOnlyField} minus the fields the FRAMEWORK fills on every
 * definition by the time the config boundary sees it — `systemPrompt` and
 * `maxSteps` (`agent()`'s defaults) and the three pipeline stages (the default
 * fill, which a workflow app gets like any agent and which a runtime passes
 * back in as its effective providers). Those five stay type-level refusals.
 */
const WORKFLOW_APP_EXCLUDED = {
  ...MODEL_TUNING_FIELDS,
  inputGuardrails: "a check on what the caller said",
  outputGuardrails: "a check on what the agent is about to say",
  s2s: "the speech-to-speech stage",
  voicePresets: "prompt text",
  toolChoice: "the model's tool-choice policy",
  builtinTools: "tools the model chooses between",
  subagents: "a roster the model delegates to",
  personas: "who is SPEAKING in a session",
  syncState: "a projection pushed over the session socket",
  events: "the session's event stream",
  sessionContext: "a hook that runs when a session opens",
  onSessionEnd: "a hook that runs when a session closes",
  idleTimeoutMs: "the session idle timer",
} as const satisfies Record<
  Exclude<
    WorkflowAppOnlyField,
    | Exclude<PipelineOnlyField, GuardrailField>
    | TextOnlyExcludedField
    | "systemPrompt"
    | "maxSteps"
    | "llm"
  >,
  string
>;

/** The S2S descriptor, which only the S2S member has. */
const S2S_ONLY = { s2s: "the speech-to-speech descriptor" } as const;

/** The fields each mode does not have, and what each is for. */
const MODE_EXCLUSIONS: { readonly [M in AgentMode]: Readonly<Record<string, string>> } = {
  pipeline: S2S_ONLY,
  s2s: { ...PIPELINE_ONLY, llm: "the pipeline's model stage" },
  text: { ...PIPELINE_ONLY, ...TEXT_EXCLUDED, ...S2S_ONLY },
  "workflow-app": { ...PIPELINE_TUNING, ...TEXT_EXCLUDED, ...WORKFLOW_APP_EXCLUDED },
};

/** Why a mode has none of the fields it excludes, for the refusal. */
const MODE_REASON: { readonly [M in AgentMode]: string } = {
  pipeline: "a pipeline agent runs its own STT, LLM and TTS stages",
  s2s: "an S2S agent's service runs STT, the model loop and TTS itself",
  text: "a text agent has no audio path",
  "workflow-app": "a workflow app runs no model and opens no session",
};

/**
 * The mode a declaration is in: its `mode`, or `"pipeline"`.
 *
 * Also refuses `mode: "s2s"` with no descriptor: the default fill would
 * otherwise give it a PIPELINE, which is exactly the silent fallback "Never let
 * S2S be a fallback" forbids in the other direction. (The reverse — a
 * descriptor on any other mode — is `assertModeFields`' refusal, since `s2s`
 * is a field only the S2S member has.)
 *
 * @internal
 */
export function resolveAgentMode(src: Readonly<Record<string, unknown>>): AgentMode {
  const declared = src.mode;
  if (declared !== undefined && !isAgentMode(declared)) {
    throw new Error(
      `\`mode\` must be one of ${AGENT_MODES.map((m) => `"${m}"`).join(", ")} — got ${JSON.stringify(declared)}.`,
    );
  }
  const mode = declared ?? "pipeline";
  if (mode === "s2s" && src.s2s == null) {
    throw new Error(
      '`mode: "s2s"` needs the `s2s` descriptor it selects — ' +
        "without one the agent would silently run the default pipeline.",
    );
  }
  return mode;
}

/**
 * Refuse every field `mode`'s member does not have — the run-time twin of the
 * subtraction each member's type is built by.
 *
 * Reads the AUTHORED fields, before the conveniences are lowered:
 * `turnTaking.maxSilenceMs` on an S2S agent is refused as `turnTaking`, not as
 * the `stt` stage it would have become.
 *
 * @internal
 */
export function assertModeFields(mode: AgentMode, src: Readonly<Record<string, unknown>>): void {
  const excluded = MODE_EXCLUSIONS[mode];
  for (const [field, what] of Object.entries(excluded)) {
    if (src[field] === undefined) continue;
    throw new Error(
      `\`${field}\` is ${what} — it has no effect on a "${mode}" agent (${MODE_REASON[mode]}). ` +
        `Remove it${ownerHint(field)}.`,
    );
  }
}

/** ", or declare `mode: "…"`" for a field some other member does have. */
function ownerHint(field: string): string {
  if (field in PIPELINE_ONLY || field === "llm" || field in TEXT_EXCLUDED) {
    return ', or declare `mode: "pipeline"`';
  }
  if (field === "s2s") return ', or declare `mode: "s2s"`';
  return "";
}
