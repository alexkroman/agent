// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `step-errors`.
 *
 * The failure a `"use step"` body throws, classified so the Workflow DevKit
 * retries what is worth retrying and stops on what is not. Its own capability
 * rather than part of `utils` because it is the one authoring surface that
 * reaches the DevKit's own error classes — which is exactly why it is its own
 * subpath too.
 *
 * `throwFfmpegStepError` is the third arm of the same decision, for the one
 * failure a step body cannot classify with `throwStepError` alone: an ffmpeg run
 * that TIMED OUT or was aborted is worth another attempt, and a file ffmpeg
 * refused is not, however many times it is replayed. It recognises the failure
 * STRUCTURALLY rather than with `instanceof`, and that is forced rather than
 * stylistic — naming `FfmpegError` here would put a `node:child_process` import
 * at MODULE scope of a `workflows/*.ts` bundle, which is a `node:vm` Script with
 * no `require`, so every run would die at replay. Two templates each carried a
 * whole one-function file to keep that reference on the far side of a boundary
 * only a step body crosses; the capability owning the decision is what retires
 * them.
 *
 * The six `*Classified` callers are the SDK's own step calls with exactly that
 * `.catch` already attached — `stepGenerate`, `stepGenerateJson` and the four
 * transcription calls. They are on the contract rather than left as a recipe for
 * the same reason: every project that called one wrote the identical
 * `.catch(throwStepError)` beside it, and the one that forgot got the DevKit's
 * one-second default instead of the gateway's own `Retry-After`. None of the six
 * takes a `message`, which is the boundary — a caller with a label worth
 * attaching writes the explicit `.catch((err) => throwStepError(err, …))` and is
 * back on the three primitives above.
 *
 * Re-exported from `@alexkroman1/aai/step-errors`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  stepFetchOk,
  stepGenerateClassified,
  stepGenerateJsonClassified,
  stepTranscribePollClassified,
  stepTranscribeSubmitClassified,
  stepTranscribeSyncClassified,
  stepTranscribeUploadClassified,
  throwFatalStepError,
  throwFfmpegStepError,
  throwStepError,
  toStepError,
} from "../../sdk/step-errors.ts";
