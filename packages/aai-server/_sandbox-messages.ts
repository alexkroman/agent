// Copyright 2026 the AAI authors. MIT license.
/**
 * Host-side tracker that turns the per-tool-call history snapshot into an
 * incremental `tool/execute` messages delta (see guest/harness-messages.ts
 * for the wire protocol and the guest half).
 *
 * The runtime snapshots history with `history.slice()` on every tool call
 * (aai's session-core.ts and to-vercel-tools.ts), so the message *objects*
 * keep their identity across calls while the array is a fresh copy. History
 * is append-only until the maxHistory cap splices it from the front (or a
 * client reset empties it). That makes "may I append?" a cheap, safe check:
 * if the first message and the message at the old watermark are the very
 * same objects as last time, the prefix the guest already holds is
 * unchanged and only the tail needs to cross the stdio pipe. Any
 * splice/reset breaks identity and falls back to a full send.
 *
 * The tracker commits optimistically at delta time: requests are written to
 * the guest in computation order (the NDJSON channel is FIFO), so by the
 * time the guest processes request N+1 it has applied request N. If a send
 * fails — or the guest reports a desync — the caller must `reset` the
 * session so the next call carries full history.
 */

import type { Message } from "@alexkroman1/aai";
import { MESSAGES_DESYNC_ERROR, type MessagesMode } from "./guest/harness-messages.ts";

/** The messages portion of one `tool/execute` request's params. */
export type MessagesDelta = {
  messages: Message[];
  messagesMode: MessagesMode;
  messagesBase?: number;
};

type SentState = {
  count: number;
  first: Message | undefined;
  last: Message | undefined;
};

export type MessageDeltaTracker = {
  /** Compute the delta to send for this call's history snapshot. */
  delta(sessionId: string, messages: readonly Message[]): MessagesDelta;
  /** Forget a session (ended, failed send, or reported desync). */
  reset(sessionId: string): void;
};

export function createMessageDeltaTracker(): MessageDeltaTracker {
  const sent = new Map<string, SentState>();
  return {
    delta(sessionId, messages) {
      const prev = sent.get(sessionId);
      const canAppend =
        prev !== undefined &&
        messages.length >= prev.count &&
        (prev.count === 0 ||
          (messages[0] === prev.first && messages[prev.count - 1] === prev.last));
      sent.set(sessionId, {
        count: messages.length,
        first: messages[0],
        last: messages.at(-1),
      });
      if (canAppend) {
        return {
          messages: messages.slice(prev.count),
          messagesMode: "append",
          messagesBase: prev.count,
        };
      }
      return { messages: messages.slice(), messagesMode: "full" };
    },
    reset(sessionId) {
      sent.delete(sessionId);
    },
  };
}

/** True when a guest `tool/execute` response reports a messages desync. */
export function isMessagesDesync(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "error" in raw &&
    (raw as { error: unknown }).error === MESSAGES_DESYNC_ERROR
  );
}
