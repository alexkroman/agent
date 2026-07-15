// Copyright 2026 the AAI authors. MIT license.
// Stream-part handling for the pipeline transport — interprets the Vercel AI
// SDK `streamText` `fullStream` parts (text deltas, tool calls/results,
// errors) and fans them out to the transcript, TTS, and observability sinks.
//
// Split out of `pipeline-transport.ts` so that transport owns provider
// lifecycle/turn orchestration while this module owns per-part decoding.

import type { ModelMessage } from "ai";
import { MAX_TOOL_RESULT_CHARS } from "../../sdk/constants.ts";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { Message } from "../../sdk/types.ts";
import { errorMessage } from "../../sdk/utils.ts";
import type { Logger } from "../runtime-config.ts";

/** Convert an internal conversation {@link Message} to a Vercel AI {@link ModelMessage}. */
export function toModelMessage(m: Message): ModelMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  return { role: "assistant", content: m.content };
}

/**
 * View client audio bytes as PCM16 LE samples. Zero-copy when the view is
 * 2-byte aligned; otherwise copies, dropping a trailing odd byte.
 */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const { byteOffset: offset, byteLength: length } = bytes;
  if (offset % 2 === 0 && length % 2 === 0) {
    return new Int16Array(bytes.buffer, offset, length / 2);
  }
  const copy = new Uint8Array(length - (length % 2));
  copy.set(bytes.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
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
  log: Logger;
  sid: string;
};

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
    const truncated =
      str.length > MAX_TOOL_RESULT_CHARS ? str.slice(0, MAX_TOOL_RESULT_CHARS) : str;
    onToolCallDone?.(callId, truncated);
  }

  return function handlePart(part: StreamPart): void {
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
