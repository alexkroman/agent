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
 * ## And the ending turn waits for the hook
 *
 * The runtime calls `onSessionEnd` and does not await it — right for a real
 * connection, where nothing is waiting on the hook's writes. A case is: "the
 * hang-up marked the call ended" is a claim about what the hook WROTE, and a
 * turn that returned before the write landed made a downstream suite poll for
 * it with `vi.waitFor`. {@link watchSessionEndHook} watches the one call the
 * runtime makes (the way `observeSessionContext` watches `sessionContext`)
 * and hands the ending turn, and `close()`, its settlement to await — bounded
 * by {@link SESSION_END_HOOK_WAIT_MS}, so a hook that hangs costs a case that
 * long and no longer.
 *
 * @module
 */

import type { AgentDef, SessionEvent } from "@alexkroman1/aai";
import { claimSessionEnder } from "@alexkroman1/aai/host-internal";
import pTimeout from "p-timeout";
import { TURN_ENDS } from "./events.ts";

/**
 * How long an ending turn, or `close()`, waits for the agent's `onSessionEnd`
 * to settle before returning anyway.
 *
 * Ten seconds: a hook that finishes a call's record or starts a summarizer run
 * is a request or two, and one past this is itself the finding — the turn
 * returns, and a claim about what the hook wrote then fails on the missing
 * write rather than hanging the case.
 */
export const SESSION_END_HOOK_WAIT_MS = 10_000;

/** An agent whose `onSessionEnd` is watched, and a way to wait for it. */
export type WatchedSessionEndHook = {
  readonly agent: AgentDef;
  /**
   * Settles once the hook the runtime called has settled — resolved, rejected
   * or thrown — or after `waitMs`, whichever is first. At once when the hook
   * was never called (no hook, a refused session, no stop yet). Never rejects:
   * a failing hook is the runtime's to log, as it is for a real connection.
   */
  settled(): Promise<void>;
};

/**
 * `agent` with its `onSessionEnd` WATCHED: called exactly as the runtime calls
 * it, its result handed back untouched (so the runtime still logs a
 * rejection), and its settlement recorded for {@link WatchedSessionEndHook.settled}.
 */
export function watchSessionEndHook(
  agent: AgentDef,
  waitMs: number = SESSION_END_HOOK_WAIT_MS,
): WatchedSessionEndHook {
  const hook = agent.onSessionEnd;
  if (hook === undefined) return { agent, settled: () => Promise.resolve() };
  let running: Promise<unknown> | undefined;
  return {
    agent: {
      ...agent,
      onSessionEnd: (args) => {
        const result = hook(args);
        running = Promise.resolve(result).catch(() => undefined);
        return result;
      },
    },
    async settled() {
      if (running === undefined) return;
      await pTimeout(running, { milliseconds: waitMs }).catch(() => undefined);
    },
  };
}

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
