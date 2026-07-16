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
import { PIPELINE_FLUSH_TIMEOUT_MS, PIPELINE_PLAYBACK_GRACE_MS } from "../../sdk/constants.ts";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { TtsSession, Unsubscribe } from "../../sdk/providers.ts";
import type { Message, ToolChoice } from "../../sdk/types.ts";
import { capToolResult, errorMessage } from "../../sdk/utils.ts";
import type { Logger } from "../runtime-config.ts";
import { smoothTextStream } from "./pipeline-smooth.ts";
import type { TransportCallbacks } from "./types.ts";

/** Estimated client-side playback clock — see {@link createPlaybackClock}. */
export type PlaybackClock = {
  /** Advance the clock by one forwarded PCM16 chunk's duration. */
  onChunk(pcm: Int16Array): void;
  /** Restart the clock (the client just flushed its playback buffer). */
  reset(): void;
  /** True while the client may still be playing already-forwarded audio. */
  pending(): boolean;
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
  };
}

/** Convert an internal conversation {@link Message} to a Vercel AI {@link ModelMessage}. */
export function toModelMessage(m: Message): ModelMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  return { role: "assistant", content: m.content };
}

/** Count whitespace-delimited words in an interim transcript. */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Trailing tokens that signal the speaker is mid-thought and more speech is
 * coming — fillers, dangling connectives, articles, and prepositions. A final
 * ending in one of these is treated as incomplete even if it carries terminal
 * punctuation, so the endpoint settle window aggregates the continuation.
 */
const CONTINUATION_CUES: ReadonlySet<string> = new Set([
  "um",
  "umm",
  "uh",
  "uhh",
  "er",
  "erm",
  "hmm",
  "mm",
  "so",
  "and",
  "but",
  "or",
  "then",
  "because",
  "cause",
  "actually",
  "wait",
  "no",
  "well",
  "like",
  "the",
  "a",
  "an",
  "to",
  "for",
  "with",
  "of",
  "my",
  "at",
  "in",
  "on",
  "i",
  "i'm",
  "let",
  "let's",
]);

/**
 * Heuristic: does an STT final read as a complete utterance (commit now) versus
 * a fragment likely to be continued (wait for the settle window)?
 *
 * Complete = ends with terminal punctuation and its last word is not a
 * continuation cue. STT emits punctuation on confident end-of-turn finals; a
 * mid-utterance pause fragment ("find a two-bedroom in Austin") usually lacks
 * it, and self-corrections trail off on a cue ("actually make it"). Errs toward
 * waiting (the safe, aggregating side) when unsure.
 */
export function utteranceLooksComplete(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const words = trimmed.toLowerCase().match(/[a-z']+/g);
  const lastWord = words?.at(-1) ?? "";
  if (CONTINUATION_CUES.has(lastWord)) return false;
  return /[.?!]["')\]]*$/.test(trimmed);
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
}): Promise<void> {
  const { tts, signal, log, sid } = args;
  if (!tts) return;
  if (signal.aborted) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const off: Unsubscribe = tts.on("done", () => resolve());
  tts.flush();
  try {
    await pTimeout(promise, { milliseconds: PIPELINE_FLUSH_TIMEOUT_MS, signal });
  } catch {
    // Abort resolves silently (barge-in); only a real drain timeout warns.
    if (!signal.aborted) {
      log.warn("TTS flush timeout", { sid, timeoutMs: PIPELINE_FLUSH_TIMEOUT_MS });
    }
  } finally {
    off();
  }
}

/** A single `fullStream` part from `streamText`. */
export type StreamPart = {
  readonly type: string;
  readonly text?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly error?: unknown;
};

/** Dependencies the stream-part handler needs from the owning transport. */
type StreamPartHandlerDeps = {
  /** Receives each assistant text delta (accumulated into the transcript). */
  onDelta: (delta: string) => void;
  /** Forwards text to the active TTS session (no-op if none). */
  sendTtsText: (text: string) => void;
  /** Observability-only tool-call notification. */
  onToolCall: (callId: string, name: string, args: Record<string, unknown>) => void;
  /** Tool-result completion, so the client UI can flip pending → done. */
  onToolCallDone?: ((callId: string, result: string) => void) | undefined;
  /** Report an LLM-stream error. */
  emitError: (code: SessionErrorCode, message: string) => void;
  /**
   * Spoken when the model's first action in a turn is a tool call with no
   * preceding text — guarantees the caller hears something instead of dead
   * air while the tool runs, even if the model skips the prompt's preamble.
   * Defaults to {@link DEFAULT_HOLD_PHRASE}; set `""` to disable.
   */
  holdPhrase?: string | undefined;
  log: Logger;
  sid: string;
};

/** Default filler spoken before a silent turn's first tool call. */
export const DEFAULT_HOLD_PHRASE = "One moment.";

/**
 * Stateful per-turn handler for `streamText` `fullStream` parts.
 *
 * Tracks text-segment boundaries so that consecutive segments — which the
 * Vercel SDK emits across tool-call hops as `text-end` followed later by a
 * fresh `text-start` — don't fuse into "...up.Got it" when concatenated for
 * the transcript or streamed to TTS. When a boundary is crossed and neither
 * side carries whitespace, a single space is injected into both streams.
 */
export function createStreamPartHandler(deps: StreamPartHandlerDeps): (part: StreamPart) => void {
  const { onDelta, sendTtsText, onToolCall, onToolCallDone, emitError, log, sid } = deps;
  const holdPhrase = deps.holdPhrase ?? DEFAULT_HOLD_PHRASE;
  let pendingSeparator = false;
  let lastChar = "";
  // Track whether the model has spoken any text this turn, and whether we've
  // already injected the hold phrase — so it fires at most once, only when the
  // turn opens with a tool call and no speech.
  let spokeText = false;
  let holdEmitted = false;

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
    sendTtsText(out);
  }

  function emitToolResult(part: StreamPart): void {
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
    onToolCallDone?.(callId, capToolResult(str));
  }

  return function handlePart(part: StreamPart): void {
    switch (part.type) {
      case "text-delta": {
        const t = part.text ?? "";
        if (t.length > 0) spokeText = true;
        emitText(t);
        return;
      }
      case "text-end":
        pendingSeparator = true;
        return;
      case "tool-call": {
        // Guarantee the caller hears a hold phrase if the model jumps straight
        // to a tool call without speaking. Fire once per turn; separate it from
        // the model's later reply so they don't fuse.
        if (!(spokeText || holdEmitted) && holdPhrase.length > 0) {
          holdEmitted = true;
          emitText(holdPhrase);
          pendingSeparator = true;
        }
        // Observability only — actual execution happens inline via toVercelTools.
        const input = (part.input ?? {}) as Record<string, unknown>;
        onToolCall(part.toolCallId ?? "", part.toolName ?? "", input);
        return;
      }
      case "tool-result":
        emitToolResult(part);
        return;
      case "error": {
        const msg = errorMessage(part.error);
        log.error("LLM stream error", { message: msg, sid });
        emitError("llm", msg);
        return;
      }
      default:
        return;
    }
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
  /** Tool-call/tool-result observability hooks, forwarded to SessionCore. */
  callbacks: Pick<TransportCallbacks, "onToolCall" | "onToolCallDone">;
  /** Report an LLM-stream error. */
  emitError: (code: SessionErrorCode, message: string) => void;
  log: Logger;
  sid: string;
  /** Aborts the LLM stream (turn cancellation / barge-in). */
  ctl: AbortController;
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

/**
 * Run one `streamText` turn against the LLM, fan its stream parts out via
 * {@link createStreamPartHandler}, and return the accumulated response
 * messages (for history) once the stream completes.
 *
 * On abort or stream error, returns the response messages of every step that
 * COMPLETED before the interruption (tool calls with their results) — never
 * `undefined` — so barge-in does not erase work already done: the next turn's
 * LLM still sees which tools ran and what they returned. An in-flight step is
 * dropped whole (no dangling tool call without its result).
 */
export async function consumeLlmStream(params: ConsumeLlmStreamParams): Promise<ModelMessage[]> {
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
    callbacks,
    emitError,
    log,
    sid,
    ctl,
    onDelta,
    onStepPersisted,
  } = params;
  // Response messages of completed steps, collected incrementally so an
  // aborted turn still returns everything that finished before the abort.
  const collected: ModelMessage[] = [];
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
      abortSignal: ctl.signal,
      onStepFinish: (step) => {
        collected.push(...step.response.messages);
        onStepPersisted?.();
      },
    });
    const handlePart = createStreamPartHandler({
      onDelta,
      sendTtsText,
      holdPhrase,
      onToolCall: callbacks.onToolCall,
      onToolCallDone: callbacks.onToolCallDone,
      emitError,
      log,
      sid,
    });
    for await (const part of result.fullStream) {
      if (ctl.signal.aborted) break;
      handlePart(part);
    }
    if (ctl.signal.aborted) return collected;
    // Gather every step's response messages (assistant tool-call + `tool`
    // result + text) so tool context carries into the next turn. Top-level
    // `result.response.messages` is final-step only and drops the tool call.
    // Preferred over `collected` on the happy path in case a final step
    // resolves after the stream ends but before its onStepFinish fires.
    const steps = await result.steps;
    return steps.flatMap((step) => step.response.messages);
  } catch (err: unknown) {
    if (!ctl.signal.aborted) {
      const msg = errorMessage(err);
      log.error("LLM streamText failed", { error: msg, sid });
      emitError("llm", msg);
    }
    return collected;
  }
}
