// Copyright 2026 the AAI authors. MIT license.
/**
 * When a silent session retires.
 *
 * Split out of `session-core.ts` because it is one self-contained decision with
 * a long argument attached, and that file is at its length cap — but the seam
 * is real rather than convenient: nothing here knows what a reply, a transcript
 * or a tool call is. It knows a deadline, and what a deadline expiring means.
 */

import { createCoalescingTimer } from "./_timer.ts";
import type { Logger } from "./runtime-config.ts";

/** What the watchdog does when the deadline passes. */
export type IdleWatchdogOptions = {
  /** Session id, for the log line. */
  sid: string;
  /** The window. `0` (or non-finite) disables the watchdog entirely. */
  idleMs: number;
  logger: Logger;
  /** Tell the client its session timed out. Informational — see below. */
  notify(): void;
  /** Retire the socket, which is what actually reclaims the session. */
  close(): void;
};

/** The idle watchdog, as a session drives it. */
export type IdleWatchdog = {
  /**
   * Re-arm the deadline. Call ONLY for conversation the TRANSPORT observed —
   * speech the STT/S2S service detected, or the agent replying.
   *
   * Never for inbound client frames or client-sent events. This used to re-arm
   * on every audio frame, which measured "the client is still sending bytes"
   * and not "someone is still talking" — and the browser mic streams
   * continuously by design, because barge-in needs it open. So a tab left open
   * on a silent room re-armed the timer ~50x a second forever: the session
   * never idled out, and on the platform its guest never reached zero sessions,
   * so the sandbox's own idle self-exit never fired either. Measured with
   * `idleTimeoutMs: 15000`, a stream of silent PCM held a session past 45s.
   *
   * Keeping the signal transport-side is also what makes it unfakeable: a
   * client cannot assert activity, it can only send audio that really contains
   * speech, which IS activity.
   */
  reset(): void;
  /** Disarm — the session is stopping. */
  clear(): void;
};

/**
 * Build the watchdog for one session.
 *
 * The timer is COALESCING because `reset` runs at audio-frame rate: it records
 * the deadline and keeps one long-lived timer instead of re-arming a 5-minute
 * timeout on every chunk. Its `clear()` also zeroes the deadline, so a callback
 * that already fired when the session stopped cannot re-arm and pin it for
 * another window.
 *
 * @internal
 */
export function createIdleWatchdog(opts: IdleWatchdogOptions): IdleWatchdog {
  const idleMs = opts.idleMs === 0 || !Number.isFinite(opts.idleMs) ? 0 : opts.idleMs;
  let stopped = false;

  const timer = createCoalescingTimer(
    () => {
      opts.logger.info("session idle timeout", { sid: opts.sid });
      // The event is a notification, not a teardown: clients treat it as
      // informational and wait for the close (aai-ui routes it to its default
      // branch and transitions on the close handler). Retiring the socket is
      // what actually reclaims the session, its provider sockets, and — on the
      // platform — the Modal input a WebSocket occupies. Closing runs the
      // normal teardown path via the socket's close listener.
      opts.notify();
      opts.close();
    },
    // A five-minute wait for a session to go quiet must not be the last thing
    // holding the process open — what it exists to retire is by definition
    // still alive, and something else is holding the reference for it. The
    // package's four other long timers (the keepalive, the lock sweep, the SSE
    // heartbeat, the state sweep) all say the same by hand.
    { unref: true },
  );

  return {
    reset(): void {
      if (stopped || idleMs <= 0) return;
      timer.arm(idleMs);
    },
    clear(): void {
      stopped = true;
      timer.clear();
    },
  };
}
