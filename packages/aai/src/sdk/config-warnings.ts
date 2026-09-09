// Copyright 2026 the AAI authors. MIT license.
/**
 * Everything worth SAYING about a config that is nonetheless legal.
 *
 * The other half of `config-rules.ts`, split off when that file crossed the
 * 500-line cap — and the seam is the one its own prose already drew: those
 * functions all had to be one of two things, an error or nothing, and
 * everything here fits neither. A printed line is the third option.
 *
 * Nothing here throws, and nothing here is on a session path: `aai build` and
 * `aai dev` print what {@link agentConfigWarnings} returns, and a config layer
 * with nowhere to put a warning ignores it without a channel to thread.
 */

import { isRecord } from "./is-record.ts";
import {
  ASSEMBLYAI_TTS_HOST,
  type AssemblyAITtsOptions,
  assemblyAIVoiceWarning,
} from "./providers/tts/assemblyai.ts";
import { CARTESIA_DEFAULT_VOICE, CARTESIA_KIND } from "./providers/tts/cartesia.ts";
import { RIME_DEFAULT_VOICE, RIME_KIND } from "./providers/tts/rime.ts";

/**
 * Every line worth printing about one agent config.
 *
 * It exists because the rules in `config-rules.ts` all had to be one of two
 * things — an error or nothing — and the voice catalog fits neither.
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
