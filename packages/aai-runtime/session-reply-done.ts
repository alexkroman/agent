// Copyright 2026 the AAI authors. MIT license.
/**
 * When a `reply.done` is the turn's real end, and what happens when it is.
 *
 * Split out of `session-core.ts` at the 500-line cap. The seam is a real one:
 * every line here answers one question — a provider sends `reply.done` more than
 * once per turn, and the session has to tell the frame that ENDS a turn from the
 * two frames that do not.
 *
 * Three ways a `reply.done` is not the end, each with its own guard:
 *
 * - **No active reply.** Already dispatched, or never started. `currentReplyId`
 *   is null and the frame is dropped.
 * - **Tool results are pending.** The turn continues at the provider: flush them
 *   and wait. What must NOT happen is emitting the client's turn boundary, which
 *   would tell the caller the agent had finished mid-work.
 * - **Results were already flushed and nothing has happened since.** The
 *   provider re-sent the frame while awaiting its own continuation. Any sign of
 *   progress — a tool call, a transcript, an audio chunk — clears the flag, so
 *   this only fires on a genuine duplicate.
 *
 * And one way the reply the frame refers to is not the CURRENT reply: a barge-in
 * or reset swaps in a fresh reply object while the flush waits on the turn
 * promise, so the comparison is by object IDENTITY and a stale frame drops its
 * orphaned tools rather than touching the live reply.
 */

import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import type { ReplyToolState } from "./session-tool-steps.ts";

/** How long a dispatch may take before it is worth a line in the log. */
const REPLY_DONE_SLOW_THRESHOLD_MS = 50;

/** What the dispatcher needs from the session around it. */
export type ReplyDoneDeps = {
  sessionId: string;
  agent: string;
  emit: SessionEmitter["emit"];
  log: Logger;
  /** The reply the session considers current, read at flush time, not captured. */
  currentReply: () => ReplyToolState;
  /** The turn chain, or null when no tool call is in flight. */
  turnPromise: () => Promise<void> | null;
  /** Hand one settled tool result to the transport. */
  sendToolResult: (callId: string, result: string) => void;
};

/**
 * Dispatch one `reply.done` from the transport.
 *
 * @internal
 */
export function dispatchReplyDone(deps: ReplyDoneDeps): void {
  const { log, emit } = deps;
  const startMs = Date.now();
  // Capture the reply OBJECT, not just its id — see the module doc.
  const doneReply = deps.currentReply();
  if (doneReply.currentReplyId === null) {
    log.debug("Dropping duplicate reply.done (no active reply)");
    return;
  }
  const turnPromise = deps.turnPromise();
  const hadTurnPromise = turnPromise !== null;

  const endTurn = (): void => {
    const stepsUsed = doneReply.toolCallCount;
    if (stepsUsed > 0) log.info("Turn complete", { steps: stepsUsed, agent: deps.agent });
    // Both go out behind whatever audio the pacer still holds — the sink orders
    // them by type, so the turn boundary cannot overtake the reply it closes.
    emit({ type: "audio.completed" });
    emit({ type: "reply.completed" });
    doneReply.currentReplyId = null;
    const durationMs = Date.now() - startMs;
    if (durationMs >= REPLY_DONE_SLOW_THRESHOLD_MS) {
      log.warn("slow reply.completed dispatch", {
        sid: deps.sessionId,
        agent: deps.agent,
        durationMs,
        hadTurnPromise,
      });
    }
  };

  const sendPending = (): void => {
    // A newer reply replaced this one → it's stale. Drop its orphaned pending
    // tools; never touch the current reply.
    if (deps.currentReply() !== doneReply) {
      doneReply.pendingTools = [];
      return;
    }
    if (doneReply.pendingTools.length > 0) {
      for (const tool of doneReply.pendingTools) deps.sendToolResult(tool.callId, tool.result);
      doneReply.pendingTools = [];
      doneReply.flushedAwaitingContinuation = true;
    } else if (doneReply.flushedAwaitingContinuation) {
      log.debug("Dropping duplicate reply.done (awaiting tool continuation)");
    } else {
      endTurn();
    }
  };

  // sendPending writes to the transport, which may be a dying socket — a throw
  // here must surface as a log, not an unhandled rejection (or a sync throw out
  // of the transport's event dispatch).
  const sendPendingSafely = (): void => {
    try {
      sendPending();
    } catch (err) {
      log.warn("reply.done dispatch failed", { sid: deps.sessionId, error: errorMessage(err) });
    }
  };

  if (turnPromise !== null) {
    void turnPromise.then(sendPendingSafely).catch((err: unknown) => {
      log.warn("turn promise rejected before reply.done dispatch", {
        sid: deps.sessionId,
        error: errorMessage(err),
      });
    });
  } else sendPendingSafely();
}
