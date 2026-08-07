// Copyright 2026 the AAI authors. MIT license.
// Configuration surface for `createPipelineTransport` — split out of
// `pipeline-transport.ts` so the transport module stays focused on turn
// orchestration. This module also owns the defaulting (`resolvePipelineOptions`)
// so each option's default lives next to its documentation rather than being
// re-applied at the point of use.

import type { LanguageModel } from "ai";
import type { ExecuteTool, ToolSchema } from "../../sdk/_internal-types.ts";
import {
  DEFAULT_DEAD_AIR_COVER_MS,
  DEFAULT_ERROR_PHRASE,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TOOL_CHOICE,
  DEFAULT_TTS_SAMPLE_RATE,
  HEARD_AUDIO_LAG_MS,
} from "../../sdk/constants.ts";
import type { SttOpener, TtsOpener } from "../../sdk/providers.ts";
import type { ToolChoice } from "../../sdk/types.ts";
import { consoleLogger, type Logger } from "../runtime-config.ts";
import type { TransportCallbacks, TransportSessionConfig } from "./types.ts";

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
   * that stream when the committed final matches. Defaults to `true`;
   * `false` disables speculation entirely.
   *
   * STILL UNMEASURED here — see `AgentDef.preemptiveGeneration` for the two
   * logs that would quantify what it saves, and for what the two structural
   * guardrails make impossible regardless. Inert unless `toolChoice` is
   * `"auto"` or `"none"`: a pinned or required tool means every speculation
   * ends at the tool boundary and is discarded whole, so it would be pure cost.
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
  skipGreeting?: boolean | undefined;
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
    preemptiveGeneration: opts.preemptiveGeneration ?? true,
    speechIdleTimeoutMs: opts.speechIdleTimeoutMs ?? DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
    toolChoice: opts.toolChoice ?? DEFAULT_TOOL_CHOICE,
    toolSchemas: opts.toolSchemas ?? [],
    executeTool: opts.executeTool,
  };
}
