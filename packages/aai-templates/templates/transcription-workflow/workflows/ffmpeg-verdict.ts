// Copyright 2026 the AAI authors. MIT license.
/**
 * What to do about a failed conversion: retry it, or stop.
 *
 * One function, and the interesting thing about this file is why it is a file.
 * It was in `normalize.ts` beside the step that calls it, which reads better and
 * does not build: **the workflow bundle keeps everything a `workflows/` module
 * holds at MODULE scope.** Only a `"use step"` body is removed — the whole point
 * of the transform is to leave a stub that enqueues — so an unused import goes
 * with the body, and an import a surviving function still names does NOT.
 *
 * `classifyFfmpeg` names `isFfmpegError`. That one reference kept
 * `@alexkroman1/aai/ffmpeg` in a bundle that is compiled in a `node:vm` Script
 * with no `require` in its context, and the SDK module spawns a child process:
 * every run of this workflow died at replay with `ReferenceError: require is
 * not defined`, pointing at a line of generated code inside the SDK. The step
 * was never the problem — it runs in an ordinary Node process, where
 * `child_process` is exactly what it should be using.
 *
 * So: the ffmpeg vocabulary stays on the far side of a module boundary that only
 * a step body crosses. `normalize.ts` imports this, uses it inside its step, and
 * the transform drops the import along with the body it belongs to. `aai build`
 * fails now if that stops being true.
 */

import { isFfmpegError } from "@alexkroman1/aai/ffmpeg";
import { throwFatalStepError, throwStepError } from "@alexkroman1/aai/step-errors";

/**
 * Turn an ffmpeg failure into the DevKit's verdict.
 *
 * The whole reason `FfmpegError.kind` exists, used the way it was meant to be:
 * an `exit` is ffmpeg having read the file and refused it, so every retry
 * re-reads the same bytes and reaches the same conclusion while burning the
 * budget a real transient needs. A `timeout` or an `aborted` is worth another
 * attempt, and a `missing-binary` is `aai dev` on a laptop with no ffmpeg —
 * fatal, and already carrying the install instructions in its message.
 *
 * **The retryable arm goes through `throwStepError` even though it classifies
 * nothing**, and that is deliberate rather than a leftover. `toStepError` reaches
 * a verdict from a `Response` or from an SDK error that already carries one; an
 * `FfmpegError` is neither, so it is rethrown UNCHANGED — which the DevKit treats
 * as retryable by default, the outcome this arm wants. Writing
 * `new RetryableError(...)` here instead would replace ffmpeg's own message and
 * its `argv` with a sentence, and the argv is the thing you paste into a shell.
 * So the call reads as the decision it is: everything this function does not
 * declare terminal keeps its retries.
 *
 * Exported for its spec. It is the one decision in the conversion a unit test can
 * reach — everything around it spawns a subprocess — and it is also the one worth
 * reaching: getting it backwards means either five re-reads of a corrupt file or
 * no second attempt at a conversion that was merely slow.
 */
export function classifyFfmpeg(err: unknown): never {
  if (isFfmpegError(err) && (err.kind === "timeout" || err.kind === "aborted")) {
    return throwStepError(err);
  }
  return throwFatalStepError(err);
}
