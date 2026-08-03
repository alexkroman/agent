// Copyright 2026 the AAI authors. MIT license.
/**
 * Agent configuration rules: the derived session mode and the
 * cross-field validation every config layer runs.
 *
 * Each rule is deliberately shared by `parseManifest`, `toAgentConfig`, and
 * the server's `IsolateConfigSchema` — three call sites (author, bundle
 * entry, platform trust boundary), one source of truth per rule. Split out
 * of `providers.ts` so the provider-descriptor contracts and the config
 * rules stop sharing a module — these functions are about agent *shape*,
 * not providers.
 */

/**
 * Session mode derived from which provider triple is set.
 *
 * `parseManifest`, `toAgentConfig`, `createRuntime`, and the server's
 * `IsolateConfigSchema` all use {@link assertProviderTriple} so there's
 * one source of truth for the validation.
 */
export type SessionMode = "s2s" | "pipeline";

/**
 * Enforce the all-or-nothing provider rule and return the derived mode.
 *
 * Pipeline mode requires STT, LLM, and TTS all set; S2S mode requires
 * none of them. Anything in-between is a configuration error. An `s2s`
 * descriptor selects the S2S provider — it must not be combined with any
 * pipeline field.
 *
 * This function only classifies what it is given — it injects nothing. The
 * pipeline-by-default rule lives in `defaultProviders`
 * (`providers/_default-providers.ts`), which every config layer applies
 * *before* calling this, so "nothing set" reaches here only for raw
 * pre-default shapes (and still classifies as "s2s" for wire tolerance with
 * stored configs that predate the flip).
 */
export function assertProviderTriple(
  stt: unknown,
  llm: unknown,
  tts: unknown,
  s2s?: unknown,
): SessionMode {
  const hasStt = stt != null;
  const hasLlm = llm != null;
  const hasTts = tts != null;
  const hasS2s = s2s != null;
  const anyPipeline = hasStt || hasLlm || hasTts;
  const allSet = hasStt && hasLlm && hasTts;
  const noneSetPipeline = !anyPipeline;
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
 * Shared by `parseManifest`, `toAgentConfig`, and the server's
 * `IsolateConfigSchema` — one source of truth for the validation.
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
 * and {@link assertPipelineTuning} derive from, so a new pipeline-only field
 * cannot be added to the type but skip validation (which is how
 * `startFailurePhrase` once slipped through).
 */
const PIPELINE_ONLY_TUNING = {
  minBargeInWords: "number",
  interruptionMinDurationMs: "number",
  holdPhrase: "string",
  errorPhrase: "string",
  startFailurePhrase: "string",
  falseInterruptionTimeoutMs: "number",
} as const;

type PipelineTuningField = keyof typeof PIPELINE_ONLY_TUNING;

const PIPELINE_ONLY_TUNING_FIELDS = Object.keys(
  PIPELINE_ONLY_TUNING,
) as readonly PipelineTuningField[];

/**
 * Voice-UX tuning fields that only the pipeline transport implements.
 * Shared by {@link assertPipelineTuning} and the config layers that carry
 * these fields (AgentDef → manifest → AgentConfig → IsolateConfig).
 */
export type PipelineTuning = {
  [K in PipelineTuningField]?:
    | ((typeof PIPELINE_ONLY_TUNING)[K] extends "number" ? number : string)
    | undefined;
};

/**
 * Reject pipeline-only voice-UX tuning fields in S2S mode — the S2S provider
 * owns endpointing/barge-in service-side, so these would be silently ignored.
 *
 * Shared by `parseManifest`, `toAgentConfig`, and the server's
 * `IsolateConfigSchema` — one source of truth for the validation, mirroring
 * {@link assertSilencePolicy}.
 */
export function assertPipelineTuning(mode: SessionMode, tuning: PipelineTuning): void {
  if (mode === "pipeline") return;
  for (const key of PIPELINE_ONLY_TUNING_FIELDS) {
    if (tuning[key] !== undefined) {
      throw new Error(`${key} requires pipeline mode (stt, llm, and tts all set)`);
    }
  }
}
