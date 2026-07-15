// Copyright 2026 the AAI authors. MIT license.
// Streaming helpers for the pipeline transport — interprets the Vercel AI
// SDK `streamText` `fullStream` parts (text deltas, tool calls/results,
// errors) and fans them out to the transcript, TTS, and observability sinks,
// plus the per-turn TTS flush-wait and audio byte conversion.
//
// Split out of `pipeline-transport.ts` so that transport owns provider
// lifecycle/turn orchestration while this module owns the per-part and
// per-chunk mechanics.

import type { ModelMessage } from "ai";
import { PIPELINE_FLUSH_TIMEOUT_MS } from "../../sdk/constants.ts";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { TtsSession, Unsubscribe } from "../../sdk/providers.ts";
import type { Message } from "../../sdk/types.ts";
import { capToolResult, errorMessage } from "../../sdk/utils.ts";
import type { Logger } from "../runtime-config.ts";

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
export function flushTtsAndWait(args: {
  tts: TtsSession | null;
  signal: AbortSignal;
  log: Logger;
  sid: string;
}): Promise<void> {
  const { tts, signal, log, sid } = args;
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
      log.warn("TTS flush timeout", { sid, timeoutMs: PIPELINE_FLUSH_TIMEOUT_MS });
      finish();
    }, PIPELINE_FLUSH_TIMEOUT_MS);
    tts.flush();
  });
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
