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

import { GUARDRAIL_FIELDS, type GuardrailField } from "./agent-guardrails.ts";
import { MODEL_TUNING_FIELDS, type ModelTuningField } from "./agent-model-tuning.ts";
import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "./endpointing-constants.ts";
import { isRecord } from "./is-record.ts";
import { ASSEMBLYAI_STT_KIND, type AssemblyAISttOptions } from "./providers/stt/assemblyai.ts";

/** {@link MODEL_TUNING_FIELDS}' keys, in declaration order. @internal */
const MODEL_TUNING_FIELD_NAMES = Object.keys(MODEL_TUNING_FIELDS) as readonly ModelTuningField[];

/** {@link GUARDRAIL_FIELDS}' keys, in declaration order. @internal */
const GUARDRAIL_FIELD_NAMES = Object.keys(GUARDRAIL_FIELDS) as readonly GuardrailField[];

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
 * be combined with any pipeline field. Text mode is not classified here: it
 * is selected only by an explicit `mode: "text"` — the same opt-in shape as
 * `s2s`, for the same reason (see "Never let S2S be a fallback" in
 * `packages/aai/CLAUDE.md`) — and by the time a caller holds a resolved
 * `mode`, `assertModeFields` has refused a text agent's `stt`/`tts`/`s2s`, so
 * the caller answers `"text"` itself and asks this only about a voice agent.
 *
 * This function only classifies what it is given — it injects nothing. The
 * pipeline-by-default rule lives in `defaultProviders`
 * (`providers/_default-providers.ts`), which every config layer applies
 * *before* calling this: unset pipeline stages are filled from the
 * all-AssemblyAI pipeline, so a partial triple never reaches this check on
 * an authoring path. The incomplete-triple error below therefore only fires on
 * raw wire shapes that skipped the fill — including one that sets nothing at
 * all, which is S2S only with an explicit `s2s` descriptor.
 *
 * @internal
 */
export function assertProviderTriple(
  stt: unknown,
  llm: unknown,
  tts: unknown,
  s2s?: unknown,
): Exclude<SessionMode, "text"> {
  const hasStt = stt != null;
  const hasLlm = llm != null;
  const hasTts = tts != null;
  const hasS2s = s2s != null;
  const anyPipeline = hasStt || hasLlm || hasTts;
  const allSet = hasStt && hasLlm && hasTts;
  const named = (flags: [string, boolean][]) =>
    flags
      .filter(([, on]) => on)
      .map(([field]) => `\`${field}\``)
      .join(", ");
  const stages: [string, boolean][] = [
    ["stt", hasStt],
    ["llm", hasLlm],
    ["tts", hasTts],
  ];
  if (hasS2s && anyPipeline) {
    throw new Error(
      `s2s and the stt/llm/tts pipeline cannot be set together — this config sets \`s2s\` and ${named(stages)}. ` +
        'Remove the pipeline stage(s) for a speech-to-speech agent (`mode: "s2s"`), or remove `s2s` for a pipeline agent.',
    );
  }
  if (hasS2s) return "s2s";
  if (!allSet) {
    const missing = named(stages.map(([field, on]) => [field, !on]));
    const sets = anyPipeline ? `sets ${named(stages)} but not ${missing}` : "sets none of them";
    throw new Error(
      `stt, llm, and tts must be set together on a RESOLVED config — this one ${sets}. ` +
        "`agent()` and `toAgentConfig` fill unset stages with the AssemblyAI defaults, so an author may set any subset; " +
        "a config reaching this check skipped that fill. Build it with `agent({ … })`, or set the missing stage(s) explicitly.",
    );
  }
  return "pipeline";
}

/**
 * Every {@link AgentModelTuning} knob describes a request THIS runtime
 * assembles, so an S2S agent may set none of them.
 *
 * It was `assertSamplingScope(mode, temperature)`, one field with the argument
 * written out beside it, and the argument turned out to be shared by four more:
 * a per-step output cap, a provider-retry budget, a per-step tool-choice reset
 * and a token budget all describe a call this runtime makes, and in S2S mode it
 * makes none — the model runs inside the provider's own service, and this
 * process sees neither the request nor the token counts that come back.
 *
 * Rejected rather than ignored, which is the rule this whole config layer
 * exists for: a setting that is accepted and quietly dropped is worse than one
 * that was never offered, because the author has no way to find out. An S2S
 * agent that wants any of these sets it on the `s2s` descriptor, where the
 * provider's own options live.
 *
 * The field list is DERIVED from {@link MODEL_TUNING_FIELDS}, whose `satisfies`
 * makes it total over the interface — so a knob added to `AgentModelTuning` and
 * not to that table fails to compile, rather than becoming the next
 * `startFailurePhrase`.
 *
 * @internal
 */
export function assertSamplingScope(
  mode: SessionMode,
  tuning: { [K in ModelTuningField]?: unknown },
): void {
  if (mode !== "s2s") return;
  for (const field of MODEL_TUNING_FIELD_NAMES) {
    if (tuning[field] === undefined) continue;
    throw new Error(
      `${field} has no effect in s2s mode — it is ${MODEL_TUNING_FIELDS[field]} for a request ` +
        "this runtime assembles, and in s2s the model runs inside the provider's service so " +
        "this runtime never makes one. Set it on the `s2s` descriptor if the provider supports " +
        "an equivalent, or remove it.",
    );
  }
}

/**
 * An S2S agent may declare no guardrail, because there is no moment at which
 * one could act.
 *
 * The provider synthesizes the agent's audio itself and streams it straight to
 * the caller; the matching text reaches this runtime alongside audio that has
 * already been heard. So an output guardrail there could only report on a
 * sentence that was spoken — and an input guardrail could only run after the
 * provider had already started answering, because the provider hears the audio
 * and this runtime learns what was said from a transcript event.
 *
 * A refusal rather than a no-op, and this is the field where the difference
 * matters most in the whole config layer: everything else that is silently
 * dropped costs a tuning knob, and a safety control that is silently dropped
 * costs exactly the thing it was declared to prevent. `agent-guardrails.ts`
 * carries what the pipeline and text implementations do and do not prevent.
 *
 * The field list is DERIVED from {@link GUARDRAIL_FIELDS}, whose `satisfies`
 * makes it total over {@link AgentGuardrails} — the same mechanism the two
 * gates above use, and here for the strongest version of the same reason. This
 * one was a pair of string literals, so a third guardrail field would have been
 * accepted in s2s and text and silently done nothing, which is the exact
 * failure the neighbouring tables exist to make impossible.
 *
 * @internal
 */
export function assertGuardrailScope(
  mode: SessionMode,
  guardrails: { [K in GuardrailField]?: unknown },
): void {
  if (mode === "pipeline") return;
  const why =
    mode === "s2s"
      ? "The provider runs the model and synthesizes the audio itself, so by the time this " +
        "runtime sees the text the caller has already heard it — a guardrail there could " +
        "report, never prevent."
      : "A text agent hands its caller the model stream directly (`createTextAgent().stream()` " +
        "returns the AI SDK's own result), so this runtime owns no point between the model and " +
        "the caller at which it could hold a reply back. Gate the stream in your own caller.";
  for (const field of GUARDRAIL_FIELD_NAMES) {
    if (guardrails[field] === undefined) continue;
    throw new Error(
      `${field} requires pipeline mode (stt, llm and tts all set) — it judges ` +
        `${GUARDRAIL_FIELDS[field]}, and this mode reaches no moment at which that check ` +
        `could act. ${why} Remove it, or run this agent on the pipeline.`,
    );
  }
}

/**
 * Reject an end-of-turn window whose floor sits above its ceiling.
 *
 * `minTurnSilenceMs` is when the service runs its end-of-turn CHECK and
 * `maxTurnSilenceMs` is when it force-ends the turn regardless of content, so
 * a floor above the ceiling means the check can never fire — the turn is
 * always closed by the content-blind timer, which is precisely the split the
 * knob is usually reached for in order to prevent
 * ({@link AssemblyAISttOptions.minTurnSilenceMs} says so in prose, and prose
 * was the whole enforcement: `agent({ minTurnSilenceMs: 2000,
 * maxTurnSilenceMs: 1000 })` built clean and shipped).
 *
 * An error rather than a warning, unlike the voice catalog below: this needs no
 * knowledge the SDK might be missing, and there is no configuration this shape
 * expresses. It is two numbers contradicting each other.
 *
 * **Resolved values, not declared ones**, which is the half a check on the pair
 * as written would miss: each side falls back to its own default, so
 * `agent({ minTurnSilenceMs: 5000 })` alone is already inverted against the
 * 3500 ms ceiling nobody typed. Reading the defaults here is the same
 * `?? DEFAULT_…` chain `resolveAssemblyAISttSettings` runs, and the constants
 * are shared so the two cannot drift.
 *
 * Takes `unknown` so callers can hand it a possibly-absent descriptor, and
 * anything that is not an AssemblyAI STT stage is left alone — another
 * provider's endpointing is its own.
 *
 * @internal
 */
export function assertTurnSilenceWindow(stt: unknown): void {
  if (!isRecord(stt) || stt.kind !== ASSEMBLYAI_STT_KIND || !isRecord(stt.options)) return;
  const [minKey, maxKey] = ENDPOINTING_KEYS;
  const min = stt.options[minKey];
  const max = stt.options[maxKey];
  const resolvedMin = typeof min === "number" ? min : DEFAULT_MIN_TURN_SILENCE_MS;
  const resolvedMax = typeof max === "number" ? max : DEFAULT_MAX_TURN_SILENCE_MS;
  if (resolvedMin <= resolvedMax) return;
  const defaulted = (declared: unknown, fallback: number): string =>
    typeof declared === "number" ? `${declared}` : `${fallback} (the default)`;
  throw new Error(
    `\`${minKey}\` is ${defaulted(min, DEFAULT_MIN_TURN_SILENCE_MS)} and \`${maxKey}\` is ` +
      `${defaulted(max, DEFAULT_MAX_TURN_SILENCE_MS)}. The minimum is when the service CHECKS ` +
      "whether the turn reads as complete and the maximum is when it force-ends the turn " +
      "regardless, so a minimum above the maximum means the check can never fire — every turn " +
      `is cut by the content-blind timer. Raise \`${maxKey}\` above \`${minKey}\`, or lower ` +
      `\`${minKey}\`.`,
  );
}

/**
 * The two field names, read off a type rather than written as string literals.
 *
 * The indirection is Biome's: `noSecrets` reads either name as a high-entropy
 * literal — the false positive a long camelCase string always trips — and a
 * suppression would raise the escape-hatch baseline, which only moves down.
 * Deriving them from `AssemblyAISttOptions` also means a rename over there is a
 * compile error here rather than a rule that silently stops firing.
 *
 * Declared HERE rather than in `_author-conveniences.ts`, which desugars the
 * pair and which imports it: the rule above and the desugaring have to agree on
 * the two names, and the import runs one way (that module already depends on
 * this one), so one declaration is available to both.
 *
 * @internal
 */
export const ENDPOINTING_KEYS = Object.keys({
  minTurnSilenceMs: 0,
  maxTurnSilenceMs: 0,
}) as [EndpointingKey, EndpointingKey];

/** @internal */
export type EndpointingKey = Extract<keyof AssemblyAISttOptions, `${"min" | "max"}TurnSilenceMs`>;

/**
 * The WARNING half of this module's rules lives next door — see
 * `config-warnings.ts`, which argues why "print a line" is a third option
 * beside error and silence. Re-exported here because every caller already
 * imports it from this path.
 */
export { agentConfigWarnings } from "./config-warnings.ts";
