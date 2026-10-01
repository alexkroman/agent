// Copyright 2026 the AAI authors. MIT license.
/**
 * The two VALUE types the pipeline's turn-taking group is written in —
 * {@link TurnDetectionMode} and {@link UserTurnLimit} — and the run-time list
 * of the modes this release implements.
 *
 * The tuning itself is `agent-tuning.ts` (`PipelineTuning`'s three groups);
 * these are its leaf types, kept apart because each carries its own argument
 * (an OPEN vocabulary, a refined cap).
 */

/**
 * A turn-detection mode — `"auto"` or `"manual"`, the two this release
 * implements (see {@link TurnTakingTuning.detection}), or any other
 * string.
 *
 * OPEN so a mode a later release adds compiles against this one. The runtime
 * treats every value but `"manual"` as `"auto"`, and `aai build` / `aai dev`
 * warn about a value it does not know, rather than the type refusing it.
 *
 * The known modes are written INLINE rather than as an exported closed
 * `KnownTurnDetectionMode` half: inline they are only the autocomplete of an
 * open type, so a mode added here is a compatible change, where a published
 * closed union that grows is not assignable back to the one it grew from.
 *
 * @public
 */
export type TurnDetectionMode = "auto" | "manual" | (string & {});

/**
 * The modes this release implements, as a runtime list for the config warning.
 * Deliberately CLOSED and internal — the published {@link TurnDetectionMode} is
 * open, so nothing on the authoring surface names this set.
 *
 * @internal
 */
export const KNOWN_TURN_DETECTION_MODES = ["auto", "manual"] as const;

/**
 * A cap on ONE user turn — see {@link TurnTakingTuning.userTurnLimit}.
 *
 * End-of-turn detection is the STT provider's, and it is driven by SILENCE: a
 * caller who never pauses never ends a turn, so a monologue holds the floor
 * for as long as it runs and the agent cannot answer, redirect or hand off
 * until it stops. This is the bound on that. When the open utterance crosses
 * either cap the runtime asks the transcriber to END THE TURN NOW, exactly as
 * a pause would have — the words heard so far commit as the caller's turn, the
 * agent replies to them, and whatever the caller says next opens the next turn
 * — and a `userTurn.exceeded` event records that it happened.
 *
 * Both members are optional; set one or both. A limit that names neither is
 * refused at config time rather than accepted as a cap on nothing.
 *
 * Two things it is NOT: it is not a barge-in gate (`minBargeInWords` and
 * `interruptionMinDurationMs` decide whether the caller's speech interrupts a
 * reply; this decides when the caller's own turn is long enough), and it does
 * not discard anything the caller says — speech after the cut lands in the
 * turn that follows.
 *
 * The cut is made by the STT provider, so it needs one that can force an end of
 * turn mid-stream: the default `assemblyAIStt()` can. On a provider that
 * cannot, the event is still reported and the runtime logs once that the cap
 * is inert — the same treatment a provider that cannot move its endpointing
 * window gets.
 *
 * @public
 */
export interface UserTurnLimit {
  /**
   * End the caller's turn once this many words have been heard in it. A
   * positive integer; counted on the transcriber's interim transcript, so it
   * is what the transcriber HEARD, exactly as `minBargeInWords` is.
   */
  // `| undefined` on both, unlike the scalar knobs beside this interface: the
  // object crosses the config boundary as a whole, and under
  // `exactOptionalPropertyTypes` the schema-inferred `{ maxWords?: number |
  // undefined }` is not assignable to a member typed without it.
  maxWords?: number | undefined;
  /**
   * End the caller's turn once it has run this long, in ms — measured from the
   * first word the transcriber reported for it. A positive integer.
   */
  maxDurationMs?: number | undefined;
}
