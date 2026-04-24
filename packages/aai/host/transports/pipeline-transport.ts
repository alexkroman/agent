// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.

// NOTE — unresolved integration gaps for Task 15 (SessionCore wiring):
//
// 1. Double tool execution risk.
//    This transport fires `callbacks.onToolCall(callId, name, args)` for
//    observability while tools still execute inline via streamText's
//    `tools.execute` closures. When wired to SessionCore, SessionCore's
//    `onToolCall` ALSO invokes `executeTool` and pushes results to
//    `transport.sendToolResult` (which is a no-op for pipeline mode).
//    Task 15 must either route the pipeline's tool-call observability
//    through a different callback, or give SessionCore a mode flag that
//    skips its own tool dispatch when the transport executes inline.
//
// 2. Unbounded conversation message growth.
//    `conversationMessages` here is a transport-local array used to build
//    `streamText.messages`. It has no sliding-window cap. SessionCore owns
//    the canonical history with a `maxHistory` cap; Task 15 should wire
//    the transport to read from SessionCore's history instead of keeping
//    a parallel unbounded copy.

import type { LanguageModel, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import type { ExecuteTool, ToolSchema } from "../../sdk/_internal-types.ts";
import {
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  PIPELINE_FLUSH_TIMEOUT_MS,
} from "../../sdk/constants.ts";
import type { ErrorCode } from "../../sdk/protocol.ts";
import type {
  SttError,
  SttOpener,
  SttSession,
  TtsError,
  TtsOpener,
  TtsSession,
  Unsubscribe,
} from "../../sdk/providers.ts";
import type { Message } from "../../sdk/types.ts";
import { errorMessage } from "../../sdk/utils.ts";
import { consoleLogger, type Logger } from "../runtime-config.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
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
  /** Logger. Defaults to consoleLogger. */
  logger?: Logger | undefined;
  /** Skip the initial greeting (used for session resume). */
  skipGreeting?: boolean | undefined;
}

function toModelMessage(m: Message): ModelMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  return { role: "assistant", content: m.content };
}

/** Create a pipeline-mode Transport (STT → LLM → TTS). */
export function createPipelineTransport(opts: PipelineTransportOptions): Transport {
  const log = opts.logger ?? consoleLogger;
  const sttSampleRate = opts.sttSampleRate ?? DEFAULT_STT_SAMPLE_RATE;
  const ttsSampleRate = opts.ttsSampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const maxSteps = opts.maxSteps ?? 5;
  const toolSchemas = opts.toolSchemas ?? [];
  const executeTool: ExecuteTool =
    opts.executeTool ??
    (async () => {
      throw new Error("No executeTool provided");
    });

  const { callbacks, sessionConfig } = opts;

  // Derive the system prompt — pipeline mode always uses voice=true.
  // In the refactored transport, we receive the final systemPrompt directly
  // from sessionConfig (built by the caller). We use it as-is but also keep
  // the hasTools logic available if the caller passes raw schemas.
  const systemPrompt = sessionConfig.systemPrompt;

  // ---- State ----------------------------------------------------------------
  const sessionAbort = new AbortController();
  let audioReady = false;
  let terminated = false;
  let sttSession: SttSession | null = null;
  let ttsSession: TtsSession | null = null;
  let turnController: AbortController | null = null;
  let nextReplyId = 0;
  // Conversation history — seeded from sessionConfig.history if provided.
  // Pipeline transport manages its own history since SessionCore doesn't own
  // the conversation in pipeline mode (history is needed to build the LLM
  // messages array for each turn).
  const conversationMessages: Message[] = sessionConfig.history ? [...sessionConfig.history] : [];
  let turnPromise: Promise<void> | null = null;
  const sttSubs: Unsubscribe[] = [];
  const ttsSubs: Unsubscribe[] = [];

  // ---- History helpers ------------------------------------------------------
  function pushMessages(...msgs: Message[]): void {
    conversationMessages.push(...msgs);
  }

  function chainTurn(p: Promise<void>): void {
    turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
  }

  // ---- Error helpers --------------------------------------------------------
  function emitError(code: ErrorCode, message: string): void {
    callbacks.onError(code, message);
  }

  // ---- Termination ----------------------------------------------------------
  /**
   * Tear down after an unrecoverable provider error. Aborts the in-flight
   * turn, cancels TTS, signals providers to close. Idempotent.
   */
  function terminate(): void {
    if (terminated) return;
    terminated = true;
    if (turnController !== null) {
      turnController.abort();
      turnController = null;
    }
    ttsSession?.cancel();
    callbacks.onCancelled();
    sessionAbort.abort();
  }

  // ---- STT event handlers ---------------------------------------------------
  function onSttPartial(_text: string): void {
    if (terminated) return;
    if (turnController === null) return;
    log.info("Pipeline barge-in", { sid: opts.sid });
    turnController.abort();
    turnController = null;
    ttsSession?.cancel();
    callbacks.onCancelled();
  }

  function onSttFinal(text: string): void {
    if (terminated) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // Replace in-flight turn if one is running (duplicate/late STT final).
    if (turnController !== null) {
      log.info("Pipeline replacing in-flight turn", { sid: opts.sid });
      turnController.abort();
      turnController = null;
      ttsSession?.cancel();
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

  // ---- TTS event handlers ---------------------------------------------------
  function onTtsError(err: TtsError): void {
    if (terminated) return;
    log.error("TTS error", { code: err.code, message: err.message, sid: opts.sid });
    emitError("tts", err.message);
    terminate();
  }

  // ---- LLM streaming --------------------------------------------------------
  async function consumeLlmStream(
    ctl: AbortController,
    messages: ModelMessage[],
    tools: ReturnType<typeof toVercelTools>,
    onDelta: (delta: string) => void,
  ): Promise<void> {
    try {
      const result = streamText({
        model: opts.llm,
        system: systemPrompt,
        messages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: ctl.signal,
      });
      for await (const part of result.fullStream) {
        if (ctl.signal.aborted) break;
        handleStreamPart(part, ctl, onDelta);
      }
    } catch (err: unknown) {
      if (!ctl.signal.aborted) {
        const msg = errorMessage(err);
        log.error("LLM streamText failed", { error: msg, sid: opts.sid });
        emitError("llm", msg);
      }
    }
  }

  function handleStreamPart(
    part: {
      readonly type: string;
      readonly text?: string;
      readonly input?: unknown;
      readonly output?: unknown;
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly error?: unknown;
    },
    _ctl: AbortController,
    onDelta: (delta: string) => void,
  ): void {
    switch (part.type) {
      case "text-delta": {
        const delta = part.text ?? "";
        if (delta.length === 0) return;
        onDelta(delta);
        ttsSession?.sendText(delta);
        return;
      }
      case "tool-call": {
        // Option A: fire callbacks.onToolCall for observability only.
        // Actual execution happens inline via toVercelTools.
        const input = (part.input ?? {}) as Record<string, unknown>;
        callbacks.onToolCall(part.toolCallId ?? "", part.toolName ?? "", input);
        return;
      }
      case "error": {
        const msg = errorMessage(part.error);
        log.error("LLM stream error", { message: msg, sid: opts.sid });
        emitError("llm", msg);
        return;
      }
      default:
        return;
    }
  }

  // ---- TTS flush ------------------------------------------------------------
  /**
   * Flush TTS and wait for drain. Resolves on:
   *   - TTS emits `done`
   *   - `signal` aborts (barge-in / provider error / session stop)
   *   - PIPELINE_FLUSH_TIMEOUT_MS elapses
   * Resolves immediately if no TTS session.
   */
  function flushTtsAndWait(signal: AbortSignal): Promise<void> {
    const tts = ttsSession;
    if (!tts) return Promise.resolve();
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
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      off = tts.on("done", finish);
      timer = setTimeout(() => {
        log.warn("TTS flush timeout", {
          sid: opts.sid,
          timeoutMs: PIPELINE_FLUSH_TIMEOUT_MS,
        });
        finish();
      }, PIPELINE_FLUSH_TIMEOUT_MS);
      tts.flush();
    });
  }

  // ---- Turn orchestration ---------------------------------------------------
  async function runTurn(userText: string): Promise<void> {
    const replyId = `pipeline-${++nextReplyId}`;
    callbacks.onReplyStarted(replyId);
    pushMessages({ role: "user", content: userText });

    const ctl = new AbortController();
    turnController = ctl;

    const tools = toVercelTools(toolSchemas, {
      executeTool,
      sessionId: opts.sid,
      messages: () => conversationMessages,
      signal: ctl.signal,
    });

    const messages: ModelMessage[] = conversationMessages.map(toModelMessage);
    let accumulated = "";
    await consumeLlmStream(ctl, messages, tools, (delta) => {
      accumulated += delta;
    });

    if (ctl.signal.aborted) {
      if (turnController === ctl) turnController = null;
      return;
    }

    // Emit the complete transcript once the LLM finishes streaming.
    if (accumulated.length > 0) {
      callbacks.onAgentTranscript(accumulated, false);
      pushMessages({ role: "assistant", content: accumulated });
    }

    await flushTtsAndWait(ctl.signal);

    if (ctl.signal.aborted) {
      if (turnController === ctl) turnController = null;
      return;
    }

    // Do NOT call callbacks.onAudioDone() here — session-core's flushReply
    // (triggered by onReplyDone) emits audioDone + replyDone together, matching
    // the S2S transport contract. Calling it here would double-fire audio_done.
    callbacks.onReplyDone();
    if (turnController === ctl) turnController = null;
  }

  async function runGreeting(text: string): Promise<void> {
    const replyId = `pipeline-greeting-${++nextReplyId}`;
    callbacks.onReplyStarted(replyId);

    const ctl = new AbortController();
    turnController = ctl;

    callbacks.onAgentTranscript(text, false);
    pushMessages({ role: "assistant", content: text });
    ttsSession?.sendText(text);

    await flushTtsAndWait(ctl.signal);

    if (ctl.signal.aborted) {
      if (turnController === ctl) turnController = null;
      return;
    }

    // Do NOT call callbacks.onAudioDone() here — session-core's flushReply
    // (triggered by onReplyDone) emits audioDone + replyDone together, matching
    // the S2S transport contract. Calling it here would double-fire audio_done.
    callbacks.onReplyDone();
    if (turnController === ctl) turnController = null;
  }

  // ---- Provider lifecycle ---------------------------------------------------
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
    // Note: `done` is NOT subscribed here. flushTtsAndWait() attaches a
    // one-shot listener per-turn so it knows when synthesis drains. Calling
    // callbacks.onAudioDone() is done explicitly at the end of runTurn /
    // runGreeting — not via a persistent subscription — to avoid double-firing.
    ttsSubs.push(session.on("error", onTtsError));
  }

  async function openProviders(): Promise<void> {
    const [sttResult, ttsResult] = await Promise.allSettled([
      opts.stt.open({
        sampleRate: sttSampleRate,
        apiKey: opts.providerKeys.stt,
        sttPrompt: opts.sttPrompt,
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

  // ---- Greeting on audio ready ----------------------------------------------
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

  // ---- Transport interface --------------------------------------------------
  return {
    async start(): Promise<void> {
      await openProviders();
      // In S2S mode, onSessionReady fires when the provider acknowledges the
      // session. In pipeline mode, we fire it immediately after providers open
      // (which is the equivalent "ready" signal), then trigger greeting.
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
      const offset = bytes.byteOffset;
      const length = bytes.byteLength;
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

    // Option A: tool execution stays inside toVercelTools/streamText.
    // sendToolResult is a no-op for pipeline mode.
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for pipeline mode
    sendToolResult(_callId: string, _result: string): void {},

    cancelReply(): void {
      if (terminated) return;
      turnController?.abort();
      turnController = null;
      ttsSession?.cancel();
      // Do NOT call callbacks.onCancelled() here. This method is invoked from
      // session-core.onCancel (client-initiated cancel), which calls
      // client.cancelled() itself — firing onCancelled here would double-cancel.
      // Barge-in (STT partial) fires callbacks.onCancelled() directly in
      // onSttPartial, where the cancel originates inside the transport.
    },
  };
}
