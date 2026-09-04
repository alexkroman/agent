// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate a step passes through when it needs the WHOLE file.
 *
 * `UploadInfo.size` is the contiguous readable PREFIX of an upload, not its
 * final length, and `step-uploads.ts` says so in every paragraph that mentions
 * it — *"**`complete` is the field to branch on, never `size`**"*. The rule was
 * addressed to a body polling a streamed upload, and the readers that need the
 * opposite thing — everything that consumes a file END TO END — were left to
 * remember it. They did not:
 *
 * - `stepTranscribeUpload` captured `stored.size` and streamed `[0, size)` to the
 *   provider. Against a still-arriving recording that uploads whatever had
 *   landed, gets a URL for it, and transcribes a TRUNCATED file. The body is an
 *   async iterable so nothing sends a `content-length` the far side could check;
 *   there is no error anywhere and the transcript reads as the whole call.
 * - `readUploadToFile` defaulted its `size` to the same prefix, so the byte count
 *   it returns — documented as the way *"a caller polling a streamed upload"*
 *   learns the store came back short — could never be short. It equalled the
 *   prefix by construction.
 *
 * Both are the worst failure shape available: a **plausible wrong answer** rather
 * than a failure. So the check belongs in one place both of them go through, which
 * is what this module is. That is the same reasoning `_transcribe-shared.ts`
 * applies to a credential and a deadline — the things every caller gets wrong live
 * in one seam, not in a sentence each caller has to have read.
 *
 * ## Why it REFUSES rather than waiting
 *
 * Waiting is the tempting answer and it is wrong at this layer, for two reasons
 * that are both properties of the engine rather than opinions:
 *
 * - **A step may not wait.** `ctx.sleep` and `ctx.waitFor` reached inside a step
 *   fail the run (`workflow-replay-wait.ts`), so the only wait available here is
 *   a plain timer holding a worker open and journaling nothing — which is the
 *   shape the durable engine exists to replace.
 * - **An upload that died stays incomplete forever.** The `stream.ts` template
 *   bounds exactly that with an idle-poll budget, and it can only do so because
 *   it polls from the BODY. From inside a step there is nothing to bound.
 *
 * Polling from the body is the supported shape, it already exists, and the
 * refusal's own message names it.
 *
 * @module step-uploads-complete
 */

import { stepUploadInfo, type UploadInfo } from "./step-uploads.ts";

/**
 * An upload that is still arriving, where the whole file was needed.
 *
 * `retryable: false`, and that is the interesting field: `toStepError`
 * (`@alexkroman1/aai/step-errors`) recognises a carried verdict STRUCTURALLY, so
 * a step ending `.catch(throwStepError)` turns this into a `FatalError` and the
 * run stops on the spot with this sentence. Which is right — the default retry
 * cadence is ~0 ms, so three attempts would spend the whole budget of the most
 * expensive step in the flow inside a millisecond and still find the upload
 * unfinished. What has to change is the run's ORDER, and no number of attempts
 * changes that.
 *
 * @public
 */
export class UploadIncompleteError extends Error {
  /** Whether asking again could plausibly answer differently. It cannot. */
  readonly retryable = false;
  /** Bytes readable when the check ran — the PREFIX, never a total. */
  readonly stored: number;

  constructor(message: string, stored: number) {
    super(message);
    this.name = "UploadIncompleteError";
    this.stored = stored;
  }
}

/**
 * One upload's metadata, refused unless every byte is in.
 *
 * The read for a step that consumes a file END TO END — an upload to a provider,
 * a copy to local disk, a length a segment plan is computed from. A step that
 * works on a WINDOW wants {@link stepUploadInfo} and clamping, which is what
 * `stepReadUpload` already does.
 *
 * @example
 * ```ts
 * import { stepRequireCompleteUpload } from "@alexkroman1/aai/step";
 *
 * export async function wholeFileSize(uploadId: string): Promise<number> {
 *   const stored = await stepRequireCompleteUpload(uploadId);
 *   return stored.size;
 * }
 * ```
 *
 * @throws {UploadIncompleteError} when the upload is still arriving — see this
 *   module's doc for why that is a refusal rather than a wait.
 * @throws when the id names no upload, exactly as {@link stepUploadInfo} does.
 * @public
 */
export async function stepRequireCompleteUpload(id: string): Promise<UploadInfo> {
  const info = await stepUploadInfo(id);
  if (!info.complete) {
    throw new UploadIncompleteError(
      `Upload ${id} is still arriving — ${info.size} byte(s) readable so far, which is the ` +
        "contiguous PREFIX of the file and not its length. Working on it now would produce a " +
        "result for part of the recording and report success. Wait for the upload to finish " +
        "before starting this run, or poll `stepUploadInfo` in a step and " +
        "`ctx.sleep` between polls, working only on the windows that have landed.",
      info.size,
    );
  }
  return info;
}
