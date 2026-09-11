// Copyright 2026 the AAI authors. MIT license.
/**
 * The session-lifetime abort signal, and the one thing that has to be done to
 * it before it is safe to hang a call's worth of listeners off.
 *
 * Its own module because the argument is longer than the code and belongs
 * nowhere near turn orchestration — `pipeline-transport.ts` sits against the
 * source-length cap, and this is a self-contained decision about one object.
 */

import { setMaxListeners } from "node:events";

/**
 * `abort` listeners one session's signal may hold before Node calls it a leak.
 *
 * A LEAK threshold, not a capacity one. 50 rather than the default 10 because a
 * legitimate turn holds several at once — the turn's `AbortSignal.any`
 * composite, the speculation's, the TTS drain, each provider session — and a
 * barge-in can overlap two turns' teardown. Nothing here approaches it, so a
 * run that reaches it is a bug rather than a busy call.
 *
 * Raising it to silence a warning is the wrong move: the warning fires ONCE per
 * signal and then never again however far the count climbs, so a number chosen
 * to be quiet is a number that reports nothing.
 */
const SESSION_SIGNAL_MAX_LISTENERS = 50;

/**
 * A fresh session-lifetime `AbortController`, opted into Node's max-listeners
 * alarm.
 *
 * An `AbortSignal` is an EventTarget, and that warning covers `EventEmitter`
 * ONLY — 12 `addEventListener("abort", …)` on a signal produce no warning at
 * all, where 11 on an emitter produce one. This signal lives for the whole CALL
 * while almost everything attaching to it is per-TURN, so it is the one place
 * in the transport where a missing `removeEventListener` would accumulate
 * silently for the length of a conversation. Opting the signal in buys the same
 * alarm the emitters get for free.
 *
 * @internal
 */
export function createSessionSignal(): AbortController {
  const controller = new AbortController();
  setMaxListeners(SESSION_SIGNAL_MAX_LISTENERS, controller.signal);
  return controller;
}
