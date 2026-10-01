// Copyright 2026 the AAI authors. MIT license.
/**
 * The session's CURRENT reply and the tool work chained onto it.
 *
 * The reply's shape is `tool-steps.ts`'s — that module mutates it — with the
 * two fields whose meaning belongs to the TURN:
 *
 * - `abort` cancels this reply's in-flight tool executions on
 *   barge-in/reset/stop.
 * - `flushedAwaitingContinuation` is true after a `reply.done` flushed this
 *   reply's tool results to the transport and the turn is waiting on the
 *   provider's continuation. Cleared by any sign of continuation progress (tool
 *   call, transcript, audio). While set, a `reply.done` with no new pending tools
 *   is a duplicate frame — flushing it would emit a premature client
 *   `reply.completed`/`audio.completed` mid-turn.
 *
 * Both are READ LATE through `current()` / `turnPromise()`: a barge-in swaps
 * the reply object mid-dispatch, and `reply-done.ts`'s staleness handling is
 * reading them after its awaits.
 */

import type { ReplyToolState } from "./tool-steps.ts";

export type ReplyTracker = {
  /** The reply tools are bound to right now. */
  current(): ReplyToolState;
  /** The current reply's chained tool work, or `null` when none was started. */
  turnPromise(): Promise<void> | null;
  /** A new reply: abort the replaced one's tools and start a fresh chain. */
  begin(replyId: string): void;
  /** A cancelled reply: abort its tools and drop to an id-less reply. */
  cancel(): void;
  /** Abort the current reply's in-flight tool executions. */
  abortTools(): void;
  /** Chain one tool step's settlement onto the turn. */
  chainTool(step: Promise<void>): void;
};

function emptyReply(): ReplyToolState {
  return {
    currentReplyId: null,
    pendingTools: [],
    toolCallCount: 0,
    abort: new AbortController(),
    flushedAwaitingContinuation: false,
  };
}

export function createReplyTracker(): ReplyTracker {
  let reply = emptyReply();
  let turnPromise: Promise<void> | null = null;
  return {
    current: () => reply,
    turnPromise: () => turnPromise,
    begin(replyId) {
      // Tools still in flight belong to the reply being replaced — they're
      // orphaned either way, so cancel them instead of letting them run on.
      reply.abort.abort();
      reply = { ...emptyReply(), currentReplyId: replyId };
      turnPromise = null;
    },
    cancel() {
      reply.abort.abort();
      reply = emptyReply();
    },
    abortTools() {
      reply.abort.abort();
    },
    chainTool(step) {
      turnPromise = (turnPromise ?? Promise.resolve()).then(() => step);
    },
  };
}
