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
} from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_ERROR_PHRASE,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_TOOL_CHOICE,
  HEARD_AUDIO_LAG_MS,
} from "@alexkroman1/aai/internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { LanguageModel } from "ai";
import { consoleLogger, type Logger } from "../runtime-config.ts";
import type { UsageMeter } from "../usage-meter.ts";
import type { DialogTurnSource } from "./pipeline-dialog-knobs.ts";
import type { TurnGuardrails } from "./pipeline-guardrails.ts";
import type { SkipGreetingOption, TransportCallbacks, TransportSessionConfig } from "./types.ts";

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
  /** Transport-level callbacks into ServerSession. */
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
   * **The owed tau2-bench run happened on 2026-09-09, and it says NO — with a
   * worse number than the one that turned this off.** Same tasks and seed
   * (retail 0-3, seed 42), the default all-AssemblyAI pipeline, ON against a
   * paired OFF arm:
   *
   * - **6 speculations started, 5 adopted, 5 POISONED** — a 100% post-adoption
   *   poison rate, against the 36% measured before. Every adoption reached a
   *   tool call, was discarded whole, and reissued the request.
   * - Response latency moved 4.18s -> 4.11s: **70ms**, inside the noise of a
   *   4-call sample.
   * - Reward 0.25 -> 0.00.
   *
   * The theory it was flipped on was sound and still is: time to first token is
   * p50 701ms on this pipeline while the STT endpointing window is 1600ms, so a
   * mechanism that starts the reply inside that window is attacking the largest
   * term rather than the model's. What defeats it is upstream of latency — this
   * is a tool-calling agent, every speculation that reaches a tool call is
   * discarded by construction, and on retail nearly every turn reaches one. The
   * head start is real and then thrown away.
   *
   * So the case for turning it on is narrower than "a longer head start": it
   * needs a longer head start AND turns that do not call tools. A text-heavy
   * agent, not this one. Do not re-flip this on endpointing evidence alone.
   *
   * Also inert unless
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
  /** Cap on generated tokens per STEP. Omitted when unset (provider default). */
  maxOutputTokens?: number | undefined;
  /**
   * How many times a FAILED provider call is retried — the AI SDK's own
   * `maxRetries`. Omitted when unset, which leaves the vendor default (2).
   */
  maxRetries?: number | undefined;
  /** Tool selection policy passed to `streamText`. Defaults to `"auto"`. */
  toolChoice?: ToolChoice | undefined;
  /**
   * Put the AGENT's `toolChoice` back to `"auto"` after the first step of a
   * reply — see {@link AgentModelTuning.resetToolChoice}. Defaults to `true`,
   * and is inert unless `toolChoice` demands a call.
   *
   * Agent-scoped, so a dialog state's own `toolChoice` overrides it on every
   * step rather than being reset alongside the agent's: the preparers are
   * composed in that order, and `pipeline-llm-stream.ts` spells the whole
   * precedence out.
   */
  resetToolChoice?: boolean | undefined;
  /**
   * This session's guardrails, already bound to their context — see
   * `pipeline-guardrails.ts`. Absent for every agent that declares none, which
   * is what keeps the speech funnel unwrapped on the shipped path.
   */
  guardrails?: TurnGuardrails | undefined;
  /**
   * This session's token meter — see `usage-meter.ts`. Absent when the host
   * built none, in which case nothing is counted and no budget is enforced.
   */
  usage?: UsageMeter | undefined;
  /** Logger. Defaults to consoleLogger. */
  logger?: Logger | undefined;
  /** Skip the initial greeting (used for session resume). */
  skipGreeting?: SkipGreetingOption | undefined;
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
  /**
   * The per-state knobs this session's `dialog()` machines ask of the turn about
   * to run — see {@link DialogTurnSource}.
   *
   * Absent for every agent that declares no dialog, and for one whose states
   * carry only instructions and deadlines: it is present exactly when some state
   * declares a `bargeIn`, `toolChoice` or `temperature`, which is also what
   * turns preemptive generation off (see {@link preemptiveGeneration} and the
   * speculation's construction in `pipeline-transport.ts`).
   *
   * Each of the four settings it can carry OVERRIDES the agent-level option of
   * the same name for as long as that state is active, and an absent one leaves
   * the agent's own value alone.
   */
  dialogTurn?: DialogTurnSource | undefined;
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
  resetToolChoice: boolean;
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

/**
 * `value ?? fallback`, named.
 *
 * Written out, twenty `??` operators in one expression trip Biome's cognitive
 * complexity ceiling — which is a fair reading of a function that is one long
 * defaulting table, and a bad reason to split the table in two: the whole point
 * of this function is that every default is visible in one place. The helper
 * keeps that property and costs one word per row.
 */
function or<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

/** Apply the documented default for every defaultable option. */
export function resolvePipelineOptions(options: PipelineTransportOptions): ResolvedPipelineOptions {
  return {
    log: or(options.logger, consoleLogger),
    sttSampleRate: or(options.sttSampleRate, DEFAULT_STT_SAMPLE_RATE),
    ttsSampleRate: or(options.ttsSampleRate, DEFAULT_TTS_SAMPLE_RATE),
    maxSteps: or(options.maxSteps, DEFAULT_MAX_STEPS),
    // Opt-OUT, like OpenAI's `reset_tool_choice`: the failure it prevents (a
    // `toolChoice: "required"` re-applied on every step, burning the whole
    // `maxSteps` budget before `forceFinalAnswer` rescues the turn) is silent
    // and costs the caller a wait, and the behaviour it removes is one almost
    // nobody wants. Inert for the `"auto"` default, so this changes nothing for
    // an agent that never set `toolChoice`.
    resetToolChoice: or(options.resetToolChoice, true),
    minBargeInWords: or(options.minBargeInWords, DEFAULT_MIN_BARGE_IN_WORDS),
    interruptionMinDurationMs: or(
      options.interruptionMinDurationMs,
      DEFAULT_INTERRUPTION_MIN_DURATION_MS,
    ),
    deadAirCoverMs: or(options.deadAirCoverMs, DEFAULT_DEAD_AIR_COVER_MS),
    heardLagMs: or(options.heardLagMs, HEARD_AUDIO_LAG_MS),
    errorPhrase: or(options.errorPhrase, DEFAULT_ERROR_PHRASE),
    startFailurePhrase: or(options.startFailurePhrase, DEFAULT_START_FAILURE_PHRASE),
    resumeFalseInterruption: or(options.resumeFalseInterruption, true),
    preemptiveGeneration: or(options.preemptiveGeneration, false),
    speechIdleTimeoutMs: or(options.speechIdleTimeoutMs, DEFAULT_SPEECH_IDLE_TIMEOUT_MS),
    toolChoice: or(options.toolChoice, DEFAULT_TOOL_CHOICE),
    toolSchemas: or(options.toolSchemas, []),
    executeTool: options.executeTool,
  };
}
