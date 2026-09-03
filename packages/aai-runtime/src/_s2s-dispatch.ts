// Copyright 2025 the AAI authors. MIT license.
/**
 * Internal: the S2S wire-message → session-callback dispatch.
 *
 * Split from `s2s.ts`, which owns the CONNECTION (socket construction, the
 * open race, resume, send gating, close handling). This module owns the pure
 * translation layer sitting on top of it: given a parsed `S2sServerMessage`
 * and the per-connection dedup/audit state, decide which `S2sCallbacks` fire.
 * It touches no socket and starts no I/O, which is what makes the turn-shaping
 * rules below testable without a connection.
 *
 * {@link S2sCallbacks} lives here rather than in `s2s.ts` because it IS this
 * module's contract — the set of things a wire message can cause. `s2s.ts`
 * re-exports it, so existing `from "./s2s.ts"` imports are unaffected.
 */

import type { S2sServerMessage } from "./_s2s-messages.ts";
import {
  appendReplyDelta,
  type ReplyAudit,
  replyAnomaly,
  replyAuditFields,
  resetReplyAudit,
} from "./_s2s-reply.ts";
import type { Logger } from "./runtime-config.ts";

/** Callbacks fired into the owning session at construction time. */
export type S2sCallbacks = {
  onSessionReady(sessionId: string): void;
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudio(bytes: Uint8Array): void;
  onUserTranscript(text: string): void;
  /** Live partial of the user's current utterance; replaces, never appends. */
  onUserTranscriptPartial(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  /** The reply's text so far, accumulated from `transcript.agent.delta`. */
  onAgentTranscriptPartial(text: string): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
  onSessionExpired(): void;
  onError(err: Error): void;
  onClose(code: number, reason: string): void;
};

/**
 * Per-connection dispatch state. Used to dedup events that the upstream S2S
 * service may emit more than once for a single logical turn (e.g. repeated
 * `input.speech.stopped` after the VAD flips).
 */
export type DispatchState = { speechActive: boolean; reply: ReplyAudit };

export type DispatchContext = {
  log: Logger;
  sid?: string;
};

function sidFields(ctx: DispatchContext): { sid?: string } {
  return ctx.sid !== undefined ? { sid: ctx.sid } : {};
}

/**
 * Report what the finished reply actually delivered, then advance the session.
 *
 * The audit fields are what make an empty-looking reply diagnosable: without
 * them a reply that streamed audio and sent no transcript is identical in the
 * log to one that produced nothing. See `_s2s-reply.ts`.
 */
function dispatchReplyDone(
  callbacks: S2sCallbacks,
  status: string,
  state: DispatchState,
  ctx: DispatchContext,
): void {
  // Logged before the client-facing dedup in SessionCore, so a stalled session
  // can be checked against the raw arrivals.
  const audit = replyAuditFields(state.reply);
  ctx.log.info("S2S << reply.done", { ...sidFields(ctx), status, ...audit });
  const anomaly = replyAnomaly(state.reply, status);
  if (anomaly !== undefined) ctx.log.warn(anomaly, { ...sidFields(ctx), ...audit });
  if (status === "interrupted") {
    // No salvage from deltas here, deliberately: the delta batch covers the
    // whole composed reply, so committing it would credit the agent with words
    // the caller was talking over and never heard (see `_s2s-reply.ts`).
    callbacks.onCancelled();
    return;
  }
  // A completed reply that sent no `transcript.agent` — the ordinary shape of a
  // tool-preamble turn — has its text recovered from the word deltas, which are
  // the only carrier of it. Emitted before `onReplyDone` so the transcript is
  // committed to history within the turn it belongs to.
  if (!state.reply.sawFinal && state.reply.deltaText !== "") {
    callbacks.onAgentTranscript(state.reply.deltaText, false);
  }
  callbacks.onReplyDone();
}

export function dispatchS2sMessage(
  callbacks: S2sCallbacks,
  msg: S2sServerMessage,
  state: DispatchState,
  ctx: DispatchContext,
): void {
  switch (msg.type) {
    case "session.ready":
      callbacks.onSessionReady(msg.session_id);
      break;
    case "session.updated":
      // The S2S API conveys the session id via `config.id` in the success
      // path (no separate `session.ready` is emitted); capturing it here is
      // required for resume on transient close.
      if (msg.config?.id !== undefined) callbacks.onSessionReady(msg.config.id);
      break;
    case "input.speech.started":
      if (!state.speechActive) {
        state.speechActive = true;
        callbacks.onSpeechStarted();
      }
      break;
    case "input.speech.stopped":
      if (state.speechActive) {
        state.speechActive = false;
        callbacks.onSpeechStopped();
      }
      break;
    case "transcript.user":
      callbacks.onUserTranscript(msg.text);
      break;
    case "transcript.user.delta":
      callbacks.onUserTranscriptPartial(msg.text);
      break;
    case "reply.started":
      // A new reply supersedes the last one's tally.
      resetReplyAudit(state.reply);
      callbacks.onReplyStarted(msg.reply_id);
      break;
    case "transcript.agent":
      state.reply.sawFinal = true;
      callbacks.onAgentTranscript(msg.text, msg.interrupted);
      break;
    case "transcript.agent.delta":
      // Forwarded as a partial (replace semantics — the accumulation is the
      // text so far), never straight to history: the final `transcript.agent`
      // owns that when it arrives, and `dispatchReplyDone` owns it when it
      // does not.
      callbacks.onAgentTranscriptPartial(appendReplyDelta(state.reply, msg.text));
      break;
    case "tool.call":
      state.reply.sawToolCall = true;
      callbacks.onToolCall(msg.call_id, msg.name, msg.args);
      break;
    case "reply.done":
      dispatchReplyDone(callbacks, msg.status ?? "completed", state, ctx);
      break;
    case "session.error":
      ctx.log.warn("S2S << session.error", {
        ...sidFields(ctx),
        code: msg.code,
        message: msg.message,
      });
      if (msg.code === "session_not_found" || msg.code === "session_forbidden") {
        callbacks.onSessionExpired();
      } else {
        callbacks.onError(new Error(msg.message));
      }
      break;
    case "error":
      // Logged here with its message because `logIncoming` prints the type
      // only, and the transport now forwards in-band errors as NON-fatal (see
      // its `onError` mapping) — which session-core logs at debug. Without this
      // line, demoting the client-facing severity would also have made the
      // service's own complaint invisible in a default-logger deployment.
      ctx.log.warn("S2S << error", { ...sidFields(ctx), message: msg.message });
      callbacks.onError(new Error(msg.message));
      break;
    default:
      break;
  }
}
