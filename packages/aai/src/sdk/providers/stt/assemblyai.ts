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
import { normalizeKeyterms } from "../../keyterms.ts";
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
   * Terms to bias recognition toward, sent as the `keyterms_prompt` connection
   * parameter — contact names, product names, SKUs, the words a domain uses
   * that a general model has no reason to prefer. Accepted by
   * `universal-3-5-pro` (free) and `universal-streaming-english` (+$0.04/hr).
   *
   * Normalized before it goes on the wire (`normalizeKeyterms`): trimmed,
   * de-duplicated case-insensitively, terms over 50 characters dropped, and the
   * list capped at 100 — the service IGNORES an over-long term and REFUSES a
   * connect carrying more than 100, so a catalogue that grew past the cap would
   * otherwise stop a deployed agent opening sessions at all.
   *
   * Three rules the code cannot check for you, and the reason to keep a list
   * SHORT:
   *
   * - **Uncommon words and proper nouns only.** A common English word is
   *   already recognized, and boosting it buys false positives elsewhere.
   * - **The exact spelling and casing you want in the transcript** — this is
   *   what the model is being told to produce, so `"AssemblyAI"` and
   *   `"assembly ai"` are different requests.
   * - **Start small.** Over-boosting makes the model hear terms that were not
   *   said, which is the same failure this is meant to fix, pointed the other
   *   way.
   *
   * A `dialog()` state may narrow them for one phase of the call —
   * `DialogStateSpec.keyterms`, applied mid-stream.
   */
  keyterms?: string[];
  /**
   * Context about the CONVERSATION, sent as the `agent_context` connection
   * parameter and refreshed per turn with the agent's own latest reply.
   * `universal-3-5-pro` only; other models reject it at connect and strip it
   * mid-stream.
   *
   * Set this to what the application already knows about the call — who is
   * calling, what about, which order — and leave it unset to let the runtime
   * seed the agent's greeting instead. Either way each spoken reply replaces
   * it, so the recognizer transcribing "1-2-3-4" has just been told the agent
   * asked for an order number.
   *
   * Capped at the documented ~1,500 characters, keeping the TAIL: a voice
   * agent's question lands at the end of its reply, and that question is the
   * part worth sending.
   */
  agentContext?: string;
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
   * first, the formatted one right after — and the opener commits only the
   * formatted one, so the turn's commit waits for it.
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
export function assemblyAIStt(options: AssemblyAISttOptions = {}): SttProvider {
  return { kind: ASSEMBLYAI_STT_KIND, options: { ...options } };
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
  connectTimeoutMs: number;
  maxConnectRetries: number;
  languages?: string[];
  streamingUrl?: string;
  region?: "us" | "eu";
  keyterms?: readonly string[];
  agentContext?: string;
  formatTurns?: boolean;
} {
  // "off" is spelled as the empty string on the wire; normalize here so the
  // log and the connection parameter agree on what "disabled" looks like.
  const requestedVoiceFocus = options.voiceFocus ?? DEFAULT_VOICE_FOCUS;
  // NORMALIZED here rather than at the opener, for the reason this whole
  // function exists: the startup line reports these settings, and a list
  // reported with 140 terms while 100 went on the wire is the kind of log that
  // is worse than none. The opener re-runs it for the DROPPED half, which is a
  // warning rather than a setting.
  const keyterms = normalizeKeyterms(options.keyterms ?? []).terms;
  return {
    model: options.model ?? ASSEMBLYAI_STT_DEFAULT_MODEL,
    minTurnSilenceMs: options.minTurnSilenceMs ?? DEFAULT_MIN_TURN_SILENCE_MS,
    maxTurnSilenceMs: options.maxTurnSilenceMs ?? DEFAULT_MAX_TURN_SILENCE_MS,
    voiceFocus: requestedVoiceFocus === "off" ? "" : requestedVoiceFocus,
    voiceFocusThreshold: options.voiceFocusThreshold ?? DEFAULT_VOICE_FOCUS_THRESHOLD,
    connectTimeoutMs: options.connectTimeoutMs ?? STT_CONNECT_TIMEOUT_MS,
    maxConnectRetries: options.maxConnectRetries ?? STT_CONNECT_MAX_RETRIES,
    // Absent means "detect per turn" — a defaulted ["en"] here would silently
    // disable multilingual transcription for every agent, so it stays unset.
    ...(options.languages !== undefined && options.languages.length > 0
      ? { languages: options.languages }
      : {}),
    ...(options.streamingUrl ? { streamingUrl: options.streamingUrl } : {}),
    ...omitUndefined({ region: options.region }),
    // Absent rather than empty: "this agent declares no keyterms" and "this
    // agent declares an empty list" are one thing here, and an empty
    // `keyterms_prompt` is a wire message that CLEARS biasing — which is only
    // meaningful mid-stream, never at connect.
    ...(keyterms.length > 0 ? { keyterms } : {}),
    ...omitUndefined({ agentContext: options.agentContext, formatTurns: options.formatTurns }),
  };
}

/**
 * Is `model` one of the Universal-3.5 Pro streaming family?
 *
 * The one home for that question, because two settings turn on it in opposite
 * directions: `agent_context` is accepted ONLY by this family (connect-time is
 * rejected and mid-stream updates are stripped elsewhere), and `format_turns`
 * is accepted by everything EXCEPT it (formatting there is always on and is
 * not a parameter). Names cover both the dot- and dash-spelled literals plus
 * the SDK's rt-pro aliases.
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
