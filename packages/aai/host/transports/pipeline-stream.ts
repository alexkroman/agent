// Copyright 2026 the AAI authors. MIT license.
// Streaming helpers for the pipeline transport — interprets the Vercel AI
// SDK `streamText` `fullStream` parts (text deltas, tool calls/results,
// errors) and fans them out to the transcript, TTS, and observability sinks,
// plus the per-turn TTS flush-wait and audio byte conversion.
//
// Split out of `pipeline-transport.ts` so that transport owns provider
// lifecycle/turn orchestration while this module owns the per-part and
// per-chunk mechanics.

import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type Tool,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import pTimeout from "p-timeout";
import {
  DEFAULT_DEAD_AIR_COVER_MS,
  PIPELINE_FLUSH_TIMEOUT_MS,
  PIPELINE_PLAYBACK_GRACE_MS,
  TTS_COALESCE_MAX_CHARS,
} from "../../sdk/constants.ts";

import type { TtsSession, Unsubscribe } from "../../sdk/providers.ts";
import type { Message, ToolChoice } from "../../sdk/types.ts";
import { errorMessage } from "../../sdk/utils.ts";
import type { Logger } from "../runtime-config.ts";
import { smoothTextStream } from "./pipeline-smooth.ts";
import {
  createStreamPartHandler,
  llmErrorDetails,
  type StreamPartHandler,
} from "./pipeline-stream-parts.ts";
import type { EmitError, TransportCallbacks } from "./types.ts";

/** Estimated client-side playback clock — see {@link createPlaybackClock}. */
export type PlaybackClock = {
  /** Advance the clock by one forwarded PCM16 chunk's duration. */
  onChunk(pcm: Int16Array): void;
  /** Restart the clock (the client just flushed its playback buffer). */
  reset(): void;
  /** True while the client may still be playing already-forwarded audio. */
  pending(): boolean;
  /**
   * Estimated ms of forwarded audio the client has not played yet. Ungraced —
   * unlike {@link pending} — because its consumer (the playback-tail resume
   * prompt) wants "where did the voice stop", not "could anything still be
   * audible".
   */
  remainingMs(): number;
};

/**
 * Track when the client is estimated to finish playing forwarded TTS audio.
 *
 * Synthesis outruns real-time playback, so a turn can finish server-side
 * while the client still holds many seconds of buffered audio; barge-in must
 * keep working through that window or "stop" lets the buffered speech play
 * out in full. Chunks queue client-side, so each forwarded chunk's duration
 * (PCM16 mono: one sample per Int16) accumulates from wherever the previous
 * chunk left off. `pending()` errs late by PIPELINE_PLAYBACK_GRACE_MS since
 * real playback starts after network latency + the client jitter buffer.
 */
export function createPlaybackClock(sampleRateHz: number): PlaybackClock {
  let endsAtMs = 0;
  return {
    onChunk(pcm) {
      const chunkMs = (pcm.length / sampleRateHz) * 1000;
      endsAtMs = Math.max(endsAtMs, Date.now()) + chunkMs;
    },
    reset() {
      endsAtMs = 0;
    },
    pending() {
      return Date.now() < endsAtMs + PIPELINE_PLAYBACK_GRACE_MS;
    },
    remainingMs() {
      return Math.max(0, endsAtMs - Date.now());
    },
  };
}

/** Convert an internal conversation {@link Message} to a Vercel AI {@link ModelMessage}. */
export function toModelMessage(m: Message): ModelMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  return { role: "assistant", content: m.content };
}

/**
 * Flush the TTS session and wait for its synthesis to drain. Resolves on TTS
 * `done`, signal abort, or PIPELINE_FLUSH_TIMEOUT_MS elapsed.
 *
 * `done` is anonymous, so this wait leans on the TtsEvents contract that it
 * never fires for a cancelled turn (see TtsEvents.done in sdk/providers.ts);
 * a provider leaking a stale one would end the next turn's reply early.
 */
export async function flushTtsAndWait(args: {
  tts: TtsSession | null;
  signal: AbortSignal;
  log: Logger;
  sid: string;
  emitError: EmitError;
}): Promise<void> {
  const { tts, signal, log, sid, emitError } = args;
  if (!tts) return;
  if (signal.aborted) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const off: Unsubscribe = tts.on("done", () => resolve());
  tts.flush();
  try {
    await pTimeout(promise, { milliseconds: PIPELINE_FLUSH_TIMEOUT_MS, signal });
  } catch {
    // Abort resolves silently (barge-in); only a real drain timeout reports.
    if (signal.aborted) return;
    log.warn("TTS flush timeout", { sid, timeoutMs: PIPELINE_FLUSH_TIMEOUT_MS });
    // The caller hears this: the provider stopped mid-utterance, so the reply
    // is audibly clipped and then silent for the whole timeout. Reaching the
    // client (and the error log) as a `tts` error is the only trace — without
    // it a truncated turn is indistinguishable from a short one, in a session
    // that otherwise reports itself healthy.
    // NON-fatal: the reply is clipped, the session is not over — the lines below
    // resynchronize the turn and the conversation continues. Reported as fatal,
    // this cost the user their microphone for a truncated sentence.
    emitError("tts", "Speech synthesis did not finish; the reply may be cut short.", {
      fatal: false,
    });
    // Abandon the turn on the PROVIDER too, not just here. The session's turn
    // accounting still has this turn in flight with acknowledgements
    // outstanding, and `onTurnText` deliberately does not reset a turn it
    // believes is live — so every later turn on this session inherits the
    // desynchronized count. `cancel()` is the existing resynchronization
    // path (it clears the turn state and recycles the socket); text sent for
    // the next turn is queued onto the replacement.
    tts.cancel();
  } finally {
    off();
  }
}

/** Batches word-granularity text into fewer TTS sends — see {@link createTtsTextCoalescer}. */
export type TtsTextCoalescer = {
  /** Buffer a text delta, forwarding coalesced chunks as boundaries are hit. */
  send(text: string): void;
  /** Forward any buffered text. Call before the provider-level TTS flush. */
  flush(): void;
  /**
   * A speech segment ended (`text-end` / a tool call is about to run). Forwards
   * whatever is buffered and re-arms the immediate-first-chunk allowance.
   *
   * Batching may only defer text that more text is still coming for. Holding a
   * sub-threshold fragment ("let me") across a tool call would strand it for the
   * whole execution window — the caller hears the words before it, then dead
   * air, with only the dead-air cover (a whole {@link DEFAULT_DEAD_AIR_COVER_MS}
   * later) to break it. Re-arming also keeps the post-tool reply's first words
   * immediate, since that gap is exactly when time-to-first-audio matters again.
   */
  boundary(): void;
};

/**
 * Trailing clause boundary — punctuation (optionally inside closing
 * quotes/brackets) at the end of the buffered text. Word-granularity chunks
 * carry their trailing whitespace ("Sure, "), so allow it after the mark.
 */
const CLAUSE_BOUNDARY_RE = /[.,;:!?…]["')\]]*\s*$/;

/**
 * Coalesce word-granularity LLM text into fewer, larger TTS provider sends.
 *
 * The smooth-stream transform (pipeline-smooth.ts) chunks LLM text to whole
 * words for pacing; forwarding each word to the TTS provider costs one wire
 * message (plus per-send request overhead) per word. The transcript path is
 * unaffected — this only batches what reaches `sendText`.
 *
 * The first chunk is forwarded immediately (preserves time-to-first-byte);
 * subsequent text batches until a clause/punctuation boundary or
 * {@link TTS_COALESCE_MAX_CHARS} characters accumulate. Callers must
 * `flush()` when the stream ends so a trailing fragment is still spoken.
 */
export function createTtsTextCoalescer(sendRaw: (text: string) => void): TtsTextCoalescer {
  let pending = "";
  let firstSent = false;
  const flush = (): void => {
    if (pending.length === 0) return;
    const out = pending;
    pending = "";
    sendRaw(out);
  };
  return {
    send(text: string): void {
      if (text.length === 0) return;
      if (!firstSent) {
        firstSent = true;
        sendRaw(text);
        return;
      }
      pending += text;
      if (pending.length >= TTS_COALESCE_MAX_CHARS || CLAUSE_BOUNDARY_RE.test(pending)) flush();
    },
    flush,
    boundary(): void {
      flush();
      firstSent = false;
    },
  };
}

/** Parameters for {@link consumeLlmStream}, threading session state explicitly. */
export interface ConsumeLlmStreamParams {
  /** LLM provider (Vercel AI SDK LanguageModel). */
  llm: LanguageModel;
  /** System prompt for the turn. */
  systemPrompt: string;
  /** Conversation history in Vercel AI SDK ModelMessage form. */
  messages: ModelMessage[];
  /** Tool set bound to the transport's executeTool. */
  tools: Record<string, Tool>;
  /** Tool selection policy passed to `streamText`. */
  toolChoice: ToolChoice;
  /** LLM sampling temperature; omitted entirely from streamText when unset. */
  temperature: number | undefined;
  /** Repairs malformed tool-call arguments by re-asking the model. */
  repairToolCall: ToolCallRepairFunction<ToolSet>;
  /** Max LLM tool-call steps for this turn. */
  maxSteps: number;
  /** Forwards text to the active TTS session (no-op if none). */
  sendTtsText: (text: string) => void;
  /** Filler spoken before a silent turn's first tool call — see {@link StreamPartHandlerDeps}. */
  holdPhrase?: string | undefined;
  /** Is the caller speaking right now? Suppresses filler — see StreamPartHandlerDeps. */
  callerSpeaking?: (() => boolean) | undefined;
  /** Tool-call/tool-result observability hooks, forwarded to SessionCore. */
  callbacks: Pick<TransportCallbacks, "onToolCall" | "onToolCallDone">;
  /** Report an LLM-stream error. */
  emitError: EmitError;
  log: Logger;
  sid: string;
  /** The turn's abort signal (turn cancellation / barge-in / session end). */
  signal: AbortSignal;
  /** Receives each assistant text delta (accumulated into the transcript). */
  onDelta: (delta: string) => void;
  /**
   * Fires after each completed LLM step, once that step's response messages
   * are safe in the collected history. The transport uses it to snapshot how
   * much of the accumulated transcript is already persisted, so an aborted
   * turn's `[interrupted]` marker carries only the unpersisted tail.
   */
  onStepPersisted?: (() => void) | undefined;
}

/** Outcome of one {@link consumeLlmStream} turn. */
export interface LlmStreamResult {
  /**
   * Response messages of every step that COMPLETED, for history.
   *
   * On abort or stream error this holds the steps finished before the
   * interruption (tool calls with their results) — never `undefined` — so
   * barge-in does not erase work already done: the next turn's LLM still sees
   * which tools ran and what they returned. An in-flight step is dropped whole
   * (no dangling tool call without its result).
   */
  messages: ModelMessage[];
  /**
   * The stream errored out rather than completing or being aborted.
   *
   * The caller needs this to speak a recovery phrase: a failed turn usually
   * produces no text at all, so nothing reaches TTS and the caller hears
   * silence. An empty `messages` array cannot express it — a successful turn
   * that produced no tool steps looks identical. A deliberate barge-in is NOT
   * a failure; it has its own recovery path.
   */
  failed: boolean;
}

/**
 * Run one `streamText` turn against the LLM, fan its stream parts out via
 * {@link createStreamPartHandler}, and return the accumulated response
 * messages plus whether the stream failed.
 */
export async function consumeLlmStream(params: ConsumeLlmStreamParams): Promise<LlmStreamResult> {
  const {
    llm,
    systemPrompt,
    messages,
    tools,
    toolChoice,
    temperature,
    repairToolCall,
    maxSteps,
    sendTtsText,
    holdPhrase,
    callerSpeaking,
    callbacks,
    emitError,
    log,
    sid,
    signal,
    onDelta,
    onStepPersisted,
  } = params;
  // Response messages of completed steps, collected incrementally so an
  // aborted turn still returns everything that finished before the abort.
  const collected: ModelMessage[] = [];
  // Batch word-granularity deltas into fewer TTS provider sends; the
  // transcript path (onDelta) keeps full delta granularity.
  const ttsText = createTtsTextCoalescer(sendTtsText);
  let handler: StreamPartHandler | undefined;
  try {
    const result = streamText({
      model: llm,
      system: systemPrompt,
      messages,
      tools,
      toolChoice,
      // Temperature only when set — Claude 5 ignores it and warns.
      ...(temperature !== undefined ? { temperature } : {}),
      // Word-coalesce text for TTS, keeping thinking signatures (see pipeline-smooth.ts).
      experimental_transform: smoothTextStream(),
      experimental_repairToolCall: repairToolCall,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: signal,
      onStepFinish: (step) => {
        collected.push(...step.response.messages);
        onStepPersisted?.();
      },
      // Every `error` part is delivered to `onError` and to `fullStream`
      // alike, so the handler below is what reports the failure — at error
      // level, with its HTTP diagnostics (see `llmErrorDetails`). Claiming
      // this callback is still mandatory: the SDK's default is
      // `console.error(error)`, which spends ~100 log lines on the same
      // event (three nested stack traces plus the entire request body, one
      // console depth level away from the conversation itself). On a host
      // with a bounded log buffer that evicts every other line — which is
      // how a gateway 500 became the only thing visible in production logs.
      onError: ({ error }) => {
        log.debug("streamText onError", { error: errorMessage(error), sid });
      },
    });
    // `result.steps` settles after the stream; the abort/error paths below
    // return without awaiting it, so observe rejections up front — an
    // AbortError landing later must not become an unhandled rejection. The
    // happy path's `await result.steps` still sees the original settlement.
    void Promise.resolve(result.steps).catch(() => undefined);
    handler = createStreamPartHandler({
      onDelta,
      sendTtsText: ttsText.send,
      onTtsBoundary: ttsText.boundary,
      holdPhrase,
      // Lets the dead-air cover die with the turn: a barge-in during a tool
      // execution parks the fullStream read, deferring dispose() below.
      signal,
      callerSpeaking,
      onToolCall: callbacks.onToolCall,
      onToolCallDone: callbacks.onToolCallDone,
      emitError,
      log,
      sid,
    });
    for await (const part of result.fullStream) {
      if (signal.aborted) break;
      handler.handle(part);
    }
    // The model is done: no filler may fire during the flush or the wait for
    // `result.steps` below, both of which follow the last stream part.
    handler.dispose();
    // Aborted turns skip the flush — TTS is being cancelled anyway.
    if (signal.aborted) return { messages: collected, failed: false };
    ttsText.flush();
    // Gather every step's response messages (assistant tool-call + `tool`
    // result + text) so tool context carries into the next turn. Top-level
    // `result.response.messages` is final-step only and drops the tool call.
    // Preferred over `collected` on the happy path in case a final step
    // resolves after the stream ends but before its onStepFinish fires.
    const steps = await result.steps;
    return {
      messages: steps.flatMap((step) => step.response.messages),
      // A stream can end without throwing having emitted nothing but an `error`
      // part, which is still a turn the caller never heard a reply to.
      failed: handler.errored(),
    };
  } catch (err: unknown) {
    // A barge-in is not a failure — it has its own recovery path, and an
    // apology on top of a deliberate interruption would be wrong.
    if (signal.aborted) return { messages: collected, failed: false };
    // Flush buffered TTS text so speech matches the transcript already
    // accumulated via onDelta for the pre-error portion of the turn.
    ttsText.flush();
    const msg = errorMessage(err);
    log.error("LLM streamText failed", { error: msg, sid, ...llmErrorDetails(err) });
    // NON-fatal: this turn is over, the session is not. The caller returns
    // `failed: true`, which speaks `errorPhrase` — "Sorry, I had a problem just
    // then. Could you say that again?" — so reporting the session dead here asked
    // the user to repeat themselves into a released microphone.
    emitError("llm", msg, { fatal: false });
    return { messages: collected, failed: true };
  } finally {
    // The turn is over on every path (completed, aborted, errored) — no
    // dead-air filler may fire into the silence that follows it.
    handler?.dispose();
  }
}
