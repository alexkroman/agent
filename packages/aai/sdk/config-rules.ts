// Copyright 2026 the AAI authors. MIT license.
/**
 * Agent configuration rules: the derived session mode, the app kind, and the
 * cross-field validation every config layer runs.
 *
 * Each rule is deliberately shared by `parseManifest`, `toAgentConfig`, and
 * the server's `IsolateConfigSchema` — three call sites (author, bundle
 * entry, platform trust boundary), one source of truth per rule. Split out
 * of `providers.ts` so the provider-descriptor contracts and the config
 * rules stop sharing a module — these functions are about agent *shape*,
 * not providers.
 */

import { isTextOnlyTts } from "./providers/tts/none.ts";

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
 * none of them. Anything in-between is a configuration error. An optional
 * `s2s` descriptor selects a non-default S2S provider — it must not be
 * combined with any pipeline field.
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
 * What kind of app this definition is — the two modes of the SDK.
 *
 * - `"agent"` (default): a conversational chat/voice interface — an open
 *   WebSocket session the user talks with turn by turn.
 * - `"workflow"`: audio in, action out — one push-to-talk or uploaded
 *   instruction runs a single agentic loop to completion and the run ends.
 *   Built by the `workflow()` helper (the only author-facing way to set
 *   this); each run is one history-less `POST /sync` turn.
 */
export type AgentKind = "agent" | "workflow";

/**
 * Enforce the workflow-kind config rule: a workflow is one sync turn over
 * an STT→LLM pipeline, so it requires pipeline mode (the `workflow()`
 * helper guarantees it; this catches hand-rolled manifests).
 *
 * Shared by `parseManifest`, `toAgentConfig`, and the server's
 * `IsolateConfigSchema` — one source of truth for the validation.
 */
export function assertAgentKind(mode: SessionMode, kind: AgentKind | undefined): void {
  if (kind !== "workflow") return;
  if (mode !== "pipeline") {
    throw new Error('kind: "workflow" requires pipeline mode (stt, llm, and tts all set)');
  }
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
 * Voice-UX tuning fields that only the pipeline transport implements.
 * Shared by {@link assertPipelineTuning} and the config layers that carry
 * these fields (AgentDef → manifest → AgentConfig → IsolateConfig).
 */
export type PipelineTuning = {
  minBargeInWords?: number | undefined;
  interruptionMinDurationMs?: number | undefined;
  endpointSettleMs?: number | undefined;
  completeSettleMs?: number | undefined;
  holdPhrase?: string | undefined;
  errorPhrase?: string | undefined;
  falseInterruptionTimeoutMs?: number | undefined;
};

/**
 * Reject tuning fields that only make sense when replies are spoken.
 * `holdPhrase` is literally synthesized filler ("One moment.") — with
 * `tts: none()` it would be injected into the *text* reply instead, so an
 * explicit value is a configuration error rather than a silent oddity.
 *
 * Shared by `parseManifest`, `toAgentConfig`, and the server's
 * `IsolateConfigSchema` — one source of truth, mirroring
 * {@link assertPipelineTuning}.
 */
export function assertTextOnlyTuning(
  tts: unknown,
  tuning: Pick<PipelineTuning, "holdPhrase">,
): void {
  if (isTextOnlyTts(tts) && tuning.holdPhrase !== undefined) {
    throw new Error("holdPhrase requires a speaking TTS provider (remove it or drop tts: none())");
  }
}

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
  const fields: Record<string, unknown> = {
    minBargeInWords: tuning.minBargeInWords,
    interruptionMinDurationMs: tuning.interruptionMinDurationMs,
    endpointSettleMs: tuning.endpointSettleMs,
    completeSettleMs: tuning.completeSettleMs,
    holdPhrase: tuning.holdPhrase,
    // Unlike holdPhrase this is NOT rejected by assertTextOnlyTuning: an error
    // message is meaningful as text, where synthesized dead-air filler is not.
    errorPhrase: tuning.errorPhrase,
    falseInterruptionTimeoutMs: tuning.falseInterruptionTimeoutMs,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      throw new Error(`${key} requires pipeline mode (stt, llm, and tts all set)`);
    }
  }
}
