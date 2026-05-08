// Copyright 2026 the AAI authors. MIT license.
// Pipeline transport — STT → LLM → TTS orchestration behind the Transport interface.
//
// Pipeline mode executes tools inline via streamText's `tools.execute`.
// `callbacks.onToolCall` is observability-only; runtime.ts routes it to
// `client.toolCall` directly (bypassing SessionCore's tool-dispatch path,
// which is S2S-only). `sendToolResult` is a no-op because results are
// already handled by streamText.

import type { LanguageModel, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import type { ExecuteTool, ToolSchema } from "../../sdk/_internal-types.ts";
import {
  DEFAULT_MAX_HISTORY,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  MAX_TOOL_RESULT_CHARS,
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
  /** Tool selection policy passed to `streamText`. Defaults to `"auto"`. */
  toolChoice?: ToolChoice | undefined;
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
  const toolChoice = opts.toolChoice ?? "auto";
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
  // Pipeline transport manages its own history; SessionCore does not own the
  // conversation in pipeline mode (we need it to build LLM messages per turn).
  const conversationMessages: Message[] = sessionConfig.history ? [...sessionConfig.history] : [];
  let turnPromise: Promise<void> | null = null;
  const sttSubs: Unsubscribe[] = [];
  const ttsSubs: Unsubscribe[] = [];

  function pushMessages(...msgs: Message[]): void {
    conversationMessages.push(...msgs);
    if (conversationMessages.length > DEFAULT_MAX_HISTORY) {
      conversationMessages.splice(0, conversationMessages.length - DEFAULT_MAX_HISTORY);
    }
  }

  function chainTurn(p: Promise<void>): void {
    turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
  }

  function emitError(code: SessionErrorCode, message: string): void {
    callbacks.onError(code, message);
  }

  // Idempotent teardown after an unrecoverable provider error.
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
  ): Promise<void> {
    try {
      const result = streamText({
        model: opts.llm,
        system: systemPrompt,
        messages,
        tools,
        toolChoice,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: ctl.signal,
      });
      const handlePart = makeStreamPartHandler(onDelta);
      for await (const part of result.fullStream) {
        if (ctl.signal.aborted) break;
        handlePart(part);
      }
    } catch (err: unknown) {
      if (!ctl.signal.aborted) {
        const msg = errorMessage(err);
        log.error("LLM streamText failed", { error: msg, sid: opts.sid });
        emitError("llm", msg);
      }
    }
  }

  /**
   * Stateful per-turn handler for `streamText` `fullStream` parts.
   *
   * Tracks text-segment boundaries so that consecutive segments — which the
   * Vercel SDK emits across tool-call hops as `text-end` followed later by a
   * fresh `text-start` — don't fuse into "...up.Got it" when concatenated for
   * the transcript or streamed to TTS. When a boundary is crossed and neither
   * side carries whitespace, a single space is injected into both streams.
   */
  function makeStreamPartHandler(onDelta: (delta: string) => void) {
    let pendingSeparator = false;
    let lastChar = "";

    function emitText(delta: string): void {
      if (delta.length === 0) return;
      let out = delta;
      if (pendingSeparator) {
        pendingSeparator = false;
        const boundaryHasSpace = lastChar === "" || /\s/.test(lastChar) || /^\s/.test(out);
        if (!boundaryHasSpace) out = ` ${out}`;
      }
      lastChar = out.slice(-1);
      onDelta(out);
      ttsSession?.sendText(out);
    }

    function emitToolResult(part: {
      readonly toolCallId?: string;
      readonly output?: unknown;
    }): void {
      // Inline execution finished — surface completion so the client UI can
      // flip the tool-call from "pending" to "done". Schema requires a
      // string result capped at MAX_TOOL_RESULT_CHARS.
      const callId = part.toolCallId ?? "";
      if (!callId) return;
      const raw =
        (part as { output?: unknown; result?: unknown }).output ??
        (part as { result?: unknown }).result ??
        "";
      const str = typeof raw === "string" ? raw : JSON.stringify(raw);
      const truncated =
        str.length > MAX_TOOL_RESULT_CHARS ? str.slice(0, MAX_TOOL_RESULT_CHARS) : str;
      callbacks.onToolCallDone?.(callId, truncated);
    }

    return function handlePart(part: {
      readonly type: string;
      readonly text?: string;
      readonly input?: unknown;
      readonly output?: unknown;
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly error?: unknown;
    }): void {
      switch (part.type) {
        case "text-delta":
          emitText(part.text ?? "");
          return;
        case "text-end":
          pendingSeparator = true;
          return;
        case "tool-call": {
          // Observability only — actual execution happens inline via toVercelTools.
          const input = (part.input ?? {}) as Record<string, unknown>;
          callbacks.onToolCall(part.toolCallId ?? "", part.toolName ?? "", input);
          return;
        }
        case "tool-result":
          emitToolResult(part);
          return;
        case "error": {
          const msg = errorMessage(part.error);
          log.error("LLM stream error", { message: msg, sid: opts.sid });
          emitError("llm", msg);
          return;
        }
        default:
          return;
      }
    };
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

    // See runTurn: onReplyDone triggers session-core's flushReply which emits
    // audioDone + replyDone together; firing onAudioDone here would double-fire.
    callbacks.onReplyDone();
    if (turnController === ctl) turnController = null;
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
      turnController?.abort();
      turnController = null;
      ttsSession?.cancel();
      // Do NOT call callbacks.onCancelled() here — session-core.onCancel
      // (client-initiated) calls client.cancelled() itself. Barge-in fires
      // onCancelled directly in onSttPartial where the cancel originates here.
    },
  };
}
