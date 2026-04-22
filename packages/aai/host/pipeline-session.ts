// Copyright 2025 the AAI authors. MIT license.
/**
 * Pipeline session — pluggable STT → LLM → TTS orchestrator.
 *
 * Alternative to the S2S session (see `session.ts`) that drives three separate
 * providers through a four-state machine:
 *
 *   IDLE ─── stt.partial ──────────────────► USER_SPEAKING
 *   USER_SPEAKING ── stt.final(text) ──────► AGENT_REPLYING  (launches runTurn)
 *   USER_SPEAKING ── stt.final("") ────────► IDLE            (empty utterance)
 *   AGENT_REPLYING ── stt.partial ────────► USER_SPEAKING   (barge-in: abort + cancel TTS)
 *   AGENT_REPLYING ── tts.done ──────────► IDLE             (reply complete)
 *
 * The runTurn() function pipes Vercel AI SDK `streamText()` output into the
 * TTS session: each `text-delta` part feeds `tts.sendText`; when the stream
 * ends naturally, `tts.flush()` drains and emits `done`.
 *
 * Barge-in aborts the LLM stream and calls `tts.cancel()` synchronously.
 *
 * Sample rate is fixed at 16000 for the first spec — plumbed as `opts.sampleRate`
 * so the router (Task 6) can thread it through from the client.
 */

import type { LanguageModel, ModelMessage } from "ai";
import { streamText } from "ai";
import type { AgentConfig, ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
import { DEFAULT_STT_SAMPLE_RATE } from "../sdk/constants.ts";
import type { ClientSink, SessionErrorCode } from "../sdk/protocol.ts";
import type {
  SttError,
  SttProvider,
  SttSession,
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

type PipelineState = "IDLE" | "USER_SPEAKING" | "AGENT_REPLYING";

/** Translate a plain message to the Vercel AI SDK `ModelMessage` shape. */
function toModelMessage(m: Message): ModelMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") return { role: "assistant", content: m.content };
  // The pipeline history never contains "tool" messages today (tool results
  // are folded into text), but keep this path for forward compatibility.
  return { role: "assistant", content: m.content };
}

function emitError(client: ClientSink, code: SessionErrorCode, message: string): void {
  client.event({ type: "error", code, message });
}

/** Shape of a single part we care about from `streamText`'s `fullStream`. */
type StreamPartHandlerDeps = {
  client: ClientSink;
  tts: TtsSession | null;
  log: Logger;
  sessionId: string;
  /** Appends delta text to the accumulated assistant reply and returns new length. */
  onTextDelta: (delta: string) => void;
};

/** Handle one part from `streamText().fullStream`. Pulled out for complexity budget. */
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
      // Ignore text-start / text-end / finish / etc.
      return;
  }
}

/**
 * Create a pluggable-provider voice session.
 *
 * Returns a {@link Session} that opens STT + TTS on `start()`, drives the
 * four-state machine from STT events, and pipes Vercel AI SDK LLM output
 * into the TTS session.
 */
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
  let state: PipelineState = "IDLE";
  let audioReady = false;
  let turnController: AbortController | null = null;
  let nextReplyId = 0;
  const sttSubs: Unsubscribe[] = [];
  const ttsSubs: Unsubscribe[] = [];

  // ─── State transitions ───────────────────────────────────────────────────

  function onSttPartial(_text: string): void {
    if (state === "IDLE") {
      state = "USER_SPEAKING";
      return;
    }
    if (state === "AGENT_REPLYING") {
      // Barge-in: abort the LLM turn and cancel TTS.
      log.info("Pipeline barge-in", { sessionId: opts.id });
      turnController?.abort();
      turnController = null;
      ctx.tts?.cancel();
      ctx.cancelReply();
      client.event({ type: "cancelled" });
      state = "USER_SPEAKING";
    }
  }

  function onSttFinal(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Empty utterance — drop and return to IDLE without starting a turn.
      state = "IDLE";
      return;
    }
    // User finished speaking with non-empty text — emit transcript, start reply.
    client.event({ type: "user_transcript", text });
    state = "AGENT_REPLYING";
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

  // ─── Per-turn LLM run ────────────────────────────────────────────────────

  /** Drive `streamText().fullStream`, feeding each part into {@link handleStreamPart}. */
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
      const result = streamText({
        model: opts.llm,
        system: systemPrompt,
        messages,
        tools,
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

  /** Flush TTS and wait for drain. Resolves immediately if no TTS session. */
  function flushTtsAndWait(): Promise<void> {
    const tts = ctx.tts;
    if (!tts) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const off = tts.on("done", () => {
        off();
        resolve();
      });
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
      // Barge-in already emitted `cancelled` and reset state; nothing else to do.
      if (turnController === ctl) turnController = null;
      return;
    }

    // Stream finished normally. Flush TTS and wait for drain.
    await flushTtsAndWait();

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
    state = "IDLE";
  }

  // ─── Session lifecycle ───────────────────────────────────────────────────

  async function openProviders(): Promise<void> {
    try {
      const sttSession: SttSession = await opts.stt.open({
        sampleRate,
        apiKey: opts.sttApiKey,
        sttPrompt: agentConfig.sttPrompt,
        signal: sessionAbort.signal,
      });
      if (sessionAbort.signal.aborted) {
        await sttSession.close();
        return;
      }
      ctx.stt = sttSession;
      sttSubs.push(sttSession.on("partial", onSttPartial));
      sttSubs.push(sttSession.on("final", onSttFinal));
      sttSubs.push(sttSession.on("error", onSttError));
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.error("STT open failed", { error: msg, sessionId: opts.id });
      emitError(client, "stt", msg);
      return;
    }

    try {
      const ttsSession: TtsSession = await opts.tts.open({
        sampleRate,
        apiKey: opts.ttsApiKey,
        signal: sessionAbort.signal,
      });
      if (sessionAbort.signal.aborted) {
        await ttsSession.close();
        return;
      }
      ctx.tts = ttsSession;
      ttsSubs.push(
        ttsSession.on("audio", (pcm) => {
          // Forward PCM16 to the client as Uint8Array (little-endian bytes).
          client.playAudioChunk(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        }),
      );
      ttsSubs.push(ttsSession.on("error", onTtsError));
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.error("TTS open failed", { error: msg, sessionId: opts.id });
      emitError(client, "tts", msg);
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
      // PCM16 little-endian — wrap the underlying buffer as Int16Array. Slice
      // first if byte alignment isn't 2-byte aligned (shouldn't happen in
      // practice but guards against odd-sized frames).
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
      ctx.tts?.cancel();
      ctx.cancelReply();
      client.event({ type: "cancelled" });
      state = "IDLE";
    },
    onReset(): void {
      turnController?.abort();
      ctx.tts?.cancel();
      ctx.cancelReply();
      ctx.conversationMessages = [];
      ctx.turnPromise = null;
      state = "IDLE";
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
