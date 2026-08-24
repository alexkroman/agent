// Copyright 2025 the AAI authors. MIT license.
/**
 * AssemblyAI Universal-Streaming STT factory — returns a pure descriptor.
 *
 * The descriptor flows through the bundle → server → runtime pipeline
 * without importing the `assemblyai` SDK. The host-side resolver turns
 * it into an openable `SttOpener` during `createRuntime`.
 *
 * The three AssemblyAI stage factories have distinct names
 * (`assemblyAIStt`, `assemblyAILlm`, `assemblyAITts`), so they can be
 * imported side by side:
 *
 * ```ts
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 * import { assemblyAILlm } from "@alexkroman1/aai/llm";
 * import { assemblyAITts } from "@alexkroman1/aai/tts";
 * ```
 */

import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "../../endpointing-constants.ts";
import { omitUndefined } from "../../omit-undefined.ts";
import {
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_TIMEOUT_MS,
} from "../../pipeline-tuning-constants.ts";
import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";

/** Kind tag recognised by the host-side resolver. */
export const ASSEMBLYAI_STT_KIND = "assemblyai" as const;

/** Streaming model used when the descriptor names none. */
export const ASSEMBLYAI_STT_DEFAULT_MODEL = "universal-3-5-pro";

/** Agent-env variable holding the AssemblyAI API key. */
export const ASSEMBLYAI_STT_API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** EU data-residency streaming endpoint. */
export const ASSEMBLYAI_STT_EU_URL = "wss://streaming.eu.assemblyai.com/v3/ws";

/** Options for {@link assemblyAIStt}. */
export interface AssemblyAISttOptions extends ProviderCredentialOptions {
  /**
   * Streaming speech model. Defaults to `"universal-3-5-pro"` (Universal-3.5
   * Pro Real-Time). Arbitrary strings are forwarded to the SDK unchanged.
   */
  model?: "universal-3-5-pro" | string;
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
   * **Unset means DETECT PER TURN, not English** — the same default
   * `elevenlabs` and `sonioxStt` have, and the opposite of `deepgramStt`, whose
   * unset `language` is `"en"`.
   *
   * Universal-3.5 Pro **code-switches across 18 languages by default**, so an
   * unset value costs accuracy on a monolingual line in a way that is easy to
   * misread as an audio problem: measured against tau2-bench, English
   * utterances came back
   * transliterated into Devanagari and Hebrew script
   * (`Hello? Any update?` → `हेलो एनी अपडेट`), including an authentication turn,
   * so the tool call built from it was garbage. Nothing in the transcript says
   * "wrong language" — it reads as a mis-hearing.
   *
   * A single-element list pins one language and keeps code-switching off; omit
   * for a genuinely multilingual line.
   */
  languages?: string[];
  /**
   * Voice focus (voice isolation) mode, sent as the `voice_focus` connection
   * parameter. Defaults to `"near-field"` to suppress background noise for
   * close-mic / phone audio. Set to `""` (or `"off"`) to disable.
   */
  voiceFocus?: "near-field" | "far-field" | "off" | string;
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
   * Silence (ms) before the service runs its end-of-turn check, sent as the
   * `min_turn_silence` connection parameter. At this point the model asks
   * whether the turn reads as COMPLETE — if it does the turn ends, if not a
   * partial is emitted and the turn stays open. So this is the latency floor on
   * utterances that really did finish. Defaults to
   * `DEFAULT_MIN_TURN_SILENCE_MS` (1600).
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
   * Defaults to `DEFAULT_MAX_TURN_SILENCE_MS` (3000); the service's own default
   * is 1536. Raise it for callers who dictate confirmation numbers or
   * addresses, and keep it above {@link minTurnSilenceMs}.
   */
  maxTurnSilenceMs?: number;
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
 * (`assemblyAILlm`), and TTS (`assemblyAITts`) factories can be imported
 * side by side without aliasing.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAIStt } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   stt: assemblyAIStt({ languages: ["en"] }),
 * });
 * ```
 *
 * Pinning `languages` to one code turns code-switching OFF. Unset means
 * "detect per turn", which is not "English" — see
 * {@link AssemblyAISttOptions.languages}.
 */
export function assemblyAIStt(opts: AssemblyAISttOptions = {}): SttProvider {
  return { kind: ASSEMBLYAI_STT_KIND, options: { ...opts } };
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
export function resolveAssemblyAISttSettings(opts: AssemblyAISttOptions): {
  model: string;
  minTurnSilenceMs: number;
  maxTurnSilenceMs: number;
  voiceFocus: string;
  voiceFocusThreshold: number;
  connectTimeoutMs: number;
  maxConnectRetries: number;
  languages?: string[];
  streamingUrl?: string;
  region?: "us" | "eu";
} {
  // "off" is spelled as the empty string on the wire; normalize here so the
  // log and the connection parameter agree on what "disabled" looks like.
  const requestedVoiceFocus = opts.voiceFocus ?? DEFAULT_VOICE_FOCUS;
  return {
    model: opts.model ?? ASSEMBLYAI_STT_DEFAULT_MODEL,
    minTurnSilenceMs: opts.minTurnSilenceMs ?? DEFAULT_MIN_TURN_SILENCE_MS,
    maxTurnSilenceMs: opts.maxTurnSilenceMs ?? DEFAULT_MAX_TURN_SILENCE_MS,
    voiceFocus: requestedVoiceFocus === "off" ? "" : requestedVoiceFocus,
    voiceFocusThreshold: opts.voiceFocusThreshold ?? DEFAULT_VOICE_FOCUS_THRESHOLD,
    connectTimeoutMs: opts.connectTimeoutMs ?? STT_CONNECT_TIMEOUT_MS,
    maxConnectRetries: opts.maxConnectRetries ?? STT_CONNECT_MAX_RETRIES,
    // Absent means "detect per turn" — a defaulted ["en"] here would silently
    // disable multilingual transcription for every agent, so it stays unset.
    ...(opts.languages !== undefined && opts.languages.length > 0
      ? { languages: opts.languages }
      : {}),
    ...(opts.streamingUrl ? { streamingUrl: opts.streamingUrl } : {}),
    ...omitUndefined({ region: opts.region }),
  };
}
