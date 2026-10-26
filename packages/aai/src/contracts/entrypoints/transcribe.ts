// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `transcribe`.
 *
 * How a step turns a recording into text — the other direction of
 * `stepSpeak`, and the leg every workflow that handles audio starts with.
 *
 * Its own capability rather than part of `utils`, for the reason `uploads` is:
 * it is a promise about a PROVIDER's two endpoints, and what an author writes
 * against is the SHAPE of the job — that upload and submit are separate calls
 * because a retry must not repeat the file, that a poll answers with the
 * transcript rather than only a status, and that a refusal the provider decided
 * is not retryable. None of that moves when a zero-dependency helper next door
 * does, and all of it would break a template's flow if it did.
 *
 * `TranscribeError` is here rather than with `step-errors` on the same rule the
 * `StepGenerateError` split follows: the error is a value this surface
 * PRODUCES, and the fatal/retryable mapping that reads it is a different promise.
 *
 * Re-exported from `@alexkroman1/aai/step`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  // `transcribeUploadDurably`: the three-step durable form, its options, its
  // result and the poll budget it defaults to.
  type DurableTranscript,
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeSync,
  stepTranscribeUpload,
  TRANSCRIBE_API,
  TRANSCRIBE_DURABLY_STEPS,
  TRANSCRIBE_MODELS,
  TRANSCRIBE_POLL_EVERY_MS,
  TRANSCRIBE_POLL_MAX_MS,
  TRANSCRIBE_SYNC_MODEL,
  type TranscribeDurablyHost,
  type TranscribeDurablyOptions,
  TranscribeError,
  type TranscribeProgress,
  type TranscribeRequestOptions,
  type TranscribeSubmitOptions,
  type TranscribeSyncOptions,
  type Transcript,
  transcribeUploadDurably,
} from "../../sdk/step-barrel.ts";
