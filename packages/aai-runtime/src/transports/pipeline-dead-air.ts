// Copyright 2026 the AAI authors. MIT license.
/**
 * The dead-air cover: the filler a caller hears while nothing else arrives.
 *
 * Split out of `pipeline-stream-parts.ts` for the reason `pipeline-llm-trace.ts`
 * was split out of `pipeline-llm-stream.ts` — that file sat at 495 of the
 * 500-line source cap — and along the seam a reader already uses. What stays
 * there is the interpretation of stream PARTS; this is about the parts that
 * never came.
 *
 * The seam is narrow because the cover's whole outward effect is one sentence
 * spoken: `speak` emits a filler, `spokeText` says whether the model has
 * produced anything this turn (which decides WHICH phrase fits), and the two
 * predicates say when a gap is already filled by somebody else. Nothing here
 * touches the turn beyond its own timer — it cancels no TTS, flushes nothing,
 * and aborts nothing. The invariant that a filler may not open the barge-in
 * gate belongs to the CALLER, which emits these with `record: false`.
 */

import {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEAD_AIR_TOOL_COVER_MS,
} from "@alexkroman1/aai/host-internal";
import { createRestartableTimer } from "../_timer.ts";
import type { Logger } from "../runtime-config.ts";

/** What the cover needs from the turn it is covering. */
export type DeadAirCoverDeps = {
  /** The author's window; `0` disables the cover outright. */
  coverMs: number;
  /** The turn's signal — the cover dies with the turn, not at `dispose()`. */
  signal?: AbortSignal | undefined;
  /** The caller is talking, so the gap is already filled. */
  callerSpeaking: () => boolean;
  /** A tool is speaking its own declared lines, likewise. */
  toolCovering: () => boolean;
  /** Speak one filler. Audible, never recorded — see the module doc. */
  speak: (phrase: string) => void;
  /** Has the model produced text this turn? Decides which phrase fits. */
  spokeText: () => boolean;
  log: Logger;
  sid: string;
};

/** The cover's controls, as the stream-part handler drives them. */
export type DeadAirCover = {
  /** Open a cover window, defaulting to this turn's current base. */
  arm: (baseMs?: number) => void;
  /** Cancel the pending cover AND forget its deadline. */
  clear: () => void;
  /** A `tool-call` part arrived — the turn is the silent kind. */
  onToolCall: () => void;
  /** Drop the abort listener and the pending cover. */
  dispose: () => void;
};

/**
 * Arm the cover for one turn.
 *
 * ARMED AT CONSTRUCTION, which is the property to preserve: `arm()` used to be
 * reachable only from the `tool-call` part and from the timer itself, leaving
 * the window between the committed user turn and the model's FIRST stream part
 * uncovered and unbounded. A slow first token, or a long reasoning phase (which
 * emits reasoning deltas and no text), is then pure dead air for however long it
 * lasts. Measured on tau2-bench retail with gpt-5.5 through the gateway: 31.4s
 * of silence after a committed user turn, ended only by the first tool call
 * finally triggering that filler, while the client kept streaming mic audio into
 * a session that looked healthy from both ends. The handler is constructed as the
 * turn's stream opens — `startLlmStream` is synchronous, so this runs before the
 * request is even accepted — and the first `text-delta` clears the timer, so a
 * turn that answers promptly pays nothing.
 */
export function createDeadAirCover(deps: DeadAirCoverDeps): DeadAirCover {
  const { coverMs, signal, log, sid } = deps;
  // Two separate counts. `coverCount` is every filler spoken this turn and
  // drives the backoff; `phraseCount` is only the DEAD_AIR_COVER_PHRASES ones
  // and picks the next phrase. Sharing one counter meant the opening phrase
  // consumed a phrase slot, so the caller heard the opening filler and then
  // skipped straight to the second cover phrase.
  let coverCount = 0;
  let phraseCount = 0;
  /** The window armed for the cover currently pending — see `arm`. */
  let armedCoverMs = 0;
  /**
   * CONSECUTIVE deferrals of the pending cover, reset when one is spoken.
   *
   * Consecutive rather than cumulative because what it is for is spotting a
   * STARVED cover: a predicate stuck true re-arms forever, and the count is the
   * only thing that separates "this gap keeps getting filled by the caller"
   * from "this cover will never fire again".
   */
  let deferrals = 0;
  /**
   * When the pending cover is due (epoch ms), 0 when none is armed.
   *
   * The tool-call branch needs to know whether its short window would fire
   * SOONER than whatever is counting down, and `RestartableTimer` exposes only
   * `pending()`. Without this the turn-open window keeps `pending()` true for
   * the whole turn and the short window is never installed — which is exactly
   * the silent no-op the first version of this shipped as.
   */
  let dueAt = 0;
  /**
   * Base for this turn's cover cycle. Drops to the tool window once a
   * `tool-call` part has shown the turn is the silent kind — STICKY, because
   * the timer re-arms from its own callback and would otherwise revert to the
   * long base after the first filler.
   */
  let base = coverMs;

  const deadAir = createRestartableTimer((): void => {
    // Fire-time re-check, matching the transport's other timers: the abort
    // listener below clears the timer, but a callback already dispatched (or
    // an abort that raced the arm) must still no-op.
    if (signal?.aborted) return;
    // The gap is already filled — by the caller talking, or by a tool speaking
    // its own declared lines. Re-arm and cover the NEXT gap rather than
    // speaking across this one: the cover exists for silence, and this is not
    // silence.
    let deferredBy: "caller-speaking" | "tool-covering" | undefined;
    if (deps.callerSpeaking()) deferredBy = "caller-speaking";
    else if (deps.toolCovering()) deferredBy = "tool-covering";
    if (deferredBy !== undefined) {
      deferrals += 1;
      // LOGGED for the same reason the firing below is, and the blind spot was
      // the same one branch over. A deferral speaks no words, records no
      // history and leaves no client frame, so from outside a STARVED cover and
      // a cover that was never armed are the identical observation: nothing.
      // Measured on a graded retail run (allaai-c5, 2026-09-13), 19 of 45
      // first-token stalls over 5s — up to 15.2s of silence each — produced no
      // cover line at all, and the log could not say which of the two it was,
      // so the investigation ended in a hypothesis instead of a cause.
      log.info("Pipeline dead-air cover deferred", {
        sid,
        reason: deferredBy,
        deferrals,
        waitedMs: armedCoverMs,
      });
      arm();
      return;
    }
    // Nothing has reached the caller yet, so this is the turn's OPENING gap
    // rather than a gap between things the model said, and it needs its own
    // phrase — the cycle opens with "I'm still checking on this.", which
    // implies work already narrated and would be the very first words of the
    // turn. `coverCount === 0` is the test rather than a flag of its own: only
    // the FIRST filler of a turn can precede any speech.
    const opening = !deps.spokeText() && coverCount === 0;
    let phrase = DEAD_AIR_OPENING_PHRASE;
    if (!opening) {
      phrase = DEAD_AIR_COVER_PHRASES[phraseCount % DEAD_AIR_COVER_PHRASES.length] ?? "";
      phraseCount += 1;
    }
    // Counted either way: it drives the backoff, so an opening filler must
    // still push the next one out. Left uncounted, the next cover came one base
    // window (2s, the base at the time) after the opening phrase — net of its
    // own ~1.3s of audio, under a second of silence between two fillers, which
    // reads as chatter at the very start of the wait.
    coverCount += 1;
    // LOGGED, because until it was, nothing anywhere could confirm a filler
    // played. The phrases are emitted `record: false`, so they never reach
    // `onDelta`, never enter history, and never appear in a client's committed
    // transcript — which meant a harness trajectory (tau2's included) could
    // show a covered gap and an uncovered one identically. A `deadAirCoverMs`
    // experiment was run on 2026-09-09 and could not be evaluated for exactly
    // this reason: the response rate did not move and there was no way to tell
    // whether cover had fired late or not at all. One line at info closes that.
    //
    // `waitedMs` is the value that was actually armed for this filler, not the
    // configured `coverMs` — the window doubles per filler — so a reader can
    // see the backoff rather than infer it.
    log.info("Pipeline dead-air cover", {
      sid,
      phrase,
      opening,
      coverCount,
      waitedMs: armedCoverMs,
    });
    deferrals = 0;
    deps.speak(phrase);
    arm();
  });

  function clear(): void {
    dueAt = 0;
    deadAir.clear();
  }

  /**
   * Open a cover window. The wait doubles per filler already spoken, so a short
   * chain does not chatter — then flattens at {@link DEAD_AIR_COVER_MAX_MS} so a
   * long one keeps a steady heartbeat instead of drifting back into the silence
   * this exists to cover.
   *
   * The ceiling is `max(DEAD_AIR_COVER_MAX_MS, coverMs)` rather than the
   * constant, because the base is the author's: a `deadAirCoverMs` above 8000
   * would otherwise be clamped BELOW its own base, so an agent asking for one
   * filler every 20s would get the first at 8s.
   */
  function arm(baseMs: number = base): void {
    if (coverMs <= 0 || signal?.aborted) return;
    // Remembered rather than recomputed at the log site: `coverCount` has
    // already been incremented by then, so a recomputation would report the
    // NEXT window as the one that elapsed.
    armedCoverMs = Math.min(baseMs * 2 ** coverCount, Math.max(DEAD_AIR_COVER_MAX_MS, coverMs));
    dueAt = Date.now() + armedCoverMs;
    deadAir.arm(armedCoverMs);
  }

  // Kill the armed cover the moment the turn aborts rather than at dispose(),
  // which a tool execution that ignores its abort signal defers for seconds.
  const onAbort = (): void => clear();
  signal?.addEventListener("abort", onAbort, { once: true });
  arm();

  return {
    arm,
    clear,
    onToolCall(): void {
      // Armed on the SHORT tool window: a `tool-call` part is true of exactly
      // the turns that go quiet and arrives early enough to act on, where the
      // turn-open window is true of every turn and can only find the silent
      // ones by waiting. See DEAD_AIR_TOOL_COVER_MS.
      //
      // A tool call may only pull the deadline IN, never push it out. `arm`
      // clears and re-sets, so an unconditional call here RESTARTS the
      // countdown on every tool call — measuring the deadline from the last
      // call rather than from the last thing the caller HEARD — and a chain
      // whose calls each return inside the window would reset it every time,
      // so the cover would never fire at all. Measured on tau2-bench retail:
      // the cover fired ZERO times in two tasks while the caller sat through
      // 13.0s and 6.0s of dead air mid-authentication and re-prompted with
      // "Hello?"; across the run, dropped caller turns had gone from 0 in 130
      // to 6.4% of 499 when the prompt's holding-line mandate was retired in
      // favour of this mechanism — which was not covering the case.
      //
      // The re-arm is still needed and still happens: a `text-delta` CLEARS
      // the timer (the caller heard something, so the clock restarts from
      // there), which leaves `pending()` false and lets the next tool call
      // re-open the window.
      const toolBase = Math.min(DEAD_AIR_TOOL_COVER_MS, coverMs);
      base = toolBase;
      if (!deadAir.pending() || Date.now() + toolBase < dueAt) arm(toolBase);
    },
    dispose(): void {
      signal?.removeEventListener("abort", onAbort);
      clear();
    },
  };
}
