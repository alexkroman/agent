// Copyright 2026 the AAI authors. MIT license.
/**
 * The OpenAI Realtime transport's INBOUND half: one server event in, the
 * matching session report or lifecycle event out.
 *
 * Its own module so `createOpenaiRealtimeTransport` holds the socket and the
 * outbound frames only. What lives here is the per-turn residue a response
 * accumulates (agent transcript deltas, streamed tool-call arguments) and the
 * one dispatch over `obj.type`; the lifecycle (`openai-realtime-lifecycle.ts`)
 * still owns WHEN a reply starts, ends or is cancelled.
 */

import { toArgsRecord } from "@alexkroman1/aai/internal";
import type { SessionErrorCode } from "@alexkroman1/aai/protocol";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { base64ToUint8 } from "../_base64.ts";
import type { Logger } from "../logger.ts";
import type { OpenaiRealtimeLifecycle } from "./openai-realtime-lifecycle.ts";
import type { TransportCallbacks } from "./types.ts";

type ToolBuffer = { callId: string; name: string; argsBuffer: string };

/** What a response accumulates between its first delta and its `…done`. */
export type RealtimeTurnBuffers = {
  /** Agent transcript text per output item. */
  transcripts: Map<string, string>;
  /** Streamed function-call arguments per output item. */
  tools: Map<string, ToolBuffer>;
  /** Discard both — wired as the lifecycle's `clearTurnBuffers` effect. */
  clear(): void;
};

export function createRealtimeTurnBuffers(): RealtimeTurnBuffers {
  const transcripts = new Map<string, string>();
  const tools = new Map<string, ToolBuffer>();
  return {
    transcripts,
    tools,
    clear() {
      transcripts.clear();
      tools.clear();
    },
  };
}

export type RealtimeMessageDeps = {
  callbacks: TransportCallbacks;
  lifecycle: Pick<OpenaiRealtimeLifecycle, "send" | "phase" | "replying">;
  buffers: RealtimeTurnBuffers;
  log: Logger;
  /** A TURN-level, non-fatal error report (the socket stays open). */
  reportError: (code: SessionErrorCode, message: string) => void;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseToolArgs(
  argsStr: string,
  name: string,
  callId: string,
  log: Logger,
): Record<string, unknown> {
  if (!argsStr) return {};
  const parsed = safeJsonParse(argsStr);
  // `undefined` is safeJsonParse's malformed-input sentinel (JSON cannot
  // encode it), so this warns on exactly the malformed inputs —
  // valid-but-non-object args still fall through to {} without a warning.
  if (parsed === undefined) {
    log.warn("OpenAI Realtime: invalid tool args JSON", { name, callId });
    return {};
  }
  return toArgsRecord(parsed);
}

/** One handler per server event the transport acts on. */
function createEventHandlers(deps: RealtimeMessageDeps) {
  const { callbacks, lifecycle, buffers, log } = deps;
  return {
    audioDelta(obj: Record<string, unknown>): void {
      if (typeof obj.delta === "string") {
        // `log`, not the module default: a drop here is this session's.
        callbacks.onAudioChunk(base64ToUint8(obj.delta, log));
      }
    },

    speechStarted(): void {
      // Only `replying` acts on this — under server VAD it is a barge-in, and
      // the lifecycle reports the cancellation the client needs to flush its
      // buffered audio with. The speaking edge is reported either way.
      lifecycle.send({ type: "SPEECH_STARTED" });
      callbacks.report({ type: "speech.started" });
    },

    userTranscript(obj: Record<string, unknown>): void {
      if (typeof obj.transcript === "string") {
        callbacks.report({ type: "userTranscript.committed", text: obj.transcript });
      }
    },

    responseCreated(obj: Record<string, unknown>): void {
      const resp = obj.response as { id?: unknown } | undefined;
      lifecycle.send({ type: "REPLY_STARTED", replyId: asString(resp?.id) });
    },

    agentTranscriptDelta(obj: Record<string, unknown>): void {
      const id = asString(obj.item_id);
      const delta = asString(obj.delta);
      buffers.transcripts.set(id, (buffers.transcripts.get(id) ?? "") + delta);
    },

    agentTranscriptDone(obj: Record<string, unknown>): void {
      const id = asString(obj.item_id);
      const text = buffers.transcripts.get(id) ?? "";
      buffers.transcripts.delete(id);
      if (text) callbacks.report({ type: "agentTranscript.committed", text });
    },

    errorEvent(obj: Record<string, unknown>): void {
      const err = obj.error as { message?: unknown } | undefined;
      const message = typeof err?.message === "string" ? err.message : "OpenAI Realtime error";
      log.warn("OpenAI Realtime error event", { error: obj.error });
      // The turn buffers are NOT cleared here: the response this error
      // interrupts is still running, so its transcript buffer is live state
      // rather than turn residue, and clearing it would make the later
      // `…transcript.done` read `""` and suppress the transcript. Only a
      // response that really ended (`response.done`, a cancel, a server-VAD
      // barge-in) may discard them.
      // An in-band `error` leaves the socket open and the session usable —
      // OpenAI sends them for recoverable conditions (a response requested
      // while one is active, an unknown field) — so it is NON-fatal: a fatal
      // frame makes aai-ui release the microphone and end the call. Session
      // death is the close handler's to report.
      deps.reportError("internal", message);
    },

    outputItemAdded(obj: Record<string, unknown>): void {
      const item = obj.item as
        | { id?: string; type?: string; name?: string; call_id?: string }
        | undefined;
      log.info("OpenAI Realtime output_item.added", {
        itemType: item?.type,
        name: item?.name,
        callId: item?.call_id,
      });
      if (item?.type !== "function_call" || !item.id) return;
      buffers.tools.set(item.id, {
        callId: item.call_id ?? "",
        name: item.name ?? "",
        argsBuffer: "",
      });
    },

    functionCallArgsDelta(obj: Record<string, unknown>): void {
      const id = asString(obj.item_id);
      const delta = asString(obj.delta);
      const buf = buffers.tools.get(id);
      if (buf) buf.argsBuffer += delta;
    },

    functionCallArgsDone(obj: Record<string, unknown>): void {
      const id = asString(obj.item_id);
      const buf = buffers.tools.get(id);
      buffers.tools.delete(id);
      const callId = asString(obj.call_id) || (buf?.callId ?? "");
      const name = asString(obj.name) || (buf?.name ?? "");
      const argsStr = asString(obj.arguments) || (buf?.argsBuffer ?? "");
      log.info("OpenAI Realtime tool call", { name, callId, args: argsStr });
      const args = parseToolArgs(argsStr, name, callId, log);
      callbacks.report({ type: "tool.called", toolCallId: callId, toolName: name, args });
    },
  };
}

/** The frames that carry a response's content, owned only by the reply in flight. */
const RESPONSE_CONTENT: ReadonlySet<unknown> = new Set([
  "response.output_audio.delta",
  "response.output_audio.done",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.output_item.added",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
]);

/**
 * The transport's `message` handler: parse one frame and dispatch it. A frame
 * that is not JSON is logged and dropped; a JSON non-object is ignored.
 */
export function createRealtimeMessageHandler(deps: RealtimeMessageDeps): (data: unknown) => void {
  const { callbacks, lifecycle, log } = deps;
  const on = createEventHandlers(deps);
  /**
   * Does a frame of this type still belong to someone?
   *
   * A socket keeps delivering what is already on the wire after the reply or
   * the session it belongs to is over: the trailing deltas of a response the
   * session cancelled or the caller barged in on (OpenAI only stops producing
   * when the `response.cancel` reaches it), and anything at all once `stop()`
   * has closed a socket that is still CLOSING. Dispatched, those reached the
   * session as audio after the client was told to flush, a tool call of the
   * abandoned turn, and — because the reply's exit cleared its buffers — a
   * transcript FRAGMENT committed to history. So a finished session owns no
   * frame, and response content is owned only while a reply is in flight;
   * one socket delivers a response's frames between its `response.created`
   * and its `response.done`, so nothing legitimate is dropped.
   */
  const owned = (type: unknown): boolean => {
    const at = lifecycle.phase();
    if (at === "closed" || at === "ended") return false;
    return !RESPONSE_CONTENT.has(type) || lifecycle.replying();
  };
  return (data) => {
    const raw = safeJsonParse(String(data));
    if (raw === undefined) {
      log.warn("OpenAI Realtime: invalid JSON");
      return;
    }
    if (!isRecord(raw)) return;
    const obj = raw;
    if (!owned(obj.type)) {
      log.debug("OpenAI Realtime: frame of a finished reply or session dropped", {
        type: obj.type,
      });
      return;
    }
    switch (obj.type) {
      case "response.output_audio.delta":
        on.audioDelta(obj);
        return;
      case "response.output_audio.done":
        callbacks.report({ type: "audio.completed" });
        return;
      case "input_audio_buffer.speech_started":
        on.speechStarted();
        return;
      case "input_audio_buffer.speech_stopped":
        callbacks.report({ type: "speech.stopped" });
        return;
      case "conversation.item.input_audio_transcription.completed":
        on.userTranscript(obj);
        return;
      case "response.created":
        on.responseCreated(obj);
        return;
      case "response.output_audio_transcript.delta":
        on.agentTranscriptDelta(obj);
        return;
      case "response.output_audio_transcript.done":
        on.agentTranscriptDone(obj);
        return;
      case "response.done":
        lifecycle.send({ type: "REPLY_DONE" });
        return;
      case "response.output_item.added":
        on.outputItemAdded(obj);
        return;
      case "response.function_call_arguments.delta":
        on.functionCallArgsDelta(obj);
        return;
      case "response.function_call_arguments.done":
        on.functionCallArgsDone(obj);
        return;
      case "error":
        on.errorEvent(obj);
        return;
      default:
        log.debug("OpenAI Realtime: unhandled event", { type: obj.type });
        return;
    }
  };
}
