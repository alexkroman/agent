// Copyright 2026 the AAI authors. MIT license.
/**
 * The last gate the agent's audio passes: a deadline before which nothing may
 * leave, whatever the rest of the pipeline has ready.
 *
 * Two windows arm it and they are ONE deadline rather than two, which is the
 * property the whole module exists to make true:
 *
 * - **the start-speaking floor** (`startSpeakingFloorMs`, Vapi's
 *   `waitSeconds`) — armed when a reply starts, so a pipeline that answered
 *   faster than the floor waits out the remainder and a slower one pays
 *   nothing;
 * - **the interruption backoff** (`interruptionBackoffMs`, Vapi's
 *   `backoffSeconds`) — armed when a barge-in really fires, so the agent's
 *   next reply does not land on top of the utterance that interrupted it.
 *
 * `hold` takes the LATER of the pending deadline and the new one, never the
 * sum. A reply that starts inside a backoff window therefore waits out
 * whatever is left of it and not that plus its own floor; both windows are
 * claims about the same thing — the earliest moment the caller should hear
 * the agent — and adding two answers to one question is how a "0.4s floor"
 * becomes a measured 1.4s of silence nobody declared.
 *
 * ## Ordering is the reason this queues rather than drops
 *
 * Everything downstream of TTS is order-dependent: the heard cursor advances
 * by audio duration, the word timings index into the same stream, and the
 * client plays what it is sent. So a held delivery is QUEUED in arrival order
 * and flushed in that order — never skipped, never reordered. What a
 * cancelled turn's audio gets instead is {@link SpeakGate.drop}, which clears
 * the queue: the turn's own audio gate (`turns.audioGateOpen()`) is the
 * authority on whether a chunk is still wanted, and this gate must not become
 * a second, later, disagreeing copy of it.
 *
 * ## Zero is a pass-through, not a zero-length wait
 *
 * With both windows at their shipped `0` the gate holds no state and every
 * delivery runs synchronously inside the caller — byte-identical to the code
 * before it existed, with no timer, no queue and no microtask. That is worth
 * more than it sounds: the defaults are 0 precisely because neither window is
 * measured on this corpus, so the shipped path has to be the unchanged one.
 */

import { createRestartableTimer, type RestartableTimer } from "../_timer.ts";
import type { Logger } from "../runtime-config.ts";

/** One held delivery — the whole downstream effect of one TTS frame. */
type Delivery = () => void;

export interface SpeakGate {
  /**
   * Hold output until at least `ms` from now. The LATER of this and any
   * pending deadline wins; a non-positive `ms` is a no-op.
   */
  hold(ms: number): void;
  /**
   * Run `deliver` now, or queue it until the deadline passes. Queued
   * deliveries flush in arrival order.
   */
  deliver(deliver: Delivery): void;
  /** Discard everything queued — a cancelled turn's audio is not wanted late. */
  drop(): void;
  /** Release the deadline and flush. Session teardown; also clears the timer. */
  stop(): void;
}

/** A gate with both windows at 0: every delivery runs inline. */
function passthroughGate(): SpeakGate {
  return {
    hold: () => undefined,
    deliver: (deliver) => deliver(),
    drop: () => undefined,
    stop: () => undefined,
  };
}

export function createSpeakGate(opts: {
  /** Minimum ms between a reply starting and its first audio — 0 disables. */
  startSpeakingFloorMs: number;
  /** Ms of silence after a real interruption — 0 disables. */
  interruptionBackoffMs: number;
  /** Clock source; injectable so a spec need not sleep out a real window. */
  now?: (() => number) | undefined;
  log: Logger;
  sid: string;
}): SpeakGate {
  const { startSpeakingFloorMs, interruptionBackoffMs } = opts;
  if (!(startSpeakingFloorMs > 0 || interruptionBackoffMs > 0)) return passthroughGate();

  const now = opts.now ?? Date.now;
  let deadlineMs = 0;
  let queue: Delivery[] = [];
  const timer: RestartableTimer = createRestartableTimer(() => flush());

  /**
   * Run everything queued, in order.
   *
   * The queue is swapped out BEFORE the walk: a delivery writes to the
   * client and can synchronously provoke another (the client's playback
   * report is handled on the same loop), and appending to the array being
   * walked would run that one out of order under the gate it just left.
   */
  function flush(): void {
    deadlineMs = 0;
    const pending = queue;
    queue = [];
    for (const run of pending) run();
  }

  function remainingMs(): number {
    return deadlineMs - now();
  }

  return {
    hold(ms: number): void {
      if (!(ms > 0)) return;
      const candidate = now() + ms;
      // The LATER of the two, never the sum — see the module doc.
      if (candidate <= deadlineMs) return;
      deadlineMs = candidate;
      timer.arm(ms);
      opts.log.debug("Pipeline speak gate held", { sid: opts.sid, ms });
    },

    deliver(deliver: Delivery): void {
      const remaining = remainingMs();
      if (remaining <= 0) {
        // A deadline that has passed with a queue still standing means the
        // timer has not run yet (same tick). Flush in order first, so this
        // delivery cannot overtake one that was held.
        if (queue.length > 0) flush();
        deliver();
        return;
      }
      queue.push(deliver);
    },

    drop(): void {
      queue = [];
    },

    stop(): void {
      timer.clear();
      deadlineMs = 0;
      queue = [];
    },
  };
}
