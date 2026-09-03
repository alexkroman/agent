// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `step-errors`.
 *
 * The failure a step body throws, classified so the engine retries what is worth
 * retrying and stops on what is not.
 *
 * It OWNS the two classes now. They were the Workflow DevKit's
 * (`FatalError`/`RetryableError` from `@workflow/errors`), which is why this was
 * once described as "the one authoring surface that reaches the DevKit's own
 * error classes"; the engine that reads a verdict lives in this repo, so the
 * vocabulary it reads does too. `DEFAULT_RETRY_DELAY_MS` is on the contract
 * because a caller deciding whether to pass the far side's own `Retry-After`
 * needs to know what omitting it MEANS — one second, which is what a rate limit
 * punishes.
 *
 * `throwFfmpegStepError` is the third arm of the same decision, for the one
 * failure a step body cannot classify with `throwStepError` alone: an ffmpeg run
 * that TIMED OUT or was aborted is worth another attempt, and a file ffmpeg
 * refused is not, however many times it is replayed. It recognises the failure
 * STRUCTURALLY rather than with `instanceof`, and that is forced rather than
 * stylistic — naming `FfmpegError` here would reach `host/ffmpeg.ts` and its
 * `node:child_process` from `sdk/`, and `sdk/tsconfig.json` compiles with
 * `types: []` precisely so that cannot happen. Two templates each carried a
 * whole one-function file to keep that reference on the far side of a boundary
 * only a step body crosses; the capability owning the decision is what retires
 * them.
 *
 * The seven `*Classified` callers are the SDK's own step calls with exactly that
 * `.catch` already attached — `stepGenerate`, `stepGenerateJson`, the four
 * transcription calls, and `sendToChannel`. They are on the contract rather
 * than left as a recipe for
 * the same reason: every project that called one wrote the identical
 * `.catch(throwStepError)` beside it, and the one that forgot got the
 * one-second default instead of the gateway's own `Retry-After`. None of the seven
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
  DEFAULT_RETRY_DELAY_MS,
  FatalError,
  RetryableError,
  type RetryableErrorOptions,
  sendToChannelClassified,
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
