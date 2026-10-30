// Copyright 2025 the AAI authors. MIT license.
/**
 * AssemblyAI Universal-Streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `assemblyai` SDK. The host-side resolver turns
 * it into an openable `SttOpener` during `createRuntime`.
 *
 * The three AssemblyAI stage factories have distinct names
 * (`assemblyAIStt`, `llm({ provider: "assemblyai" })`, `assemblyAITts`), so they can be
 * imported side by side:
 *
 * ```ts
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 * import { llm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "../../endpointing-constants.ts";
import { omitUndefined } from "../../omit-undefined.ts";
import {
  DEFAULT_VAD_THRESHOLD,
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_TIMEOUT_MS,
} from "../../pipeline-tuning-constants.ts";
import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";
import { defineProvider, describeProvider } from "../define-provider.ts";

/** This vendor's registration (see `define-provider.ts`); the constants below derive from it. */
export const ASSEMBLYAI_STT_PROVIDER = defineProvider({
  kind: "assemblyai",
  stage: "stt",
  envVar: "ASSEMBLYAI_API_KEY",
  label: "AssemblyAI",
  factory: "assemblyAIStt",
  subpath: "stt",
});

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_STT_KIND = ASSEMBLYAI_STT_PROVIDER.kind;

/** Streaming model used when the descriptor names none. */
export const ASSEMBLYAI_STT_DEFAULT_MODEL = "universal-3-5-pro";

/**
 * Languages sent as `language_codes` when the descriptor names none: English
 * only, which turns Universal-3.5 Pro's code-switching OFF.
 *
 * Unset used to mean "code-switch across 18 languages", and on an English line
 * that turned caller backchannels into non-English text the pipeline then took
 * as real turns — in one tau2-bench run `mm-hm` came back as `نن.` (21x) and
 * `और` (16x), cutting the agent off mid-reply and once being read as consent
 * for a write. Opt back into code-switching with `languages: []`, or bias
 * toward a known subset with several codes (see
 * {@link AssemblyAISttOptions.languages}).
 */
export const ASSEMBLYAI_STT_DEFAULT_LANGUAGES: readonly string[] = Object.freeze(["en"]);

/** Agent-env variable holding the AssemblyAI API key. */
export const ASSEMBLYAI_STT_API_KEY_ENV: string = ASSEMBLYAI_STT_PROVIDER.envVar;

/** EU data-residency streaming endpoint. */
export const ASSEMBLYAI_STT_EU_URL: string = "wss://streaming.eu.assemblyai.com/v3/ws";

/**
 * Options for {@link assemblyAIStt}.
 *
 * @input
 */
export interface AssemblyAISttOptions extends ProviderCredentialOptions {
  /**
   * Streaming speech model. Defaults to `"universal-3-5-pro"` (Universal-3.5
   * Pro Real-Time). Arbitrary strings are forwarded to the SDK unchanged.
   */
  model?: "universal-3-5-pro" | (string & {});
  /**
   * EU data-residency — routes both streaming and sync transcription to
   * AssemblyAI's EU endpoints (`streaming.eu.assemblyai.com` /
   * `sync.eu.assemblyai.com`). Required for EU-region API keys, which the US
   * endpoints reject. Defaults to `"us"`.
   */
  region?: "us" | "eu";
  /**
   * Streaming WebSocket endpoint override, sent as the SDK's
   * `websocketBaseUrl`. Must include the versioned path (e.g.
   * `wss://streaming.sandbox000.assemblyai-labs.com/v3/ws`) — the SDK only
   * supplies that path for its own default host, so a bare origin connects to
   * the wrong route.
   *
   * Takes precedence over {@link AssemblyAISttOptions.region}: an explicit
   * endpoint is a deliberate choice and must not be silently overwritten by
   * the residency shorthand. Intended for pre-release/staging clusters and
   * A/B measurement against the default host; leave unset in production.
   */
  streamingUrl?: string;
  /**
   * Languages to bias the model toward, sent as the `language_codes` connection
   * parameter (e.g. `["en"]`, `["en", "es"]`).
   *
   * **Unset means ENGLISH** (`ASSEMBLYAI_STT_DEFAULT_LANGUAGES`, `["en"]`),
   * the same default `deepgramStt` has, and the opposite of `elevenLabsStt`
   * and `sonioxStt`, which auto-detect when unset.
   *
   * - **unset** — `["en"]`: English only, code-switching off.
   * - **one code** (`["es"]`) — pins that language, code-switching off.
   * - **several codes** (`["en", "es"]`) — biases toward that subset and keeps
   *   code-switching between them. Sent exactly as given.
   * - **`[]`** — sends no `language_codes` at all, so Universal-3.5 Pro
   *   code-switches across all 18 languages it supports. This is the opt-in
   *   for a genuinely multilingual line.
   *
   * Code-switching is not the default because it costs accuracy on a
   * monolingual line in a way that is easy to misread as an audio problem:
   * measured against tau2-bench, English utterances came back transliterated
   * into Devanagari and Hebrew script (`Hello? Any update?` → `हेलो एनी अपडेट`),
   * and caller backchannels (`mm-hm`) came back as `نن.` (21x) and `और`
   * (16x) — non-English text the pipeline took as real caller turns, cutting
   * the agent off mid-reply. Nothing in the transcript says "wrong language" —
   * it reads as a mis-hearing.
   */
  languages?: readonly string[];
  /**
   * Voice focus (voice isolation) mode, sent as the `voice_focus` connection
   * parameter. Defaults to `"near-field"` to suppress background noise for
   * close-mic / phone audio. Set to `""` (or `"off"`) to disable.
   */
  voiceFocus?: "near-field" | "far-field" | "off" | (string & {});
  /**
   * How aggressively Voice Focus suppresses background audio, sent as the
   * `voice_focus_threshold` connection parameter (0-1, higher is more
   * aggressive). Defaults to `DEFAULT_VOICE_FOCUS_THRESHOLD` (0.9), above the
   * service's own 0.7.
   *
   * Raise it when BACKGROUND SPEECH — a television, a radio, another
   * conversation — is reaching the transcript. That is the case the default is
   * tuned for, and the case no VAD setting can fix: those frames really are
   * speech, so a frame gate cannot distinguish them from the caller (see the
   * constant's doc for the measurement). Lower it if the caller's own quiet or
   * distant speech is being suppressed.
   *
   * Ignored when {@link voiceFocus} is off — it tunes that filter.
   */
  voiceFocusThreshold?: number;
  /**
   * Confidence (0-1) the service's voice-activity detector needs before a frame
   * counts as speech, sent as the `vad_threshold` connection parameter. Defaults
   * to `DEFAULT_VAD_THRESHOLD` (0.02), well under the service's own 0.2.
   *
   * Lower it when a caller's speech is going UNHEARD — no `speech.started`, no
   * transcript, not even a wrong one — rather than mis-heard. The gate sits in
   * front of the model, so a voice that scores just under it never reaches the
   * model at all. Measured on tau2-bench retail: one caller voice, after 8 kHz
   * mu-law telephony encoding, produced zero service events at the default;
   * replayed across that voice's calls, caller transcripts went 12 -> 19 of 30
   * lines at 0.01 (0.02: 18) while background speech leaking into the
   * transcript stayed at 2-3 throughout.
   *
   * Not a substitute for {@link voiceFocusThreshold}: background SPEECH passes
   * any VAD, because it is speech. And a lower gate means the service reports
   * speech more readily, which is what opens a barge-in — check interruptions
   * on a live run before shipping a low value.
   */
  vadThreshold?: number;
  /**
   * Silence (ms) before the service runs its end-of-turn check, sent as the
   * `min_turn_silence` connection parameter. At this point the model asks
   * whether the turn reads as COMPLETE — if it does the turn ends, if not a
   * partial is emitted and the turn stays open. So this is the latency floor on
   * utterances that really did finish. Defaults to
   * `DEFAULT_MIN_TURN_SILENCE_MS` (800), which relies on continuation
   * (`interruption.continuationWindowMs`) to re-join a turn split mid-entity —
   * set 1600 here if you turn continuation off.
   *
   * To tolerate longer mid-utterance pauses, raise {@link maxTurnSilenceMs}
   * instead — and never above it. This is a minimum and that is a maximum, so a
   * value above the ceiling means the check can never fire before the
   * content-blind force-end closes the turn, which is the split this knob is
   * usually reached for in order to prevent.
   */
  minTurnSilenceMs?: number;
  /**
   * Maximum silence (ms) before the service force-ends a turn regardless of
   * content, sent as the `max_turn_silence` connection parameter. This is the
   * pause-tolerance knob: it bounds only utterances that never read as
   * complete, so raising it costs an ordinary finished sentence nothing.
   * Defaults to `DEFAULT_MAX_TURN_SILENCE_MS` (3500); the service's own default
   * is 1536. Raise it for callers who dictate confirmation numbers or
   * addresses, and keep it above {@link minTurnSilenceMs}.
   */
  maxTurnSilenceMs?: number;
  /**
   * Whether the service applies punctuation, casing and inverse text
   * normalization to a committed turn — "my number is nine seven two" becomes
   * "My number is 972…" — sent as the `format_turns` connection parameter.
   *
   * **Not a parameter on `universal-3-5-pro`, where formatting is ALWAYS ON**;
   * setting it there is not sent, and the opener says so at warn level rather
   * than letting an author believe they turned formatting off.
   * On `universal-streaming-english` the service default is `false`, so that
   * model's transcripts are lowercase, unpunctuated and spelled-out until this
   * is set.
   *
   * It is a single explicit flag because the thing it changes is the tool-call
   * ARGUMENT the model emits from a dictated identifier, and that is worth
   * A/B-ing rather than inheriting. Note what `true` costs mechanically: that
   * model then emits TWO `end_of_turn` messages per turn — the unformatted one
   * first, the formatted one right after — so the opener demotes the
   * unformatted one to a PARTIAL and commits only the formatted text. Without
   * that the agent answers the same sentence twice, the second time on a
   * history already containing its own reply; `isCommittingTurn` in
   * `aai-runtime`'s `providers/stt/_assemblyai-turn.ts` is where it lives, and
   * it is load-bearing rather than tidy-up.
   */
  formatTurns?: boolean;
  /**
   * Deadline for one streaming connect attempt — socket open *and* the
   * server's `Begin` message. Defaults to `STT_CONNECT_TIMEOUT_MS`
   * (2500 ms), overriding the SDK's own 1000 ms, which a healthy handshake
   * can exceed. `0` waits indefinitely.
   */
  connectTimeoutMs?: number;
  /**
   * Extra connect attempts after a transient failure (timeout, network drop,
   * unexpected close); permanent failures such as auth are never retried.
   * Defaults to `STT_CONNECT_MAX_RETRIES` (2). `0` disables retries.
   *
   * Raising either knob widens the worst-case open time
   * (`(1 + retries) * connectTimeoutMs` plus the retry delays), which has to
   * stay under `DEFAULT_SESSION_START_TIMEOUT_MS` — see the connect-budget
   * note in `sdk/constants.ts`.
   */
  maxConnectRetries?: number;
}

/**
 * Build an AssemblyAI STT descriptor.
 *
 * The API key is resolved host-side from the agent's env
 * (`ASSEMBLYAI_API_KEY`); there is no factory-time key parameter, so the
 * descriptor stays free of secrets and safe to serialize.
 *
 * Named `assemblyAIStt` (not `assemblyAI`) so the STT, LLM
 * (`llm({ provider: "assemblyai" })`), and TTS (`assemblyAITts`) factories can be imported
 * side by side without aliasing.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   stt: assemblyAIStt({ languages: ["en"] }),
 * });
 * ```
 *
 * Unset `languages` means English only (code-switching OFF); pass `[]` to
 * code-switch across every supported language, or several codes to bias
 * toward a subset — see {@link AssemblyAISttOptions.languages}.
 */
export function assemblyAIStt(options: AssemblyAISttOptions = {}): SttProvider {
  return describeProvider(ASSEMBLYAI_STT_PROVIDER, options);
}

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in.
 *
 * Shared by the opener (which maps these onto the SDK's parameter names) and
 * by the runtime's "Session mode resolved" log, so what is reported is by
 * construction what goes on the wire. A second copy of these `??` chains for
 * the log would be a copy that drifts, and every one of these knobs has a
 * measured value behind it (see the constants' docs) — "which endpointing
 * window is this session on" has to be answerable without re-deriving it.
 */
export function resolveAssemblyAISttSettings(options: AssemblyAISttOptions): {
  model: string;
  minTurnSilenceMs: number;
  maxTurnSilenceMs: number;
  voiceFocus: string;
  voiceFocusThreshold: number;
  vadThreshold: number;
  connectTimeoutMs: number;
  maxConnectRetries: number;
  languages?: readonly string[];
  streamingUrl?: string;
  region?: "us" | "eu";
  formatTurns?: boolean;
} {
  // "off" is spelled as the empty string on the wire; normalize here so the
  // log and the connection parameter agree on what "disabled" looks like.
  const requestedVoiceFocus = options.voiceFocus ?? DEFAULT_VOICE_FOCUS;
  return {
    model: options.model ?? ASSEMBLYAI_STT_DEFAULT_MODEL,
    minTurnSilenceMs: options.minTurnSilenceMs ?? DEFAULT_MIN_TURN_SILENCE_MS,
    maxTurnSilenceMs: options.maxTurnSilenceMs ?? DEFAULT_MAX_TURN_SILENCE_MS,
    voiceFocus: requestedVoiceFocus === "off" ? "" : requestedVoiceFocus,
    voiceFocusThreshold: options.voiceFocusThreshold ?? DEFAULT_VOICE_FOCUS_THRESHOLD,
    connectTimeoutMs: options.connectTimeoutMs ?? STT_CONNECT_TIMEOUT_MS,
    maxConnectRetries: options.maxConnectRetries ?? STT_CONNECT_MAX_RETRIES,
    // Absent means English (ASSEMBLYAI_STT_DEFAULT_LANGUAGES). An explicit
    // empty list is the opt-out: no `language_codes` is sent, so the model
    // code-switches across every language it supports.
    ...resolveLanguages(options.languages),
    // An empty `streamingUrl` means "use the default endpoint", same as absent.
    ...(options.streamingUrl !== undefined && options.streamingUrl !== ""
      ? { streamingUrl: options.streamingUrl }
      : {}),
    ...omitUndefined({ region: options.region }),
    ...omitUndefined({ formatTurns: options.formatTurns }),
    vadThreshold: options.vadThreshold ?? DEFAULT_VAD_THRESHOLD,
  };
}

function resolveLanguages(languages: readonly string[] | undefined): {
  languages?: readonly string[];
} {
  if (languages === undefined) return { languages: ASSEMBLYAI_STT_DEFAULT_LANGUAGES };
  return languages.length > 0 ? { languages } : {};
}

/**
 * Is `model` one of the Universal-3.5 Pro streaming family?
 *
 * The one home for that question, which `format_turns` turns on: it is
 * accepted by everything EXCEPT this family (formatting there is always on and
 * is not a parameter). (`agent_context`, accepted ONLY here, was the other such
 * setting until v17 stopped sending it.) Names cover both the dot- and
 * dash-spelled literals plus the SDK's rt-pro aliases.
 *
 * @internal
 */
export function isUniversal35Pro(model: string): boolean {
  return UNIVERSAL_3_5_PRO_MODELS.has(model);
}

const UNIVERSAL_3_5_PRO_MODELS: ReadonlySet<string> = new Set([
  "universal-3-5-pro",
  "u3-rt-pro",
  "u3-rt-pro-beta-1",
  "u3-rt-agent",
]);
