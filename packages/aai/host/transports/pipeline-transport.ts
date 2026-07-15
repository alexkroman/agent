// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.
//
// Pipeline mode executes tools inline via streamText's `tools.execute`.
// `callbacks.onToolCall` is observability-only; runtime.ts routes it to
// `client.toolCall` directly (bypassing SessionCore's tool-dispatch path,
// which is S2S-only). `sendToolResult` is a no-op because results are
// already handled by streamText.

import type { LanguageModel, ModelMessage } from "ai";
import { smoothStream, stepCountIs, streamText } from "ai";
import type { ExecuteTool, ToolSchema } from "../../sdk/_internal-types.ts";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  PIPELINE_FLUSH_TIMEOUT_MS,
} from "../../sdk/constants.ts";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type {
  SttError,
  SttOpener,
  SttSession,
  TtsError,
  TtsOpener,
  TtsSession,
  Unsubscribe,
} from "../../sdk/providers.ts";
import type { Message, ToolChoice } from "../../sdk/types.ts";
import { errorMessage } from "../../sdk/utils.ts";
import { consoleLogger, type Logger } from "../runtime-config.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import { createPipelineHistory } from "./pipeline-history.ts";
import { createToolCallRepair } from "./pipeline-repair.ts";
import { createStreamPartHandler } from "./pipeline-stream.ts";
import type { Transport, TransportCallbacks, TransportSessionConfig } from "./types.ts";

/** Configuration for {@link createPipelineTransport}. */
export interface PipelineTransportOptions {
  /** Unique session identifier. */
  sid: string;
  /** Agent slug. */
  agent: string;
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
  let sttSession: SttSession | null = null;
  let ttsSession: TtsSession | null = null;
  let turnController: AbortController | null = null;
  let nextReplyId = 0;
  // Pipeline transport owns its conversation memory; SessionCore does not own
  // the conversation in pipeline mode (we build LLM messages per turn). Keeps a
  // text view (client/resume/tool-context) and a ModelMessage view (what the
  // LLM sees, incl. tool calls/results). See pipeline-history.ts.
  const history = createPipelineHistory(sessionConfig.history);
  let turnPromise: Promise<void> | null = null;
  const sttSubs: Unsubscribe[] = [];
  const ttsSubs: Unsubscribe[] = [];

  function chainTurn(p: Promise<void>): void {
    turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
  }

  function emitError(code: SessionErrorCode, message: string): void {
    callbacks.onError(code, message);
  }

  /** Abort the in-flight turn (if any) and cancel TTS playback. */
  function abortInFlightTurn(): void {
    turnController?.abort();
    turnController = null;
    ttsSession?.cancel();
  }

  /** Shared turn tail — clear the controller unless a newer turn replaced it. */
  function finishTurn(ctl: AbortController): void {
    if (turnController === ctl) turnController = null;
  }

  // Idempotent teardown after an unrecoverable provider error.
  function terminate(): void {
    if (terminated) return;
    terminated = true;
    abortInFlightTurn();
    callbacks.onCancelled();
    sessionAbort.abort();
  }

  function onSttPartial(_text: string): void {
    if (terminated) return;
    if (turnController === null) return;
    log.info("Pipeline barge-in", { sid: opts.sid });
    abortInFlightTurn();
    callbacks.onCancelled();
  }

  function onSttFinal(text: string): void {
    if (terminated) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (turnController !== null) {
      log.info("Pipeline replacing in-flight turn", { sid: opts.sid });
      abortInFlightTurn();
      callbacks.onCancelled();
    }
    callbacks.onUserTranscript(text);
    const turn = runTurn(trimmed).catch((err: unknown) => {
      log.error("Pipeline turn crashed", { error: errorMessage(err), sid: opts.sid });
    });
    chainTurn(turn);
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

  async function consumeLlmStream(
    ctl: AbortController,
    messages: ModelMessage[],
    tools: ReturnType<typeof toVercelTools>,
    onDelta: (delta: string) => void,
  ): Promise<ModelMessage[] | undefined> {
    try {
      const result = streamText({
        model: opts.llm,
        system: systemPrompt,
        messages,
        tools,
        toolChoice,
        // Temperature only when set — Claude 5 ignores it and warns.
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        // Coalesce text deltas into whole words for TTS; delayInMs:null = no latency.
        experimental_transform: smoothStream({ delayInMs: null, chunking: "word" }),
        experimental_repairToolCall: repairToolCall,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: ctl.signal,
      });
      const handlePart = createStreamPartHandler({
        onDelta,
        sendTtsText: (text) => ttsSession?.sendText(text),
        onToolCall: callbacks.onToolCall,
        onToolCallDone: callbacks.onToolCallDone,
        emitError,
        log,
        sid: opts.sid,
      });
      for await (const part of result.fullStream) {
        if (ctl.signal.aborted) break;
        handlePart(part);
      }
      if (ctl.signal.aborted) return;
      // Gather every step's response messages (assistant tool-call + `tool`
      // result + text) so tool context carries into the next turn. Top-level
      // `result.response.messages` is final-step only and drops the tool call.
      const steps = await result.steps;
      return steps.flatMap((step) => step.response.messages);
    } catch (err: unknown) {
      if (!ctl.signal.aborted) {
        const msg = errorMessage(err);
        log.error("LLM streamText failed", { error: msg, sid: opts.sid });
        emitError("llm", msg);
      }
    }
  }

  // Resolves on TTS `done`, signal abort, or PIPELINE_FLUSH_TIMEOUT_MS elapsed.
  function flushTtsAndWait(signal: AbortSignal): Promise<void> {
    const tts = ttsSession;
    if (!tts) return Promise.resolve();
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let off: Unsubscribe | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (off) {
          off();
          off = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal.removeEventListener("abort", onAbort);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => finish();
      signal.addEventListener("abort", onAbort, { once: true });
      off = tts.on("done", finish);
      timer = setTimeout(() => {
        log.warn("TTS flush timeout", { sid: opts.sid, timeoutMs: PIPELINE_FLUSH_TIMEOUT_MS });
        finish();
      }, PIPELINE_FLUSH_TIMEOUT_MS);
      tts.flush();
    });
  }

  async function runTurn(userText: string): Promise<void> {
    const replyId = `pipeline-${++nextReplyId}`;
    callbacks.onReplyStarted(replyId);
    history.pushConversation({ role: "user", content: userText });
    history.pushLlm({ role: "user", content: userText });

    const ctl = new AbortController();
    turnController = ctl;

    const tools = toVercelTools(toolSchemas, {
      executeTool,
      sessionId: opts.sid,
      messages: () => history.conversation,
      signal: ctl.signal,
    });

    let accumulated = "";
    const responseMessages = await consumeLlmStream(ctl, history.llm, tools, (delta) => {
      accumulated += delta;
    });

    if (ctl.signal.aborted) {
      finishTurn(ctl);
      return;
    }

    // Persist the assistant tool-call message(s) and their `tool` results so
    // the next turn retains tool context, not just the spoken transcript.
    if (responseMessages && responseMessages.length > 0) history.pushLlm(...responseMessages);

    if (accumulated.length > 0) {
      callbacks.onAgentTranscript(accumulated, false);
      history.pushConversation({ role: "assistant", content: accumulated });
      // Seed the STT provider with the agent's side of the dialog so the
      // next user turn is transcribed with it in context (AssemblyAI
      // Universal-3.5 Pro only; other providers have no such hook).
      sttSession?.updateAgentContext?.(accumulated);

      // Only flush/await TTS when the turn actually produced speech. A
      // tool-call-only turn sends no text to the TTS context, so the provider
      // never emits `done` and flushTtsAndWait would burn the full
      // PIPELINE_FLUSH_TIMEOUT_MS (~10s) on every silent turn.
      await flushTtsAndWait(ctl.signal);

      if (ctl.signal.aborted) {
        finishTurn(ctl);
        return;
      }
    }

    // Do NOT call callbacks.onAudioDone() here — session-core's flushReply
    // (triggered by onReplyDone) emits audioDone + replyDone together, matching
    // the S2S transport contract. Calling it here would double-fire audio_done.
    callbacks.onReplyDone();
    finishTurn(ctl);
  }

  async function runGreeting(text: string): Promise<void> {
    const replyId = `pipeline-greeting-${++nextReplyId}`;
    callbacks.onReplyStarted(replyId);

    const ctl = new AbortController();
    turnController = ctl;

    callbacks.onAgentTranscript(text, false);
    history.pushConversation({ role: "assistant", content: text });
    history.pushLlm({ role: "assistant", content: text });
    ttsSession?.sendText(text);
    // Also push the greeting mid-stream, even though it was already seeded
    // as the initial agent context at STT connect time (openProviders) —
    // keeps the two seeding paths symmetric and covers providers that only
    // support the mid-stream hook.
    sttSession?.updateAgentContext?.(text);

    await flushTtsAndWait(ctl.signal);

    if (ctl.signal.aborted) {
      finishTurn(ctl);
      return;
    }

    // See runTurn: onReplyDone triggers session-core's flushReply which emits
    // audioDone + replyDone together; firing onAudioDone here would double-fire.
    callbacks.onReplyDone();
    finishTurn(ctl);
  }

  function reportOpenRejection(which: "stt" | "tts", reason: unknown): void {
    const msg = errorMessage(reason);
    log.error(`${which === "stt" ? "STT" : "TTS"} open failed`, {
      error: msg,
      sid: opts.sid,
    });
    emitError(which, msg);
  }

  async function adoptStt(session: SttSession, teardown: boolean): Promise<void> {
    if (teardown) {
      await session.close().catch(() => undefined);
      return;
    }
    sttSession = session;
    sttSubs.push(session.on("partial", onSttPartial));
    sttSubs.push(session.on("final", onSttFinal));
    sttSubs.push(session.on("error", onSttError));
  }

  async function adoptTts(session: TtsSession, teardown: boolean): Promise<void> {
    if (teardown) {
      await session.close().catch(() => undefined);
      return;
    }
    ttsSession = session;
    ttsSubs.push(
      session.on("audio", (pcm) => {
        callbacks.onAudioChunk(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      }),
    );
    // `done` is intentionally NOT subscribed persistently — flushTtsAndWait
    // attaches a one-shot listener per-turn to avoid double-firing audio_done.
    ttsSubs.push(session.on("error", onTtsError));
  }

  async function openProviders(): Promise<void> {
    const [sttResult, ttsResult] = await Promise.allSettled([
      opts.stt.open({
        sampleRate: sttSampleRate,
        apiKey: opts.providerKeys.stt,
        sttPrompt: opts.sttPrompt,
        // Seed the agent's opening line as connect-time context (e.g.
        // AssemblyAI `agent_context`) — providers that don't support it, or
        // whose model doesn't qualify, ignore this field.
        agentContext: sessionConfig.greeting,
        signal: sessionAbort.signal,
      }),
      opts.tts.open({
        sampleRate: ttsSampleRate,
        apiKey: opts.providerKeys.tts,
        signal: sessionAbort.signal,
      }),
    ]);

    if (sttResult.status === "rejected") reportOpenRejection("stt", sttResult.reason);
    if (ttsResult.status === "rejected") reportOpenRejection("tts", ttsResult.reason);

    const aborted = sessionAbort.signal.aborted;
    const sttFailed = sttResult.status === "rejected";
    const ttsFailed = ttsResult.status === "rejected";
    const teardown = aborted || sttFailed || ttsFailed;

    if (sttResult.status === "fulfilled") await adoptStt(sttResult.value, teardown);
    if (ttsResult.status === "fulfilled") await adoptTts(ttsResult.value, teardown);

    if (!aborted && (sttFailed || ttsFailed)) terminate();
  }

  function onAudioReady(): void {
    if (audioReady || terminated) return;
    audioReady = true;
    if (opts.skipGreeting) return;
    const greeting = sessionConfig.greeting;
    if (!greeting) return;
    const turn = runGreeting(greeting).catch((err: unknown) => {
      log.error("Pipeline greeting failed", { error: errorMessage(err), sid: opts.sid });
    });
    chainTurn(turn);
  }

  return {
    async start(): Promise<void> {
      await openProviders();
      // S2S fires onSessionReady when the provider acks; in pipeline mode the
      // equivalent "ready" signal is providers having opened.
      callbacks.onSessionReady?.(opts.sid);
      onAudioReady();
    },

    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      turnController?.abort();
      for (const off of sttSubs) off();
      for (const off of ttsSubs) off();
      sttSubs.length = 0;
      ttsSubs.length = 0;
      if (turnPromise !== null) await turnPromise;
      await sttSession?.close().catch(() => {
        /* already closed */
      });
      await ttsSession?.close().catch(() => {
        /* already closed */
      });
    },

    sendUserAudio(bytes: Uint8Array): void {
      if (terminated || !audioReady) return;
      const { byteOffset: offset, byteLength: length } = bytes;
      let pcm: Int16Array;
      if (offset % 2 === 0 && length % 2 === 0) {
        pcm = new Int16Array(bytes.buffer, offset, length / 2);
      } else {
        const copy = new Uint8Array(length - (length % 2));
        copy.set(bytes.subarray(0, copy.byteLength));
        pcm = new Int16Array(copy.buffer);
      }
      sttSession?.sendAudio(pcm);
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
      abortInFlightTurn();
      history.reset();
    },
  };
}
