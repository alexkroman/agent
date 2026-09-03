// Copyright 2026 the AAI authors. MIT license.
/**
 * How long a PARKED delivery is asked to wait, and what is said about it.
 *
 * Split from `workflow-queue-dispatch.ts` when the curve below took that file
 * past its length cap, and the seam is a real one: the door decides WHETHER a
 * delivery may walk (the queue-name grammar, the gate, the in-flight set), and
 * this decides what to answer a delivery that may not. They are edited for
 * unrelated reasons — one moves when the DevKit's topic grammar or the platform's
 * bearer moves, the other when a measurement about step DURATIONS comes in, which
 * is what both of this module's revisions were.
 *
 * The two halves here belong together and not apart, because the log line and the
 * wire field are the SAME decision: one park is one line and one reschedule, so a
 * cadence that fixed only the retry would leave the line rate where it was, and a
 * second computation of the curve is how the two would come to disagree.
 * {@link reportPark} therefore ANSWERS the delay it reported.
 *
 * @module
 */

// Type-only, so this module stays a leaf: it REPORTS a park and never resolves a
// logger of its own.
import type { Logger } from "./runtime-config.ts";

/**
 * The FLOOR of the park delay — see {@link queueDeliveryBusySeconds}.
 *
 * Short, because the case this end of the curve serves is two deliveries
 * briefly RACING, where the loser should come back promptly: the walk it
 * deferred to is seconds old and probably about to answer. The only thing the
 * delay costs is how long a message sits behind a walk that has ALREADY ended in
 * a way this process could not observe — and there is no such way while the
 * process lives: the entry is dropped in a `finally`, and the one outcome that
 * skips a `finally` is the process dying, which takes the whole set with it. So
 * the number is not a liveness bound; it is the poll interval of an honest
 * "still busy".
 *
 * It used to be the WHOLE answer, at every elapsed time, and that is the defect
 * {@link queueDeliveryBusySeconds} exists to fix.
 *
 * @internal
 */
export const QUEUE_DELIVERY_BUSY_SECONDS = 5;

/**
 * The CEILING of the park delay, and the four numbers it is chosen against.
 *
 * A park is not free — it is a full queue round trip on the platform side
 * (claim, forward into the sandbox, read the answer, reschedule) and one of that
 * replica's `WORKFLOW_QUEUE_DELIVER_CONCURRENCY` delivery slots for the length
 * of the hop — so the delay wants to be as long as the system can afford. What
 * bounds it is how long a message may sit behind a walk that really DID die with
 * its process, since a dead process's `walking` map dies with it and the next
 * delivery walks the run:
 *
 * - **`QUEUE_DELIVERY_TIMEOUT_MS` (60s)** — the platform already holds one
 *   delivery open this long, so a park that defers by twice that is not the
 *   slowest thing in the path.
 * - **`RETRY_BACKOFF_MS`'s longest entry (300s,
 *   `aai-server/workflow-queue-store.ts`)** — what the queue itself waits before
 *   re-presenting a message whose delivery FAILED. A park is a healthier state
 *   than a failure, so its delay stays under that.
 * - **`STALL_GRACE_MS` (600s, `aai-server/workflow-queue-reconcile.ts`)** — the
 *   reconcile pass re-enqueues a run that is unfinished with NOTHING scheduled.
 *   A parked message IS scheduled, so reconcile deliberately leaves it alone,
 *   which makes this delay the only recovery path for a walk that died after
 *   parking. At 120s the parked message beats the reconcile pass by 5x.
 * - **`TRANSCRIBE_UPLOAD_TIMEOUT_MS` (1800s, `@alexkroman1/aai/step`)** — the
 *   deadline of the step that motivated all of this. 120s is 1/15th of it, so a
 *   run whose walk really has died is re-walked long before the step it was
 *   inside would have given up.
 *
 * It is NOT chosen against `QUEUE_CLAIM_STALE_MS`, which is also 120_000 and is
 * a coincidence worth naming because a reader will notice: that one is how long
 * a claim may sit with `locked_at` SET before another replica may steal it, and
 * a park explicitly clears `locked_at`. The stale-reclaim path cannot apply to a
 * parked message at all.
 *
 * @internal
 */
export const QUEUE_DELIVERY_BUSY_MAX_SECONDS = 120;

/**
 * How much of the elapsed walk one park defers by: one EIGHTH.
 *
 * A fraction rather than a table, because it is the only form that makes the
 * park COUNT logarithmic in the walk's length — each park pushes the next one
 * 12.5% further out, so the delay grows geometrically (ratio 1.125) and a walk
 * twice as long costs six more lines rather than twice as many. A table would
 * have to guess the durations in advance, and the measured spread on identical
 * bytes is 4.5x (3m21s against 15m00s).
 *
 * An eighth specifically, because it has to be small enough that the FIRST park
 * is still fast. A delivery is only ever re-presented after
 * `QUEUE_DELIVERY_TIMEOUT_MS` has closed the previous one's response, so the
 * first park of any run lands ~61s into its walk and asks for 8s — barely more
 * than the flat 5s this replaced. The floor therefore binds only below 40s of
 * walk, which is exactly the brief-race window
 * {@link QUEUE_DELIVERY_BUSY_SECONDS} is for.
 *
 * @internal
 */
export const QUEUE_DELIVERY_BUSY_DIVISOR = 8;

/**
 * When a park stops being an ordinary slow step and becomes something an
 * operator wants to know about — see {@link reportPark}.
 *
 * Five minutes, taken from the measurement rather than from taste: of the two
 * healthy runs that prompted the report, the 3m21s one nobody minded and the
 * 15m00s one its author cancelled 13 seconds before it landed. The threshold
 * sits between them.
 *
 * @internal
 */
export const QUEUE_DELIVERY_LONG_WALK_SECONDS = 300;

/**
 * How long the platform is asked to hold a message whose run is ALREADY being
 * walked here — PROPORTIONATE to how long that walk has been running.
 *
 * ## A flat delay is a flat LOOP, which is what shipped
 *
 * The flat {@link QUEUE_DELIVERY_BUSY_SECONDS} was argued as self-limiting, and
 * it is — of the FIRST park only. A delivery is re-presented after the 60s
 * ceiling closes the previous response, so a healthy run parks zero times and a
 * long one parks at ~61s. After that it is a 5s loop for the whole remaining
 * walk, and each turn of it is a full queue round trip doing no work: claim,
 * forward into the sandbox, read `{"timeoutSeconds": 5}`, reschedule. Measured
 * in production on a 660 MiB provider upload — `walkingForSeconds: 285` on a
 * line that was one of ~45 already, continuing at 12 a minute, and a 15-minute
 * upload produces ~170.
 *
 * The curve replaces both costs at once, because the log line and the retry are
 * the same event: **13 parks to reach 285s and 24 to reach 900s**, i.e. one line
 * every ~2 minutes at the tail rather than five a minute.
 *
 * ## The shape
 *
 * `clamp(elapsed / 8, 5, 120)`, and each of the three numbers is argued at its
 * own constant. Rounded to a whole second because the wire field is seconds and
 * the platform's own store rounds to milliseconds anyway.
 *
 * @internal
 */
export function queueDeliveryBusySeconds(walkingForSeconds: number): number {
  // A non-finite elapsed cannot arise from `Date.now()` arithmetic, and the
  // guard is here anyway because of what it would cost: `NaN` reaches the wire
  // as `null` (JSON has no NaN), the platform's `parkedFor` reads a body with no
  // finite `timeoutSeconds` as COMPLETED, and the run is silently stranded. The
  // floor is the safe answer for the same reason it is the floor.
  if (!Number.isFinite(walkingForSeconds)) return QUEUE_DELIVERY_BUSY_SECONDS;
  // `max(0, …)` before the divide, so a clock that stepped backwards asks for
  // the floor rather than a negative the platform would clamp for us.
  const share = Math.round(Math.max(0, walkingForSeconds) / QUEUE_DELIVERY_BUSY_DIVISOR);
  return Math.min(QUEUE_DELIVERY_BUSY_MAX_SECONDS, Math.max(QUEUE_DELIVERY_BUSY_SECONDS, share));
}

/**
 * Say that a delivery was parked, and how long the walk it deferred to has been
 * running.
 *
 * ## A park used to emit NOTHING, and that cost fifteen minutes
 *
 * The park is correct and it is silent, and silence is what a wedge looks like.
 * Measured on the run that prompted this, a 660.8 MB upload to a provider's
 * async API: the step logged one line as it started (`Uploading … to the async
 * API.`) and the next thing anybody saw was the run finishing **3m21s** later.
 * The same file on the run before it took **15m00s** — attempts `1`, no retry,
 * no divergence, nothing wrong — and its author waited out fourteen of those
 * minutes, concluded the run was wedged, and cancelled it 13 seconds before the
 * upload landed. Both runs were healthy. Neither was distinguishable from a
 * hang at any level anybody looked at: not the guest log, not the run's event
 * stream, not the journal.
 *
 * So the state a reader cannot see is not "parked" — it is **"parked, and for
 * how long"**. A park at 61s is an ordinary slow step; a park at 900s is a step
 * an operator wants to know about, and the only difference between the two log
 * lines is a number this map holds.
 *
 * ## The LINE RATE is the retry rate, so the curve fixes both
 *
 * This used to say a line per park was "self-limiting by construction", on the
 * ground that the first park of any run lands ~61s into its walk and a healthy
 * run parks zero times. Both halves are true and the conclusion was wrong: after
 * the first park the flat 5s delay made this a 5s LOOP, which the same paragraph
 * admitted in the next breath ("one line per `QUEUE_DELIVERY_BUSY_SECONDS` for as
 * long as a walk runs long"). Production, on a 660 MiB upload:
 * `walkingForSeconds: 285` with ~45 lines already behind it and 12 a minute
 * continuing.
 *
 * There is nothing to fix separately, because the line and the retry are the SAME
 * event: {@link queueDeliveryBusySeconds} makes the delay proportional to the
 * elapsed walk, and the line rate falls with it — 13 lines to reach 285s and 24
 * to reach 900s, one every ~2 minutes at the tail.
 *
 * ## The LEVEL is a pure function of the elapsed walk
 *
 * A park at 61s is an ordinary slow step and a park at 900s is one an operator
 * wants to know about, so they are not the same line: `info` under
 * {@link QUEUE_DELIVERY_LONG_WALK_SECONDS} and `warn` above it. Neither is
 * silenced — `consoleLogger` gates only `debug`, so an `info` still reaches the
 * Modal log, and the elapsed number is the whole value of the line either way.
 *
 * A function of the elapsed time rather than "the first park is different",
 * deliberately: that would need a per-run flag beside the timestamp, and a reader
 * tailing warns wants the rate to FALL as a walk goes on — which is the signal
 * that nothing new is wrong — rather than one line and then nothing.
 *
 * Answers the retry it reported, so the line and the wire body cannot disagree
 * about the number. Two computations of one curve is how they would.
 *
 * @internal
 */
export function reportPark(logger: Logger | undefined, runId: string, startedAt: number): number {
  // SECONDS, because the interesting magnitudes here are minutes and the reader
  // is comparing against a 60s ceiling and a 30-minute step deadline.
  const walkingForSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const retryInSeconds = queueDeliveryBusySeconds(walkingForSeconds);
  const fields = { runId, walkingForSeconds, retryInSeconds };
  // Absent is not a silent skip — `handleWorkflowRequest` defaults it to
  // `consoleLogger`, and the only callers with none are specs. Branched rather
  // than selecting the method, because a `Logger` is a record of functions and a
  // plucked method loses its receiver.
  if (walkingForSeconds >= QUEUE_DELIVERY_LONG_WALK_SECONDS) {
    logger?.warn(LONG_WALK_PARK_MESSAGE, fields);
  } else {
    logger?.info(PARK_MESSAGE, fields);
  }
  return retryInSeconds;
}

/**
 * The two park lines, sharing a prefix on purpose: one `grep` for
 * `Workflow delivery parked` finds a walk at either magnitude, which a reader
 * chasing a run cannot know in advance.
 */
const PARK_MESSAGE = "Workflow delivery parked: run is still being walked";
const LONG_WALK_PARK_MESSAGE = `Workflow delivery parked: run has been walked for over ${
  QUEUE_DELIVERY_LONG_WALK_SECONDS / 60
} minutes — healthy for a large upload, and worth checking otherwise`;
