// Copyright 2025 the AAI authors. MIT license.
/**
 * Pipeline session — pluggable STT → LLM → TTS orchestrator.
 *
 * Alternative to the S2S session (see `session.ts`) that drives three
 * independent providers. A new partial STT event while the agent is replying
 * triggers barge-in (aborts the LLM stream and cancels TTS).
 */

import type { LanguageModel, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import type { AgentConfig, ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
import { DEFAULT_STT_SAMPLE_RATE, PIPELINE_FLUSH_TIMEOUT_MS } from "../sdk/constants.ts";
import type { ClientSink, SessionErrorCode } from "../sdk/protocol.ts";
import type {
  SttError,
  SttProvider,
  TtsError,
  TtsProvider,
  TtsSession,
  Unsubscribe,
} from "../sdk/providers.ts";
import { buildSystemPrompt } from "../sdk/system-prompt.ts";
import type { Message } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { buildPipelineCtx, type PipelineSessionCtx } from "./pipeline-session-ctx.ts";
import { consoleLogger, type Logger } from "./runtime-config.ts";
import type { Session } from "./session.ts";
import { toVercelTools } from "./to-vercel-tools.ts";

/** Configuration options for {@link createPipelineSession}. */
export interface PipelineSessionOptions {
  /** Unique session identifier. */
  id: string;
  /** Agent slug. */
  agent: string;
  /** Sink for wire events + audio back to the browser client. */
  client: ClientSink;
  /** Serializable agent config (name, system prompt, maxSteps, etc.). */
  agentConfig: AgentConfig;
  /** JSON Schema definitions for the agent's tools. */
  toolSchemas: readonly ToolSchema[];
  /** Optional natural-language guidance appended to the system prompt. */
  toolGuidance?: readonly string[] | undefined;
  /** Function to invoke tools by name. */
  executeTool: ExecuteTool;
  /** STT provider (injected via manifest in pipeline mode). */
  stt: SttProvider;
  /** LLM provider (Vercel AI SDK `LanguageModel`). */
  llm: LanguageModel;
  /** TTS provider (injected via manifest in pipeline mode). */
  tts: TtsProvider;
  /** STT API key. */
  sttApiKey: string;
  /** TTS API key. */
  ttsApiKey: string;
  /** Audio sample rate (PCM16, Hz). Defaults to {@link DEFAULT_STT_SAMPLE_RATE}. */
  sampleRate?: number | undefined;
  /** Logger. Defaults to the console logger. */
  logger?: Logger | undefined;
  /** Sliding-window conversation history size. */
  maxHistory?: number | undefined;
}

function toModelMessage(m: Message): ModelMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") return { role: "assistant", content: m.content };
  return { role: "assistant", content: m.content };
}

function emitError(client: ClientSink, code: SessionErrorCode, message: string): void {
  client.event({ type: "error", code, message });
}

type StreamPartHandlerDeps = {
  client: ClientSink;
  tts: TtsSession | null;
  log: Logger;
  sessionId: string;
  onTextDelta: (delta: string) => void;
};

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
  deps: StreamPartHandlerDeps,
): void {
  switch (part.type) {
    case "text-delta": {
      const delta = part.text ?? "";
      if (delta.length === 0) return;
      deps.onTextDelta(delta);
      deps.tts?.sendText(delta);
      deps.client.event({ type: "agent_transcript", text: delta });
      return;
    }
    case "tool-call": {
      const input = (part.input ?? {}) as Readonly<Record<string, unknown>>;
      deps.client.event({
        type: "tool_call",
        toolCallId: part.toolCallId ?? "",
        toolName: part.toolName ?? "",
        args: input,
      });
      return;
    }
    case "tool-result": {
      const output = part.output;
      const resultString = typeof output === "string" ? output : JSON.stringify(output);
      deps.client.event({
        type: "tool_call_done",
        toolCallId: part.toolCallId ?? "",
        result: resultString,
      });
      return;
    }
    case "error": {
      const msg = errorMessage(part.error);
      deps.log.error("LLM stream error", { message: msg, sessionId: deps.sessionId });
      emitError(deps.client, "llm", msg);
      return;
    }
    default:
      return;
  }
}

/** Create a pluggable-provider voice session. */
export function createPipelineSession(opts: PipelineSessionOptions): Session {
  const log = opts.logger ?? consoleLogger;
  const sampleRate = opts.sampleRate ?? DEFAULT_STT_SAMPLE_RATE;
  const { client, agentConfig, toolSchemas, executeTool } = opts;

  const hasTools = toolSchemas.length > 0 || (agentConfig.builtinTools?.length ?? 0) > 0;
  const systemPrompt = buildSystemPrompt(agentConfig, {
    hasTools,
    voice: true,
    toolGuidance: opts.toolGuidance,
  });

  const ctx: PipelineSessionCtx = buildPipelineCtx({
    id: opts.id,
    agent: opts.agent,
    client,
    agentConfig,
    executeTool,
    log,
    maxHistory: opts.maxHistory,
  });

  const sessionAbort = new AbortController();
  let audioReady = false;
  let turnController: AbortController | null = null;
  let nextReplyId = 0;
  const sttSubs: Unsubscribe[] = [];
  const ttsSubs: Unsubscribe[] = [];

  function onSttPartial(_text: string): void {
    if (turnController === null) return;
    log.info("Pipeline barge-in", { sessionId: opts.id });
    turnController.abort();
    turnController = null;
    ctx.tts?.cancel();
    ctx.cancelReply();
    client.event({ type: "cancelled" });
  }

  function onSttFinal(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    client.event({ type: "user_transcript", text });
    const turn = runTurn(trimmed).catch((err: unknown) => {
      log.error("Pipeline turn crashed", { error: errorMessage(err), sessionId: opts.id });
    });
    ctx.chainTurn(turn);
  }

  function onSttError(err: SttError): void {
    log.error("STT error", { code: err.code, message: err.message, sessionId: opts.id });
    emitError(client, "stt", err.message);
  }

  function onTtsError(err: TtsError): void {
    log.error("TTS error", { code: err.code, message: err.message, sessionId: opts.id });
    emitError(client, "tts", err.message);
  }

  async function consumeLlmStream(
    ctl: AbortController,
    messages: ModelMessage[],
    tools: ReturnType<typeof toVercelTools>,
    onDelta: (delta: string) => void,
  ): Promise<void> {
    const deps: StreamPartHandlerDeps = {
      client,
      tts: ctx.tts,
      log,
      sessionId: opts.id,
      onTextDelta: onDelta,
    };
    try {
      // Vercel AI SDK v6 defaults to a single step — without `stopWhen`, the
      // stream terminates after the first tool result and the agent can't
      // follow up on its own tool calls.
      const maxSteps = agentConfig.maxSteps ?? 5;
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
        handleStreamPart(part, deps);
      }
    } catch (err: unknown) {
      if (!ctl.signal.aborted) {
        const msg = errorMessage(err);
        log.error("LLM streamText failed", { error: msg, sessionId: opts.id });
        emitError(client, "llm", msg);
      }
    }
  }

  /**
   * Flush TTS and wait for drain. Resolves on any of:
   *   - TTS emits `done`
   *   - `signal` aborts (barge-in, provider error, session stop)
   *   - `PIPELINE_FLUSH_TIMEOUT_MS` elapses
   * Resolves immediately if no TTS session.
   */
  function flushTtsAndWait(signal: AbortSignal): Promise<void> {
    const tts = ctx.tts;
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
          sessionId: opts.id,
          timeoutMs: PIPELINE_FLUSH_TIMEOUT_MS,
        });
        finish();
      }, PIPELINE_FLUSH_TIMEOUT_MS);
      tts.flush();
    });
  }

  async function runTurn(userText: string): Promise<void> {
    const replyId = `pipeline-${++nextReplyId}`;
    ctx.beginReply(replyId);
    ctx.pushMessages({ role: "user", content: userText });

    const ctl = new AbortController();
    turnController = ctl;

    const tools = toVercelTools(toolSchemas, {
      executeTool,
      sessionId: opts.id,
      messages: () => ctx.conversationMessages,
      signal: ctl.signal,
    });

    const messages: ModelMessage[] = ctx.conversationMessages.map(toModelMessage);
    let accumulated = "";
    await consumeLlmStream(ctl, messages, tools, (delta) => {
      accumulated += delta;
    });

    if (ctl.signal.aborted) {
      if (turnController === ctl) turnController = null;
      return;
    }

    await flushTtsAndWait(ctl.signal);

    if (ctl.signal.aborted) {
      if (turnController === ctl) turnController = null;
      return;
    }

    if (accumulated.length > 0) {
      ctx.pushMessages({ role: "assistant", content: accumulated });
    }
    client.playAudioDone();
    client.event({ type: "reply_done" });
    if (turnController === ctl) turnController = null;
  }

  async function openProviders(): Promise<void> {
    const [sttResult, ttsResult] = await Promise.allSettled([
      opts.stt.open({
        sampleRate,
        apiKey: opts.sttApiKey,
        sttPrompt: agentConfig.sttPrompt,
        signal: sessionAbort.signal,
      }),
      opts.tts.open({
        sampleRate,
        apiKey: opts.ttsApiKey,
        signal: sessionAbort.signal,
      }),
    ]);

    if (sttResult.status === "rejected") {
      const msg = errorMessage(sttResult.reason);
      log.error("STT open failed", { error: msg, sessionId: opts.id });
      emitError(client, "stt", msg);
    }
    if (ttsResult.status === "rejected") {
      const msg = errorMessage(ttsResult.reason);
      log.error("TTS open failed", { error: msg, sessionId: opts.id });
      emitError(client, "tts", msg);
    }

    const aborted = sessionAbort.signal.aborted;
    const sttFailed = sttResult.status === "rejected";
    const ttsFailed = ttsResult.status === "rejected";
    const teardown = aborted || sttFailed || ttsFailed;

    if (sttResult.status === "fulfilled") {
      const sttSession = sttResult.value;
      if (teardown) {
        await sttSession.close().catch(() => undefined);
      } else {
        ctx.stt = sttSession;
        sttSubs.push(sttSession.on("partial", onSttPartial));
        sttSubs.push(sttSession.on("final", onSttFinal));
        sttSubs.push(sttSession.on("error", onSttError));
      }
    }
    if (ttsResult.status === "fulfilled") {
      const ttsSession = ttsResult.value;
      if (teardown) {
        await ttsSession.close().catch(() => undefined);
      } else {
        ctx.tts = ttsSession;
        ttsSubs.push(
          ttsSession.on("audio", (pcm) => {
            client.playAudioChunk(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          }),
        );
        ttsSubs.push(ttsSession.on("error", onTtsError));
      }
    }
  }

  return {
    async start(): Promise<void> {
      await openProviders();
    },
    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      turnController?.abort();
      for (const off of sttSubs) off();
      for (const off of ttsSubs) off();
      sttSubs.length = 0;
      ttsSubs.length = 0;
      if (ctx.turnPromise !== null) await ctx.turnPromise;
      await ctx.stt?.close().catch(() => {
        /* already closed */
      });
      await ctx.tts?.close().catch(() => {
        /* already closed */
      });
    },
    onAudio(data: Uint8Array): void {
      if (!audioReady) return;
      const offset = data.byteOffset;
      const length = data.byteLength;
      let pcm: Int16Array;
      if (offset % 2 === 0 && length % 2 === 0) {
        pcm = new Int16Array(data.buffer, offset, length / 2);
      } else {
        const copy = new Uint8Array(length - (length % 2));
        copy.set(data.subarray(0, copy.byteLength));
        pcm = new Int16Array(copy.buffer);
      }
      ctx.stt?.sendAudio(pcm);
    },
    onAudioReady(): void {
      audioReady = true;
    },
    onCancel(): void {
      turnController?.abort();
      turnController = null;
      ctx.tts?.cancel();
      ctx.cancelReply();
      client.event({ type: "cancelled" });
    },
    onReset(): void {
      turnController?.abort();
      turnController = null;
      ctx.tts?.cancel();
      ctx.cancelReply();
      ctx.conversationMessages = [];
      ctx.turnPromise = null;
      client.event({ type: "reset" });
    },
    onHistory(incoming: readonly { role: "user" | "assistant"; content: string }[]): void {
      ctx.pushMessages(...incoming.map((m) => ({ role: m.role, content: m.content })));
    },
    waitForTurn(): Promise<void> {
      return ctx.turnPromise ?? Promise.resolve();
    },
  };
}
