// Copyright 2026 the AAI authors. MIT license.
// Configuration surface for `createPipelineTransport` — split out of
// `pipeline-transport.ts` so the transport module stays focused on turn
// orchestration. This module also owns the defaulting (`resolvePipelineOptions`)
// so each option's default lives next to its documentation rather than being
// re-applied at the point of use.

import type { ToolChoice } from "@alexkroman1/aai";
import type { ExecuteTool, SttOpener, TtsOpener } from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_DEAD_AIR_COVER_MS,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  HEARD_AUDIO_LAG_MS,
} from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_ERROR_PHRASE,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_TOOL_CHOICE,
} from "@alexkroman1/aai/internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { LanguageModel } from "ai";
import { consoleLogger, type Logger } from "../runtime-config.ts";
import type { SkipGreeting, TransportCallbacks, TransportSessionConfig } from "./types.ts";

/**
 * Configuration for `createPipelineTransport`.
 * @internal
 */
export interface PipelineTransportOptions {
  /** Unique session identifier. */
  sid: string;
  /** STT opener (resolved from an SttProvider descriptor). */
  stt: SttOpener;
  /** LLM provider (Vercel AI SDK LanguageModel). */
  llm: LanguageModel;
  /** TTS opener (resolved from a TtsProvider descriptor). */
  tts: TtsOpener;
  /** Transport-level callbacks into SessionCore. */
  callbacks: TransportCallbacks;
  /** Session config: systemPrompt, greeting, tools, history. */
  sessionConfig: TransportSessionConfig;
  /** Tool schemas (JSON Schema) for Vercel AI tool binding. */
  toolSchemas?: readonly ToolSchema[];
  /** Agent's tool-execution function. */
  executeTool: ExecuteTool;
  /** Provider-specific API keys. */
  providerKeys: {
    stt: string;
    tts: string;
  };
  /** STT audio input sample rate (PCM16, Hz). Defaults to DEFAULT_STT_SAMPLE_RATE. */
  sttSampleRate?: number | undefined;
  /** TTS audio output sample rate (PCM16, Hz). Defaults to DEFAULT_TTS_SAMPLE_RATE. */
  ttsSampleRate?: number | undefined;
  /** Optional STT prompt injected via SttOpenOptions.sttPrompt. */
  sttPrompt?: string | undefined;
  /** Max LLM tool-call steps per turn. Defaults to DEFAULT_MAX_STEPS. */
  maxSteps?: number | undefined;
  /**
   * Minimum interim-transcript words required to barge in on the agent while
   * it is speaking. Defaults to DEFAULT_MIN_BARGE_IN_WORDS (2), which keeps
   * one-word backchannels ("mhm", "yeah") from cutting the agent off.
   */
  minBargeInWords?: number | undefined;
  /**
   * Minimum sustained speech (ms since the utterance's first interim
   * transcript) before an interim-triggered barge-in aborts the reply — a
   * duration gate alongside `minBargeInWords`. Committed turns (STT finals)
   * are never gated. Defaults to DEFAULT_INTERRUPTION_MIN_DURATION_MS; 0
   * disables the gate.
   */
  interruptionMinDurationMs?: number | undefined;
  /**
   * How long a turn may send nothing to TTS before the transport speaks a short
   * filler. Defaults to {@link DEFAULT_DEAD_AIR_COVER_MS}; `0` disables the
   * cover outright. The phrases are not configurable — see that constant.
   */
  deadAirCoverMs?: number | undefined;
  /**
   * Phrase spoken when the turn's LLM stream fails. Defaults to
   * `DEFAULT_ERROR_PHRASE`; `""` disables.
   */
  errorPhrase?: string | undefined;
  /**
   * Phrase spoken when a provider fails to open and the session cannot start.
   * Defaults to DEFAULT_START_FAILURE_PHRASE; `""` disables.
   */
  startFailurePhrase?: string | undefined;
  /**
   * Resume the interrupted reply via a synthetic continuation turn when a
   * barge-in aborts it and no user turn ever commits (STT noise, a
   * hallucinated partial). Defaults to true. The WAIT is not configurable
   * here: it is the speaking edge going idle — see `speechIdleTimeoutMs`.
   */
  resumeFalseInterruption?: boolean | undefined;
  /**
   * Start generating the reply from a high-confidence STT interim and adopt
   * that stream when the committed final matches. **Defaults to `false`.**
   *
   * **It is off because it was finally measured, and it buys ~8ms per caller
   * turn.** The `headStartMs` / adoption-rate log this constant's doc had been
   * asking for since it shipped was collected over a tau2-bench retail run
   * (`Pipeline speculation adopted` at info, the discards at debug):
   *
   * - 16 speculations started, 14 adopted, head start p50 **0.44s**
   * - **5 of the 14 (36%) were POISONED after adoption** — a tool call arrived
   *   in the adopted stream, which is unusable whole, so `consumeLlmStream`
   *   discards the generation and reissues the request. Each had burned p50
   *   0.69s (p90 1.34s) first.
   *
   * Netted out: 9 turns at +0.44s against 5 at -0.69s is **+0.51s across 68
   * caller turns, +8ms each** — nothing beside a p50 first word of ~1.0s and a
   * p90 of 6.6s. For that it issued 16 LLM requests of which **7 (44%) were
   * thrown away**, and it widens the turn-serialization bound, since a
   * speculation runs outside the turn chain. The 36% that lose also lose on
   * the TOOL-CALLING turns, which are already the slow ones.
   *
   * **Do not try to fix it by gating adoption on "has it produced text yet".**
   * That was tried and reverted the same day: the head start (0.44s) is
   * SHORTER than LLM time-to-first-token (p50 1.10s), so at the moment `take()`
   * runs the speculation has generated nothing at all and such a gate rejects
   * essentially every adoption — leaving the wasted request and none of the
   * benefit, which is strictly worse than off. Whether the first part will be
   * text or a tool call is simply not knowable at adoption time; that is the
   * shape of the feature, not a defect in the gate.
   *
   * Turning it back on wants a case where the arithmetic differs: a
   * text-heavy agent (the 36% poison rate is a tool-calling agent's number),
   * or a longer head start from later endpointing. Also inert unless
   * `toolChoice` is `"auto"` or `"none"` — a pinned or required tool ends every
   * speculation at the tool boundary, so it would be pure cost.
   */
  preemptiveGeneration?: boolean | undefined;
  /**
   * How long after the last STT partial to force `speech_stopped` when no
   * non-empty final ever arrives — and, because that is the signal a false
   * interruption is recognised by, the false-interruption resume deadline
   * itself. See {@link DEFAULT_SPEECH_IDLE_TIMEOUT_MS}, which it defaults to.
   * Exposed for tests, which need a window shorter than the shipped one; 0
   * disables the watchdog, and with it recovery outright.
   */
  speechIdleTimeoutMs?: number | undefined;
  /**
   * LLM sampling temperature. Omitted when unset (provider default). Some models
   * (e.g. Claude 5) ignore it and warn; set only for temperature-capable models.
   */
  temperature?: number | undefined;
  /** Tool selection policy passed to `streamText`. Defaults to `"auto"`. */
  toolChoice?: ToolChoice | undefined;
  /** Logger. Defaults to consoleLogger. */
  logger?: Logger | undefined;
  /** Skip the initial greeting (used for session resume). */
  skipGreeting?: SkipGreeting | undefined;
  /**
   * How far behind the server's "audio forwarded" bookkeeping the caller's ear
   * is, in ms — subtracted from the estimated playback position to get the
   * heard cursor. Defaults to {@link HEARD_AUDIO_LAG_MS}.
   *
   * Transport-only and NOT an agent field (same precedent as
   * `speechIdleTimeoutMs`): it exists for testability. Specs run in
   * milliseconds of wall clock, where the shipped 750 makes every interrupted
   * reply the "heard nothing" case, so a spec about PARTIAL truncation cannot
   * be written without lowering it.
   */
  heardLagMs?: number | undefined;
  /**
   * Clock source for the heard cursor and the playback estimate. Defaults to
   * `Date.now`. Test-only seam: a spec that wants "the caller heard 1.2
   * seconds" would otherwise have to sleep for 1.2 real seconds.
   */
  heardNow?: (() => number) | undefined;
  /** Take an unprompted turn after this many ms of user silence. Unset/non-positive disables. */
  silenceTimeoutMs?: number | undefined;
  /** Instruction injected on silence timeout. Defaults to DEFAULT_SILENCE_PROMPT. */
  silencePrompt?: string | undefined;
}

/**
 * The subset of {@link PipelineTransportOptions} that carries a default, with
 * every default applied. Resolving these in one place keeps the transport from
 * re-deriving `?? DEFAULT_X` at each point of use — the failure mode being a
 * value that differs between two sites that both thought they owned it.
 */
export interface ResolvedPipelineOptions {
  log: Logger;
  sttSampleRate: number;
  ttsSampleRate: number;
  maxSteps: number;
  minBargeInWords: number;
  interruptionMinDurationMs: number;
  deadAirCoverMs: number;
  heardLagMs: number;
  errorPhrase: string;
  startFailurePhrase: string;
  resumeFalseInterruption: boolean;
  preemptiveGeneration: boolean;
  speechIdleTimeoutMs: number;
  toolChoice: ToolChoice;
  toolSchemas: readonly ToolSchema[];
  executeTool: ExecuteTool;
}

/** Apply the documented default for every defaultable option. */
export function resolvePipelineOptions(opts: PipelineTransportOptions): ResolvedPipelineOptions {
  return {
    log: opts.logger ?? consoleLogger,
    sttSampleRate: opts.sttSampleRate ?? DEFAULT_STT_SAMPLE_RATE,
    ttsSampleRate: opts.ttsSampleRate ?? DEFAULT_TTS_SAMPLE_RATE,
    maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
    minBargeInWords: opts.minBargeInWords ?? DEFAULT_MIN_BARGE_IN_WORDS,
    interruptionMinDurationMs:
      opts.interruptionMinDurationMs ?? DEFAULT_INTERRUPTION_MIN_DURATION_MS,
    deadAirCoverMs: opts.deadAirCoverMs ?? DEFAULT_DEAD_AIR_COVER_MS,
    heardLagMs: opts.heardLagMs ?? HEARD_AUDIO_LAG_MS,
    errorPhrase: opts.errorPhrase ?? DEFAULT_ERROR_PHRASE,
    startFailurePhrase: opts.startFailurePhrase ?? DEFAULT_START_FAILURE_PHRASE,
    resumeFalseInterruption: opts.resumeFalseInterruption ?? true,
    preemptiveGeneration: opts.preemptiveGeneration ?? false,
    speechIdleTimeoutMs: opts.speechIdleTimeoutMs ?? DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
    toolChoice: opts.toolChoice ?? DEFAULT_TOOL_CHOICE,
    toolSchemas: opts.toolSchemas ?? [],
    executeTool: opts.executeTool,
  };
}
