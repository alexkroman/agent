// Copyright 2026 the AAI authors. MIT license.
/**
 * `endSession(ctx)` taking effect in an eval session.
 *
 * A tool's `endSession(ctx)` reaches whatever ender the runtime registered for
 * the session id. The socket and `connectSession` paths register one through
 * `session-attach.ts`; the eval session is built with `runtime.createSession`
 * directly and registered none, so the call answered `false` and nothing
 * happened: a calling agent's `end_call` "hung up" and the session kept
 * answering. A downstream suite drove its lines in a loop that broke on the
 * tool's NAME, and its hang-up invariant was a claim about which tool was
 * called rather than about whether the call ended.
 *
 * So this registers the ender, and does what the paced sink does for a real
 * connection (`paced-client-sink.ts`, `endAfterReply`), minus the audio:
 *
 * - **`afterReply` (the default) ends the session at the reply's own
 *   terminator.** A real connection waits for the goodbye to finish PLAYING;
 *   an eval has no playback, so the reply's `reply.completed` is the moment the
 *   caller would have heard the last word. The turn is therefore captured whole
 *   — its text, its tool calls, `completed: true` — which is what a case about
 *   the goodbye asserts on.
 * - **`afterReply: false` stops it now**, as a real connection's close does,
 *   and the turn in flight is captured as far as it got.
 *
 * Either way the stop is the session's ordinary `stop()`: the log is flushed
 * and `onSessionEnd` fires — so a hook that finishes the call's record runs
 * when the agent hung up, not when the case closed the session.
 *
 * @module
 */

import type { SessionEvent } from "@alexkroman1/aai";
import { claimSessionEnder } from "@alexkroman1/aai/host-internal";
import { TURN_ENDS } from "./events.ts";

/** One session's end, as a tool's `endSession(ctx)` asked for it. */
export type EvalSessionEnd = {
  /** A tool asked to end the session — whether or not the stop has finished. */
  requested(): boolean;
  /**
   * The session's stop has BEGUN — at once for `afterReply: false`, at the
   * reply's terminator otherwise. A turn waiting on a reply stops waiting here:
   * a session cut off mid-reply sends no terminator.
   */
  stopping(): boolean;
  /** Hand every sink event here: a terminator releases a pending `afterReply` end. */
  observe(event: SessionEvent): void;
  /** Settles once the stop a request began has finished; at once when none began. */
  settled(): Promise<void>;
  /** Unregister the ender (by claim, as `session-attach.ts` releases its own). */
  release(): void;
};

/**
 * Register the ender for `sessionId`; `stop` is the session's own stop.
 *
 * Once only, as `endOnRequest` is for a real connection: a tool that asks twice,
 * or two tools in one turn, end it once.
 */
export function watchSessionEnd(sessionId: string, stop: () => Promise<void>): EvalSessionEnd {
  let requested = false;
  let pendingAfterReply = false;
  let stopping: Promise<void> | undefined;
  const begin = (): void => {
    // A microtask later, never inside the call that asked: the ender runs from
    // inside a tool's `execute`, and a terminator arrives from inside the
    // session's own emit — stopping the session from either would tear it down
    // under the frame that is still using it.
    // A failed stop is the runtime's to log, as it is for a real connection;
    // a case sees the end it asked for either way.
    stopping = Promise.resolve()
      .then(stop)
      .catch(() => undefined);
  };
  const release = claimSessionEnder(sessionId, ({ afterReply }) => {
    if (requested) return;
    requested = true;
    if (afterReply) pendingAfterReply = true;
    else begin();
  });
  return {
    requested: () => requested,
    stopping: () => stopping !== undefined,
    observe(event) {
      if (!(pendingAfterReply && TURN_ENDS.has(event.type))) return;
      pendingAfterReply = false;
      begin();
    },
    settled: () => stopping ?? Promise.resolve(),
    release: () => void release(),
  };
}
