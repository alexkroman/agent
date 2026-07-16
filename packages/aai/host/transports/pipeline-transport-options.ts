// Copyright 2026 the AAI authors. MIT license.
// Configuration surface for `createPipelineTransport` — split out of
// `pipeline-transport.ts` so the transport module stays focused on turn
// orchestration. Runtime defaults are applied in the transport itself.

import type { LanguageModel } from "ai";
import type { ExecuteTool, ToolSchema } from "../../sdk/_internal-types.ts";
import type { SttOpener, TtsOpener } from "../../sdk/providers.ts";
import type { ToolChoice } from "../../sdk/types.ts";
import type { Logger } from "../runtime-config.ts";
import type { TransportCallbacks, TransportSessionConfig } from "./types.ts";

/** Configuration for `createPipelineTransport`. */
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
  executeTool?: ExecuteTool;
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
  /** Max LLM tool-call steps per turn. Defaults to 5. */
  maxSteps?: number | undefined;
  /**
   * Minimum interim-transcript words required to barge in on the agent while
   * it is speaking. Defaults to DEFAULT_MIN_BARGE_IN_WORDS (1 = interrupt on
   * any non-empty interim).
   */
  minBargeInWords?: number | undefined;
  /**
   * Endpoint settle window (ms): how long to wait after an STT `final` for the
   * speaker to continue before committing the turn, aggregating follow-on
   * finals/partials into one utterance. Defaults to
   * DEFAULT_ENDPOINT_SETTLE_MS; set 0 to disable (commit every final at once).
   */
  endpointSettleMs?: number | undefined;
  /**
   * Settle window (ms) for clearly-complete finals — shorter than
   * `endpointSettleMs` (and capped by it) so finished requests pay little
   * latency while sentence-boundary pauses mid-request still aggregate.
   * Defaults to DEFAULT_COMPLETE_ENDPOINT_SETTLE_MS; 0 commits complete
   * finals immediately.
   */
  completeSettleMs?: number | undefined;
  /**
   * Phrase spoken when the model's first action in a turn is a tool call with
   * no preceding speech. Defaults to DEFAULT_HOLD_PHRASE; `""` disables.
   */
  holdPhrase?: string | undefined;
  /**
   * False-interruption recovery window (ms): when a barge-in aborts the
   * in-flight reply but no user turn commits within this window, the agent
   * resumes the interrupted reply via a synthetic continuation turn.
   * Defaults to DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS; 0 disables.
   */
  falseInterruptionTimeoutMs?: number | undefined;
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
  /** Take an unprompted turn after this many ms of user silence. Unset/non-positive disables. */
  silenceTimeoutMs?: number | undefined;
  /** Instruction injected on silence timeout. Defaults to DEFAULT_SILENCE_PROMPT. */
  silencePrompt?: string | undefined;
}
