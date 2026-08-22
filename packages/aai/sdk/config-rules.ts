// Copyright 2026 the AAI authors. MIT license.
/**
 * Agent configuration rules: the derived session mode and the
 * cross-field validation every config layer runs.
 *
 * Each rule is deliberately shared by `toAgentConfig` and the server's
 * `IsolateConfigSchema` — bundle entry and platform trust boundary, one
 * source of truth per rule. Split out
 * of `providers.ts` so the provider-descriptor contracts and the config
 * rules stop sharing a module — these functions are about agent *shape*,
 * not providers.
 */

import type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";

/**
 * Session mode derived from which provider fields are set.
 *
 * `toAgentConfig`, `createRuntime`, and the server's `IsolateConfigSchema`
 * all use `assertProviderTriple` so there's one source of truth for the
 * validation.
 *
 * `"text"` is the one mode with no audio path at all: the agent is an LLM,
 * a system prompt and its tools, driven by `createTextAgent`
 * (`@alexkroman1/aai-runtime`) over a message list rather than by a
 * transport over a socket.
 */
export type SessionMode = "s2s" | "pipeline" | "text";

/**
 * Classify the session mode from the provider fields, rejecting invalid
 * combinations.
 *
 * Pipeline mode requires STT, LLM, and TTS all set; S2S mode requires
 * none of them. An `s2s` descriptor selects the S2S provider — it must not
 * be combined with any pipeline field. `text: true` selects the text mode
 * and takes only `llm`: it is the same explicit-opt-in shape as `s2s`, for
 * the same reason (see "Never let S2S be a fallback" in
 * `packages/aai/CLAUDE.md`) — a mode reachable by OMISSION is a mode an
 * agent lands in when its config loses a field, and the failure there is a
 * voice agent that silently answers nothing.
 *
 * This function only classifies what it is given — it injects nothing. The
 * pipeline-by-default rule lives in `defaultProviders`
 * (`providers/_default-providers.ts`), which every config layer applies
 * *before* calling this: unset pipeline stages are filled from the
 * all-AssemblyAI pipeline, so a partial triple never reaches this check on
 * an authoring path. The partial-triple error below therefore only fires on
 * raw wire shapes that skipped the fill, and "nothing set" reaches here only
 * for raw pre-default shapes (still classified as "s2s" for wire tolerance
 * with stored configs that predate the flip).
 *
 * @internal
 */
export function assertProviderTriple(
  stt: unknown,
  llm: unknown,
  tts: unknown,
  s2s?: unknown,
  text?: undefined,
): Exclude<SessionMode, "text">;
/**
 * The `text`-accepting overload.
 *
 * Carries its own `@internal` deliberately: an overload with no doc comment
 * defaults to `@public` in the API report, so the symbol would be tagged two
 * ways and `api-surface-file.test.ts` fails on exactly that.
 *
 * @internal
 */
export function assertProviderTriple(
  stt: unknown,
  llm: unknown,
  tts: unknown,
  s2s?: unknown,
  text?: unknown,
): SessionMode;
// Two signatures rather than one, because a caller that passes no `text` at
// all — every voice path — cannot possibly be told "text", and saying so in
// the type is what keeps the voice call sites free of a cast asserting it.
export function assertProviderTriple(
  stt: unknown,
  llm: unknown,
  tts: unknown,
  s2s?: unknown,
  text?: unknown,
): SessionMode {
  const hasStt = stt != null;
  const hasLlm = llm != null;
  const hasTts = tts != null;
  const hasS2s = s2s != null;
  const anyPipeline = hasStt || hasLlm || hasTts;
  const allSet = hasStt && hasLlm && hasTts;
  const noneSetPipeline = !anyPipeline;
  // Checked before the triple rules: a text agent legitimately carries an
  // `llm` and nothing else, which the partial-triple error below would
  // otherwise reject with a message about a pipeline it is not in.
  if (text === true) {
    if (hasS2s) {
      throw new Error("text and s2s cannot be set together — a text agent has no speech stage");
    }
    if (hasStt || hasTts) {
      throw new Error("a text agent cannot set stt or tts — it has no audio path, only `llm`");
    }
    return "text";
  }
  if (hasS2s && anyPipeline) {
    throw new Error("s2s and the stt/llm/tts pipeline cannot be set together");
  }
  if (!(allSet || noneSetPipeline)) {
    throw new Error("stt, llm, and tts must be set together");
  }
  return allSet ? "pipeline" : "s2s";
}

/**
 * Enforce the silence-nudge config rules. `silenceTimeoutMs` makes the
 * assistant proactively take a turn after that much user silence — only the
 * pipeline transport implements it, so it's rejected in S2S mode rather than
 * silently ignored. `silencePrompt` customizes the injected instruction and
 * is meaningless without the timeout.
 *
 * Shared by `toAgentConfig` and the server's `IsolateConfigSchema` — one
 * source of truth for the validation.
 *
 * @internal
 */
export function assertSilencePolicy(
  mode: SessionMode,
  silenceTimeoutMs: number | undefined,
  silencePrompt: string | undefined,
): void {
  if (silenceTimeoutMs !== undefined && mode !== "pipeline") {
    throw new Error("silenceTimeoutMs requires pipeline mode (stt, llm, and tts all set)");
  }
  if (silencePrompt !== undefined && silenceTimeoutMs === undefined) {
    throw new Error("silencePrompt requires silenceTimeoutMs to be set");
  }
}

/**
 * Voice-UX tuning fields that only the pipeline transport implements, with
 * each field's value shape. The one declaration both {@link PipelineTuning}
 * and `assertPipelineTuning` derive from, so a new pipeline-only field
 * cannot be added to the type but skip validation (which is how
 * `startFailurePhrase` once slipped through).
 *
 * The `satisfies` closes the other half of that gap: it makes the object
 * TOTAL over {@link PipelineVoiceTuning}, so a field added to the authoring
 * interface and not to this table is a compile error here rather than a knob
 * an S2S agent can set and never have honoured.
 */
const PIPELINE_ONLY_TUNING = {
  minBargeInWords: "number",
  interruptionMinDurationMs: "number",
  deadAirCoverMs: "number",
  errorPhrase: "string",
  startFailurePhrase: "string",
  resumeFalseInterruption: "boolean",
  preemptiveGeneration: "boolean",
} as const satisfies Record<keyof PipelineVoiceTuning, "number" | "string" | "boolean">;

type PipelineTuningField = keyof typeof PIPELINE_ONLY_TUNING;

const PIPELINE_ONLY_TUNING_FIELDS = Object.keys(
  PIPELINE_ONLY_TUNING,
) as readonly PipelineTuningField[];

/**
 * Voice-UX tuning fields that only the pipeline transport implements.
 * Shared by `assertPipelineTuning` and the config layers that carry
 * these fields (AgentDef → manifest → AgentConfig → IsolateConfig).
 *
 * @internal
 */
export type PipelineTuning = {
  [K in PipelineTuningField]?:
    | ((typeof PIPELINE_ONLY_TUNING)[K] extends "number"
        ? number
        : (typeof PIPELINE_ONLY_TUNING)[K] extends "boolean"
          ? boolean
          : string)
    | undefined;
};

/**
 * Reject pipeline-only voice-UX tuning fields in S2S mode — the S2S provider
 * owns endpointing/barge-in service-side, so these would be silently ignored.
 *
 * Shared by `toAgentConfig` and the server's `IsolateConfigSchema` — one
 * source of truth for the validation, mirroring `assertSilencePolicy`.
 *
 * @internal
 */
export function assertPipelineTuning(mode: SessionMode, tuning: PipelineTuning): void {
  if (mode === "pipeline") return;
  for (const key of PIPELINE_ONLY_TUNING_FIELDS) {
    if (tuning[key] !== undefined) {
      throw new Error(`${key} requires pipeline mode (stt, llm, and tts all set)`);
    }
  }
}
