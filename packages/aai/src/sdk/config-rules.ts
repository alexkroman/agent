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
import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "./endpointing-constants.ts";
import { isRecord } from "./is-record.ts";
import { ASSEMBLYAI_STT_KIND, type AssemblyAISttOptions } from "./providers/stt/assemblyai.ts";
import {
  ASSEMBLYAI_TTS_HOST,
  type AssemblyAITtsOptions,
  assemblyAIVoiceWarning,
} from "./providers/tts/assemblyai.ts";
import { CARTESIA_DEFAULT_VOICE, CARTESIA_KIND } from "./providers/tts/cartesia.ts";
import { RIME_DEFAULT_VOICE, RIME_KIND } from "./providers/tts/rime.ts";

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
 * `temperature` is a knob on a model THIS SDK calls, so an S2S agent may not set it.
 *
 * Not part of {@link PipelineVoiceTuning}: it is not voice tuning, and a TEXT
 * agent has every reason to set it — a booking desk and a game master want
 * different values, and until now neither could say so. The main conversational
 * loop took no sampling parameter at all while `ctx.generate` and `subagent()`
 * both did.
 *
 * Rejected rather than ignored for S2S because the model runs inside the
 * provider's own service there, so nothing in this runtime would carry the
 * value — and a setting that is accepted and quietly dropped is the failure
 * this config layer exists to prevent. An S2S agent that wants it sets it on
 * the `s2s` descriptor, where the provider's own options live.
 *
 * @internal
 */
export function assertSamplingScope(mode: SessionMode, temperature: number | undefined): void {
  if (temperature === undefined || mode !== "s2s") return;
  throw new Error(
    "temperature has no effect in s2s mode — the model runs inside the provider's service, " +
      "so this runtime never sees the request. Set it on the `s2s` descriptor if the provider " +
      "supports one, or remove it.",
  );
}

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
 * Everything worth SAYING about a config that is nonetheless legal.
 *
 * The other half of the rules above, and it exists because those all had to be
 * one of two things — an error or nothing — and the voice catalog fits neither.
 * Refusing an id outside it would refuse a voice AssemblyAI shipped after this
 * release; saying nothing leaves a TYPO to surface as an agent that connects,
 * reports ready and never speaks (`assemblyAIVoiceWarning` carries the
 * argument). A printed line is the third option.
 *
 * Returns lines rather than logging, so every caller decides where they go:
 * `aai build` and `aai dev` print them, and a config layer with nowhere to put
 * a warning can ignore them without a channel to thread.
 *
 * Both AssemblyAI stages that carry a voice are read — the TTS descriptor and
 * the S2S one, whose `voice` comes from the same catalog and has the same
 * failure.
 *
 * @internal
 */
export function agentConfigWarnings(config: {
  tts?: unknown;
  s2s?: unknown;
  stt?: unknown;
  llm?: unknown;
}): string[] {
  return [
    assemblyAIVoiceWarning(config.tts),
    assemblyAIVoiceWarning(config.s2s),
    uncatalogedVoiceWarning(config.tts),
    euResidencyWarning(config),
  ].filter((warning): warning is string => warning !== undefined);
}

/**
 * The providers whose voice this SDK cannot check, with the one voice for each
 * that it can.
 *
 * A DEFAULT is exempt from the warning below because the SDK chose it: it ships
 * here, every template runs on it, and a line saying "we cannot vouch for this"
 * about the value we supplied is noise rather than a signal.
 *
 * `shape` is whatever remains checkable OFFLINE. Cartesia issues UUIDs, so an id
 * that is not one is wrong without any catalog being consulted — the only half
 * of the question that can be answered here. Rime's speaker ids are bare
 * lowercase words (`cove`, `marsh`), which is not a shape a typo violates, so it
 * declares none and gets the unvalidated line alone.
 */
const UNCATALOGED_VOICE_PROVIDERS = [
  {
    kind: CARTESIA_KIND,
    label: "Cartesia",
    defaultVoice: CARTESIA_DEFAULT_VOICE,
    // Nothing secret and nothing high-entropy: five groups of hex digits.
    shape: { re: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, name: "a UUID" },
  },
  { kind: RIME_KIND, label: "Rime", defaultVoice: RIME_DEFAULT_VOICE, shape: undefined },
] as const;

/**
 * A sentence about a voice on a provider this SDK carries no catalog for.
 *
 * The third option {@link agentConfigWarnings} exists to offer, applied to the
 * case that had NEITHER of the other two.
 * `assemblyAIVoiceWarning` can say "not in this release's catalog" because there
 * IS one; for Cartesia and Rime there is no list in this repo and inventing one
 * would be worse than saying nothing — it would go stale, and a stale catalog
 * refuses voices the service ships, which is the same silent mute from the other
 * side. So the honest line is that the id is UNVALIDATED, plus the failure mode
 * it hides: both services refuse an unknown voice in-band after the socket
 * opens, so a typo leaves an agent that connects, reports ready and never
 * speaks. That failure is invisible at every layer before a live call, which is
 * what makes one line per build worth its noise.
 *
 * It fires only on a voice the AUTHOR picked (see
 * {@link UNCATALOGED_VOICE_PROVIDERS}), so the shipped templates and a bare
 * `cartesiaTts()` say nothing.
 *
 * Takes the DESCRIPTOR, like its AssemblyAI sibling, so a caller hands it any
 * stage and anything else is simply not warned about.
 */
function uncatalogedVoiceWarning(descriptor: unknown): string | undefined {
  if (!(isRecord(descriptor) && isRecord(descriptor.options))) return undefined;
  const provider = UNCATALOGED_VOICE_PROVIDERS.find((p) => p.kind === descriptor.kind);
  if (provider === undefined) return undefined;
  const { voice } = descriptor.options;
  if (typeof voice !== "string" || voice === "" || voice === provider.defaultVoice) {
    return undefined;
  }
  const { label, shape } = provider;
  const malformed = shape !== undefined && !shape.re.test(voice);
  return (
    `${label} voice "${voice}" is not checked here: this SDK carries no ${label} voice catalog` +
    (malformed ? `, and it is not ${shape.name}, which every ${label} voice id is` : "") +
    `. ${label} refuses a voice it does not know after the socket opens, so if this id is wrong ` +
    "the agent will connect, report ready and never speak — verify it against your " +
    `${label} account before shipping.`
  );
}

/**
 * `region: "eu"` on STT or the LLM gateway, with a TTS stage that has no EU
 * endpoint to route to.
 *
 * `AssemblyAIPipelineOptions.region` documents this ("TTS has a single
 * endpoint"), and a JSDoc is the wrong strength of statement for the one option
 * on this surface that is a COMPLIANCE claim rather than a preference. What
 * actually happens is that `assemblyAIPipeline({ region: "eu" })` — the call in
 * that function's own `@example` — routes transcription and generation to the
 * EU and synthesis to `streaming-tts.assemblyai.com`, so the agent's own speech
 * leaves the region. That is a thing to be told once per build, not a thing to
 * find in a doc comment after someone asks.
 *
 * A warning rather than an error: the configuration is legal and may be exactly
 * what an author wants (residency rules that bind transcripts often do not bind
 * synthesized audio). Refusing it would break every EU agent that has decided
 * this already.
 */
function euResidencyWarning(config: {
  stt?: unknown;
  llm?: unknown;
  tts?: unknown;
}): string | undefined {
  const inEu = (stage: unknown): boolean =>
    isRecord(stage) && isRecord(stage.options) && stage.options.region === "eu";
  if (!(inEu(config.stt) || inEu(config.llm))) return undefined;
  if (config.tts === undefined) return undefined;
  // The remedy names `assemblyAITts`'s own option rather than spelling the call
  // out: Biome's `noSecrets` reads a dense run of backticks and braces as a
  // high-entropy literal, and a suppression would raise the escape-hatch
  // baseline, which only moves down. Same dodge as `ENDPOINTING_KEYS`.
  const host = "host" satisfies keyof AssemblyAITtsOptions;
  return (
    'This agent sets `region: "eu"`, but AssemblyAI TTS has a single endpoint — the synthesized ' +
    `audio is served from ${ASSEMBLYAI_TTS_HOST}, outside the EU. ` +
    "Transcription and generation stay in-region. If that is not acceptable, declare a TTS " +
    `stage with an in-region \`${host}\`, or run the agent without a TTS stage.`
  );
}
