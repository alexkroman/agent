// Copyright 2026 the AAI authors. MIT license.
/**
 * The effective settings each resolved provider stage will run with — what
 * the runtime reports in its one-line "Session mode resolved" log.
 *
 * The kind alone (`stt: "assemblyai"`) answers "which vendor" and nothing
 * else, and every interesting provider setting on this codebase is a DEFAULT
 * rather than something the agent wrote down: the endpointing pair, the Voice
 * Focus threshold, the connect budget, the TTS voice, the gateway model id.
 * Those are exactly the values a live session gets blamed for — a split
 * utterance, a mute agent, background speech in the transcript — and until
 * now none of them appeared anywhere at startup, so diagnosing one meant
 * re-deriving the `??` chains by hand against a build you hope is deployed.
 *
 * Each stage's defaults come from the SAME `resolve*Settings` function its
 * opener dials with (`sdk/providers/**`), never a second copy of the `??`
 * chains here — a settings log that can drift from the wire is worse than no
 * log, because it is believed. Those modules are pure descriptor data, so
 * importing them costs none of the vendor-SDK load time `lazyOpener` exists
 * to defer.
 */

import {
  ASSEMBLYAI_LLM_KIND,
  ASSEMBLYAI_STT_KIND,
  ASSEMBLYAI_TTS_KIND,
  CARTESIA_KIND,
  DEEPGRAM_KIND,
  ELEVENLABS_KIND,
  RIME_KIND,
  resolveAssemblyAISttSettings,
  resolveAssemblyAITtsSettings,
  resolveCartesiaTtsSettings,
  resolveDeepgramSttSettings,
  resolveElevenLabsSttSettings,
  resolveRimeTtsSettings,
  resolveSonioxSttSettings,
  SONIOX_KIND,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import type { S2sProvider } from "@alexkroman1/aai/s2s";
import type {
  AssemblyAISttOptions,
  DeepgramSttOptions,
  ElevenLabsSttOptions,
  SonioxSttOptions,
  SttProvider,
} from "@alexkroman1/aai/stt";
import type {
  AssemblyAITtsOptions,
  CartesiaTtsOptions,
  RimeTtsOptions,
  TtsProvider,
} from "@alexkroman1/aai/tts";

/** A stage's reported settings: plain JSON-safe values, never a credential. */
export type ProviderSettings = Record<string, unknown>;

type Descriptor = { readonly kind: string; readonly options: ProviderSettings };
type SettingsFor = (options: ProviderSettings) => ProviderSettings;

/**
 * The three stage tables are keyed separately because the kind tag is NOT
 * unique across stages — `ASSEMBLYAI_STT_KIND`, `ASSEMBLYAI_TTS_KIND`,
 * `ASSEMBLYAI_LLM_KIND` and `ASSEMBLYAI_S2S_KIND` are four different
 * constants all equal to `"assemblyai"`, so one flat map would resolve an
 * AssemblyAI TTS stage through the STT resolver and report an endpointing
 * window for a synthesizer.
 */
const STT_SETTINGS: Record<string, SettingsFor> = {
  [ASSEMBLYAI_STT_KIND]: (o) => resolveAssemblyAISttSettings(o as AssemblyAISttOptions),
  [DEEPGRAM_KIND]: (o) => resolveDeepgramSttSettings(o as DeepgramSttOptions),
  [ELEVENLABS_KIND]: (o) => resolveElevenLabsSttSettings(o as ElevenLabsSttOptions),
  [SONIOX_KIND]: (o) => resolveSonioxSttSettings(o as SonioxSttOptions),
};

const TTS_SETTINGS: Record<string, SettingsFor> = {
  [ASSEMBLYAI_TTS_KIND]: (o) => resolveAssemblyAITtsSettings(o as AssemblyAITtsOptions),
  [CARTESIA_KIND]: (o) => resolveCartesiaTtsSettings(o as CartesiaTtsOptions),
  [RIME_KIND]: (o) => resolveRimeTtsSettings(o as RimeTtsOptions),
};

/**
 * LLM stages carry their defaults in the DESCRIPTOR, not the opener: the
 * factories bake `model` (and AssemblyAI's `reasoningEffort`, which is a
 * correctness requirement rather than a preference — see
 * `TOOLS_REQUIRE_NO_REASONING`) in at authoring time. So the descriptor's own
 * options already are the effective settings, and the one host-side backstop
 * is the model id for a descriptor that reached us without one.
 */
const LLM_SETTINGS: Record<string, SettingsFor> = {
  [ASSEMBLYAI_LLM_KIND]: (o) => ({ ...o, model: o.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL }),
};

function describe(
  table: Record<string, SettingsFor>,
  descriptor: Descriptor | undefined,
): ProviderSettings | undefined {
  if (!descriptor) return;
  // An unregistered kind (a `registerLlmKind` extension, or a descriptor from
  // a newer SDK than this host) still reports its own options rather than
  // dropping to a bare kind — the point is to show what the stage runs with.
  const settings = table[descriptor.kind]?.(descriptor.options) ?? descriptor.options;
  return { kind: descriptor.kind, ...settings };
}

/**
 * Describe the stages of a resolved session for the startup log.
 *
 * Pipeline mode reports all three stages; S2S reports the one socket. The
 * shape mirrors what `createRuntime` resolved, so a missing stage is visible
 * as a missing key rather than silently reported as the default vendor.
 */
export function describeResolvedProviders(resolved: {
  mode: "pipeline" | "s2s";
  stt?: SttProvider | undefined;
  llm?: LlmProvider | undefined;
  tts?: TtsProvider | undefined;
  s2s?: S2sProvider | undefined;
}): ProviderSettings {
  if (resolved.mode === "pipeline") {
    return {
      stt: describe(STT_SETTINGS, resolved.stt),
      llm: describe(LLM_SETTINGS, resolved.llm),
      tts: describe(TTS_SETTINGS, resolved.tts),
    };
  }
  // No stage table: an S2S descriptor's options ARE its effective settings
  // (`assemblyAIS2s({ voice, languages, keyterms })` since 2026-08-09), so
  // `describe`'s own fallthrough reports them and there is nothing host-side to
  // fill in. An ABSENT descriptor reports as absent, like a missing pipeline
  // stage above — naming a vendor for a descriptor that is not there is the one
  // thing this log must never do.
  return { s2s: describe({}, resolved.s2s) };
}
