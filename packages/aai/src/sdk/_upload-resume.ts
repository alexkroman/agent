// Copyright 2026 the AAI authors. MIT license.
/**
 * Re-entering an upload after the far side went away.
 *
 * `_upload-retry.ts` is the other half and answers a different question. It asks
 * "was that answer a no, or a come back?" about ONE REQUEST, on a budget of four
 * attempts over ~4-11 seconds — which is sized for the failure a fan-out meets
 * while the agent is up, and is the whole of what an upload could survive.
 *
 * The failure it cannot cover is the ordinary event this platform is built out
 * of. **A sandbox is superseded on redeploy and reclaimed on idle, `aai dev`
 * restarts on every save, and a managed Postgres fails over.** Each is tens of
 * seconds in which every request fails, so every part in flight burns its budget
 * inside the outage, the first one to run out aborts its siblings, and a
 * recording that was 90% stored is thrown away in full. Nothing about that is
 * exotic — it is what "the server restarted" looks like from a browser.
 *
 * ## Why re-entering is cheap, which is what makes a long budget affordable
 *
 * A round here is not a request retried. It is `uploadInParts` called again with
 * `resume: true`: the claim 409s, which a resume reads as "this id is mine", the
 * `/info` read reports `UploadInfo.ranges`, and only the windows NOT covered are
 * sent. So the second round of a nearly finished upload moves almost nothing, and
 * what the budget protects is the FILE rather than one window of it.
 *
 * That is also why this loop lives above `uploadInParts` rather than inside it:
 * the unit being retried is the whole plan against a fresh view of what landed,
 * and a per-part retry cannot re-read that view.
 *
 * ## What it will NOT do
 *
 * Three refusals, because a loop that re-sends into a definite answer is a loop
 * the caller pays for four times:
 *
 * - **An abort.** The caller said stop, which is an answer. It is also how a
 *   PAUSE reaches this code (`aai-ui/_upload-session.ts`), so treating it as an
 *   outage would fight the person who pressed the button.
 * - **A refusal.** A 400 (the offset contradicts the declared total), a 409 on a
 *   first claim, a 413 (the file is over the agent's cap) are all answers that
 *   will be the same answer next time. Only {@link RETRYABLE_STATUS} — the same
 *   vocabulary one request re-sends on — comes back.
 * - **{@link UploadNotRecordedError}.** Every window arrived and the agent
 *   recorded none of them; see its own doc.
 *
 * A failure with NO status at all is the generous case and the one this module
 * exists for: nothing answered, so there is no far side saying no.
 */

import { RETRYABLE_STATUS } from "./_upload-retry.ts";
import { failureStatus } from "./_workflow-api-envelope.ts";
import { jitteredBackoff } from "./jittered-backoff.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { sleep } from "./sleep.ts";
import {
  UPLOAD_RESUME_ATTEMPTS,
  UPLOAD_RESUME_BASE_MS,
  UPLOAD_RESUME_MAX_MS,
} from "./upload-constants.ts";
import { UploadNotRecordedError } from "./workflow-upload-parts.ts";

/** How the caller of {@link withResumes} is told which kind of round this is. */
export type ResumeRound = {
  /**
   * What to pass as `resume`. The caller's own value on the first round — a fresh
   * id has nothing to resume, and claiming otherwise waives the refusal that makes
   * a caller-chosen id safe — and `true` on every round after it, since a round
   * that follows a failed one is a resume by definition.
   */
  resume: boolean | undefined;
  /** 1 for the first round. Reported so a caller can log or report the retry. */
  round: number;
};

/** Whether this failure is worth sending the missing windows again. See the module doc. */
export function isResumableFailure(err: unknown): boolean {
  if (err instanceof UploadNotRecordedError) return false;
  if (err instanceof Error && err.name === "AbortError") return false;
  const status = failureStatus(err);
  return status === undefined || RETRYABLE_STATUS.has(status);
}

/**
 * How long to wait before re-entering, doubling with jitter over the lower half.
 *
 * Jittered for the reason the per-request backoff is: two files being sent by two
 * tabs met the same outage, and a fixed schedule brings them back to a booting
 * agent in unison.
 */
function resumeDelay(round: number): number {
  return jitteredBackoff(round, {
    baseMs: UPLOAD_RESUME_BASE_MS,
    maxMs: UPLOAD_RESUME_MAX_MS,
  });
}

/**
 * Run an upload, re-entering it while the failure looks like an outage.
 *
 * Resolves with the first round that succeeds. Throws the LAST failure — not the
 * first — because the last one is the state the caller is actually in, and a
 * budget spent on a server that never came back should say what it said at the
 * end rather than what it said a minute ago.
 */
export async function withResumes<T>(
  attempt: (round: ResumeRound) => Promise<T>,
  opts: {
    /** The caller's own `resume`, used for the first round only. */
    resume: boolean | undefined;
    /** Rounds in total, the first included. Defaults to {@link UPLOAD_RESUME_ATTEMPTS}. */
    attempts?: number | undefined;
    /** The caller's signal. An abort ends the loop rather than being waited out. */
    signal?: AbortSignal | undefined;
  },
): Promise<T> {
  const attempts = opts.attempts ?? UPLOAD_RESUME_ATTEMPTS;
  for (let round = 1; ; round += 1) {
    try {
      return await attempt({ resume: round === 1 ? opts.resume : true, round });
    } catch (err: unknown) {
      if (round >= attempts || opts.signal?.aborted === true || !isResumableFailure(err)) throw err;
    }
    await sleep(resumeDelay(round), omitUndefined({ signal: opts.signal }));
    // `sleep` resolves rather than throwing on an abort, so the check is here —
    // the same shape `withRetries` uses, and for the same reason.
    opts.signal?.throwIfAborted();
  }
}
