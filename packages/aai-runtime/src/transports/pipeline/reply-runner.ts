// Copyright 2026 the AAI authors. MIT license.
/**
 * The reply SCAFFOLD every pipeline reply runs inside — an ordinary turn
 * (`turn-body.ts`), the greeting and a `speakLine` (`reply/lines.ts`, through
 * `lifecycle.ts`). Assembly, like `transport.ts`: it composes stages and is
 * imported by no stage.
 */

import type { TransportCallbacks } from "../types.ts";
import type { HeardTracker } from "./heard/index.ts";
import type { SpeculationController } from "./speech/index.ts";
import type { TurnMachine, TurnMetrics } from "./turn/index.ts";

/** Run one reply: `body` resolves whether it produced speech. */
export type RunReply = (
  idPrefix: string,
  body: (signal: AbortSignal) => Promise<boolean /* spoke */>,
) => Promise<void>;

export type ReplyRunnerDeps = {
  speculation: Pick<SpeculationController, "discard">;
  callbacks: Pick<TransportCallbacks, "onReplyStarted" | "report">;
  metrics: Pick<TurnMetrics, "begin" | "finish">;
  /** Arm the speak gate's start-speaking floor for this reply. */
  armFloor: () => void;
  /** The session-lifetime signal; a reply's own signal also dies with it. */
  sessionSignal: AbortSignal;
  turns: Pick<TurnMachine, "begin" | "setDraining" | "settle">;
  heard: Pick<HeardTracker, "startReply">;
  /** Per-turn TTS drain — `flushTtsAndWait`. */
  drainTts: (signal: AbortSignal) => Promise<void>;
  /** Re-arm the silence nudger after a reply that was not aborted. */
  rearmNudger: () => void;
};

/**
 * Shared reply scaffold: mint the reply id and turn controller, run the turn
 * body, then drain TTS — only when the body produced speech, since a
 * tool-call-only turn never gets a TTS `done` and would burn the full flush
 * timeout. Do NOT report `audio.completed` here — session-core's flushReply
 * emits audioDone + replyDone together; calling it here would double-fire
 * audio_done.
 */
export function createReplyRunner(deps: ReplyRunnerDeps): RunReply {
  const { speculation, callbacks, metrics, turns, heard } = deps;
  let nextReplyId = 0;

  return async (idPrefix, body) => {
    // A turn is taking the floor: whatever speculation is still standing was
    // not claimed by it (`runTurn` claims BEFORE calling in), so it belongs to
    // an utterance this turn has moved past. Discarded here rather than left to
    // be adopted later by a turn that never spoke the words it was built on.
    speculation.discard("turn-started");
    callbacks.onReplyStarted(`${idPrefix}-${++nextReplyId}`);
    metrics.begin();

    // One reply, one floor, measured from the moment the turn took the floor
    // rather than from whenever TTS produced its first frame. It takes the
    // LATER of this and any backoff still standing, never the sum.
    deps.armFloor();

    const ctl = new AbortController();
    // stop()/terminate() aborts only the turn of the moment; combine with
    // the session signal so a turn that starts later still dies with the
    // session instead of running against closed providers. AbortSignal.any
    // holds its sources weakly, so a settled turn leaves no listener on the
    // session-lifetime signal.
    const signal = AbortSignal.any([deps.sessionSignal, ctl.signal]);
    turns.begin(ctl);
    heard.startReply();

    try {
      const spoke = await body(signal);
      if (spoke && !signal.aborted) {
        // The body persisted the full reply; only synthesis/playback remains.
        // A barge-in in this window is classified as a playback cut (see
        // TurnMachine.draining).
        turns.setDraining(true);
        try {
          await deps.drainTts(signal);
        } finally {
          turns.setDraining(false);
        }
      }
      if (!signal.aborted) callbacks.report({ type: "reply.completed" });
    } finally {
      // Return to idle unless a newer turn already replaced this one.
      turns.settle(ctl);
      const collected = metrics.finish(signal.aborted);
      if (collected) callbacks.report(collected);
      // Aborted turns skip the re-arm: onSttPartial / cancelReply handle those.
      if (!signal.aborted) deps.rearmNudger();
    }
  };
}
