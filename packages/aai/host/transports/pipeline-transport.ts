// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.
//
// Pipeline mode executes tools inline via streamText's `tools.execute`.
// `callbacks.onToolCall` is observability-only; runtime.ts routes it to
// `client.toolCall` directly (bypassing SessionCore's tool-dispatch path,
// which is S2S-only). `sendToolResult` is a no-op because results are
// already handled by streamText.

import type { LanguageModel, ModelMessage } from "ai";
import type { ExecuteTool, ToolSchema } from "../../sdk/_internal-types.ts";
import {
  DEFAULT_ENDPOINT_SETTLE_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
} from "../../sdk/constants.ts";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { SttError, SttOpener, TtsError, TtsOpener } from "../../sdk/providers.ts";
import type { Message, ToolChoice } from "../../sdk/types.ts";
import { errorMessage } from "../../sdk/utils.ts";
import { bytesToPcm16 } from "../_pcm.ts";
import { consoleLogger, type Logger } from "../runtime-config.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { createEndpointSettler } from "./pipeline-endpointing.ts";
import { createPipelineHistory } from "./pipeline-history.ts";
import { createPipelineProviderSessions } from "./pipeline-providers.ts";
import { createToolCallRepair } from "./pipeline-repair.ts";
import {
  countWords,
  createPlaybackClock,
  DEFAULT_HOLD_PHRASE,
  flushTtsAndWait,
  consumeLlmStream as runLlmStream,
} from "./pipeline-stream.ts";
import type { Transport, TransportCallbacks, TransportSessionConfig } from "./types.ts";

/** Configuration for {@link createPipelineTransport}. */
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
   * finals/partials into one utterance. A clearly-complete final commits
   * immediately regardless. Defaults to {@link DEFAULT_ENDPOINT_SETTLE_MS}; set
   * 0 to disable (commit every final at once).
   */
  endpointSettleMs?: number | undefined;
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
}

/** Create a pipeline-mode Transport (STT → LLM → TTS). */
export function createPipelineTransport(opts: PipelineTransportOptions): Transport {
  const log = opts.logger ?? consoleLogger;
  const sttSampleRate = opts.sttSampleRate ?? DEFAULT_STT_SAMPLE_RATE;
  const ttsSampleRate = opts.ttsSampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const minBargeInWords = opts.minBargeInWords ?? DEFAULT_MIN_BARGE_IN_WORDS;
  const endpointSettleMs = opts.endpointSettleMs ?? DEFAULT_ENDPOINT_SETTLE_MS;
  const toolChoice = opts.toolChoice ?? "auto";
  const repairToolCall = createToolCallRepair(opts.llm, log);
  const toolSchemas = opts.toolSchemas ?? [];
  const executeTool: ExecuteTool =
    opts.executeTool ??
    (async () => {
      throw new Error("No executeTool provided");
    });

  const { callbacks, sessionConfig } = opts;
  const systemPrompt = sessionConfig.systemPrompt;

  const sessionAbort = new AbortController();
  let audioReady = false;
  let terminated = false;
  let turnController: AbortController | null = null;
  let nextReplyId = 0;
  // Endpoint settling: STT finals buffer in the settler until the settle
  // window elapses (or a clearly-complete final arrives), so disfluent
  // multi-final utterances commit as a single turn. See pipeline-endpointing.ts
  // and onSttFinal / onSttPartial below.
  const settler = createEndpointSettler({
    settleMs: endpointSettleMs,
    onCommit: (text) => {
      if (terminated) return;
      callbacks.onUserTranscript(text);
      chainTurn(() =>
        runTurn(text).catch((err: unknown) => {
          log.error("Pipeline turn crashed", { error: errorMessage(err), sid: opts.sid });
        }),
      );
    },
  });
  // Pipeline transport owns its conversation memory; SessionCore does not own
  // the conversation in pipeline mode (we build LLM messages per turn). Keeps a
  // text view (client/resume/tool-context) and a ModelMessage view (what the
  // LLM sees, incl. tool calls/results). See pipeline-history.ts.
  const history = createPipelineHistory(sessionConfig.history);
  let turnPromise: Promise<void> | null = null;
  // Tracks when the client is estimated to finish playing forwarded TTS audio,
  // so barge-in keeps working after the server-side turn is done but buffered
  // audio is still playing client-side (see createPlaybackClock).
  const playbackClock = createPlaybackClock(ttsSampleRate);

  // Provider lifecycle (open/adopt/close of the STT+TTS pair) lives in
  // pipeline-providers.ts; the handlers below route provider events back
  // into this turn orchestrator. Handler functions are declarations, so
  // they're hoisted past this initializer.
  const providers = createPipelineProviderSessions({
    sid: opts.sid,
    stt: opts.stt,
    tts: opts.tts,
    providerKeys: opts.providerKeys,
    sttSampleRate,
    ttsSampleRate,
    sttPrompt: opts.sttPrompt,
    greeting: sessionConfig.greeting,
    signal: sessionAbort.signal,
    handlers: {
      onSttPartial,
      onSttFinal,
      onSttError,
      onTtsError,
      onTtsAudio: (pcm) => {
        playbackClock.onChunk(pcm);
        callbacks.onAudioChunk(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      },
    },
    onAudioReady,
    emitError,
    log,
  });

  // Built once per session, not per turn: per-call aborts still track the
  // owning turn because streamText forwards its own abortSignal into each
  // execute's options, which takes precedence in toVercelTools.
  const tools = toVercelTools(toolSchemas, {
    executeTool,
    sessionId: opts.sid,
    messages: () => history.conversation,
  });

  function chainTurn(start: () => Promise<void>): void {
    turnPromise = (turnPromise ?? Promise.resolve()).then(start);
  }

  function emitError(code: SessionErrorCode, message: string): void {
    callbacks.onError(code, message);
  }

  /** Abort the in-flight turn (if any) and cancel TTS playback. */
  function abortInFlightTurn(): void {
    turnController?.abort();
    turnController = null;
    providers.tts?.cancel();
    // Every abort path ends with the client flushing its playback buffer
    // (`cancelled` for barge-in/client cancel, `reset` for reset, teardown
    // for terminate), so the estimated-playback clock restarts from zero.
    playbackClock.reset();
  }

  /** Shared turn tail — clear the controller unless a newer turn replaced it. */
  function finishTurn(ctl: AbortController): void {
    if (turnController === ctl) turnController = null;
  }

  // Idempotent teardown after an unrecoverable provider error.
  function terminate(): void {
    if (terminated) return;
    terminated = true;
    settler.reset();
    abortInFlightTurn();
    callbacks.onCancelled();
    sessionAbort.abort();
    // Close whatever was adopted before the failure (e.g. TTS went live and
    // started the greeting, then STT's open failed) — it must not outlive
    // the terminate. Providers also close on the abort signal; this covers
    // openers wired after the signal check.
    void providers.close();
  }

  function onSttPartial(text: string): void {
    if (terminated) return;
    // A partial while an utterance is buffered means the speaker resumed after
    // a pause: extend the settle window so the continuation aggregates into the
    // same turn instead of the pre-pause fragment committing on its own.
    if (settler.extendOnPartial(text)) return;
    if (turnController === null && !playbackClock.pending()) return;
    if (countWords(text) < minBargeInWords) return;
    log.info("Pipeline barge-in", { sid: opts.sid });
    abortInFlightTurn();
    callbacks.onCancelled();
  }

  function onSttFinal(text: string): void {
    if (terminated) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Interrupt the agent's in-flight reply only for a clearly-intentional
    // (>= threshold) utterance. A shorter one does NOT interrupt — it falls
    // through to be buffered and answered once the reply finishes (chainTurn
    // defers it). Previously a below-threshold final while speaking was dropped
    // here, silently losing real short answers ("yes", a ZIP) spoken over the
    // agent.
    const speaking = turnController !== null || playbackClock.pending();
    if (speaking && countWords(trimmed) >= minBargeInWords) {
      log.info("Pipeline replacing in-flight turn", { sid: opts.sid });
      abortInFlightTurn();
      callbacks.onCancelled();
    }
    settler.push(trimmed);
  }

  function onSttError(err: SttError): void {
    if (terminated) return;
    log.error("STT error", { code: err.code, message: err.message, sid: opts.sid });
    emitError("stt", err.message);
    terminate();
  }

  function onTtsError(err: TtsError): void {
    if (terminated) return;
    log.error("TTS error", { code: err.code, message: err.message, sid: opts.sid });
    emitError("tts", err.message);
    terminate();
  }

  const consumeLlmStream = (
    ctl: AbortController,
    onDelta: (delta: string) => void,
  ): Promise<ModelMessage[] | undefined> =>
    runLlmStream({
      llm: opts.llm,
      systemPrompt,
      messages: history.llm,
      tools,
      toolChoice,
      temperature: opts.temperature,
      repairToolCall,
      maxSteps,
      sendTtsText: (text) => providers.tts?.sendText(text),
      callbacks,
      emitError,
      log,
      sid: opts.sid,
      ctl,
      onDelta,
    });

  /** Per-turn TTS drain — see flushTtsAndWait in pipeline-stream.ts. */
  function drainTts(signal: AbortSignal): Promise<void> {
    return flushTtsAndWait({ tts: providers.tts, signal, log, sid: opts.sid });
  }

  /**
   * Shared reply scaffold: mint the reply id and turn controller, run the
   * turn body, then drain TTS (only when the body produced speech — a
   * tool-call-only turn sends no text to the TTS context, so the provider
   * never emits `done` and flushTtsAndWait would burn the full
   * PIPELINE_FLUSH_TIMEOUT_MS (~10s) on every silent turn) and finish.
   *
   * Do NOT call callbacks.onAudioDone() here — session-core's flushReply
   * (triggered by onReplyDone) emits audioDone + replyDone together, matching
   * the S2S transport contract. Calling it here would double-fire audio_done.
   */
  async function runReply(
    idPrefix: string,
    body: (ctl: AbortController) => Promise<boolean /* spoke */>,
  ): Promise<void> {
    callbacks.onReplyStarted(`${idPrefix}-${++nextReplyId}`);

    const ctl = new AbortController();
    turnController = ctl;

    const spoke = await body(ctl);
    if (spoke && !ctl.signal.aborted) await drainTts(ctl.signal);

    if (!ctl.signal.aborted) callbacks.onReplyDone();
    finishTurn(ctl);
  }

  function runTurn(userText: string): Promise<void> {
    return runReply("pipeline", async (ctl) => {
      history.pushConversation({ role: "user", content: userText });
      history.pushLlm({ role: "user", content: userText });

      let accumulated = "";
      const responseMessages = await consumeLlmStream(ctl, (delta) => {
        accumulated += delta;
      });

      if (ctl.signal.aborted) {
        // Barge-in mid-turn: persist the spoken-so-far text so the next turn's
        // LLM knows it was cut off. `accumulated` is the generated text (our
        // best proxy — there is no playback-position feedback). Marker goes to
        // history only; the client gets raw text + the interrupted flag.
        const spoken = accumulated.trim();
        if (spoken.length > 0 && spoken !== DEFAULT_HOLD_PHRASE) {
          callbacks.onAgentTranscript(spoken, true);
          const marked = `${spoken} [interrupted]`;
          history.pushConversation({ role: "assistant", content: marked });
          history.pushLlm({ role: "assistant", content: marked });
          providers.stt?.updateAgentContext?.(spoken);
        }
        return false;
      }

      // Persist the assistant tool-call message(s) and their `tool` results so
      // the next turn retains tool context, not just the spoken transcript.
      if (responseMessages && responseMessages.length > 0) history.pushLlm(...responseMessages);

      if (accumulated.length === 0) return false;
      callbacks.onAgentTranscript(accumulated, false);
      history.pushConversation({ role: "assistant", content: accumulated });
      // Seed the STT provider with the agent's side of the dialog so the
      // next user turn is transcribed with it in context (AssemblyAI
      // Universal-3.5 Pro only; other providers have no such hook).
      providers.stt?.updateAgentContext?.(accumulated);
      return true;
    });
  }

  function runGreeting(text: string): Promise<void> {
    return runReply("pipeline-greeting", async () => {
      callbacks.onAgentTranscript(text, false);
      history.pushConversation({ role: "assistant", content: text });
      history.pushLlm({ role: "assistant", content: text });
      providers.tts?.sendText(text);
      // Also push the greeting mid-stream, even though it was already seeded
      // as the initial agent context at STT connect time (providers.open) —
      // keeps the two seeding paths symmetric and covers providers that only
      // support the mid-stream hook.
      providers.stt?.updateAgentContext?.(text);
      return true;
    });
  }

  function onAudioReady(): void {
    if (audioReady || terminated) return;
    audioReady = true;
    if (opts.skipGreeting) return;
    const greeting = sessionConfig.greeting;
    if (!greeting) return;
    chainTurn(() =>
      runGreeting(greeting).catch((err: unknown) => {
        log.error("Pipeline greeting failed", { error: errorMessage(err), sid: opts.sid });
      }),
    );
  }

  return {
    async start(): Promise<void> {
      // STT and TTS open concurrently; a failed side (with the session still
      // live) tears the whole transport down.
      if ((await providers.open()) === "failed") terminate();
      // S2S fires onSessionReady when the provider acks; in pipeline mode the
      // equivalent "ready" signal is providers having opened.
      callbacks.onSessionReady?.(opts.sid);
      onAudioReady();
    },

    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      // Gate late inbound work (sendUserAudio into a closing STT session)
      // the same way a provider-error teardown does.
      terminated = true;
      settler.reset();
      sessionAbort.abort();
      turnController?.abort();
      providers.unsubscribe();
      if (turnPromise !== null) await turnPromise;
      await providers.close();
    },

    sendUserAudio(bytes: Uint8Array): void {
      if (terminated || !audioReady) return;
      providers.stt?.sendAudio(bytesToPcm16(bytes));
    },

    // Tool execution stays inside toVercelTools/streamText; results aren't
    // routed through the transport.
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for pipeline mode
    sendToolResult(_callId: string, _result: string): void {},

    cancelReply(): void {
      if (terminated) return;
      abortInFlightTurn();
      // Do NOT call callbacks.onCancelled() here — session-core.onCancel
      // (client-initiated) calls client.cancelled() itself. Barge-in fires
      // onCancelled directly in onSttPartial where the cancel originates here.
    },

    seedHistory(messages: readonly Message[]): void {
      // Client-resent history on reconnect; restore both views so the resumed
      // agent keeps memory of the prior conversation.
      history.seed(messages);
    },

    reset(): void {
      settler.reset();
      abortInFlightTurn();
      history.reset();
    },
  };
}
