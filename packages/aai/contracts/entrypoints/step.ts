// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `step`.
 *
 * The vocabulary a step is written against — `@alexkroman1/aai/step`
 * whole, minus the two neighbouring capabilities that own their own halves of it
 * (`transcribe` for the four transcription entry points and their types,
 * `uploads` for the byte round trip).
 *
 * Its own capability rather than half of `utils` because it is its own AUDIENCE:
 * a step body has no `ToolContext`, no session and no root barrel — it is
 * bundled separately — so what it may name is a different question from what a
 * tool body may name, and a signature change here breaks a different set of
 * files. That split is the whole reason the subpath exists; see
 * `sdk/step-barrel.ts`.
 *
 * `stepFetch`/`multipartBody`/`StepTransportError` are the ones an author must
 * not be steered off: a step that reaches for `fetch` instead speaks HTTP/2, and
 * a fan-out over one connection is where a capacity limit stops being a status a
 * retry policy can read. See `sdk/step-fetch.ts`.
 *
 * `stepSpeak` and `encodeWav`/`pcmDurationMs` are the reason to read this
 * contract beside `uploads`: a step that SPEAKS is useless without somewhere to
 * put what it made. `stepSpeak` is a slot the way `stepFetch` is — the
 * synthesizer needs a WebSocket client, which this subpath may not carry — and
 * the WAV framing is the zero-dependency half.
 *
 * Re-exported from `@alexkroman1/aai/step`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  emit,
  encodeWav,
  isTransientStatus,
  type MultipartBody,
  type MultipartPart,
  mapConcurrent,
  multipartBody,
  type PcmFormat,
  pcmDurationMs,
  report,
  requireStepEnv,
  retryAfter,
  type SpeakOptions,
  type SpokenAudio,
  STEP_SPEAK_SAMPLE_RATE,
  STEP_SPEAK_TIMEOUT_MS,
  type StepFetchInit,
  StepGenerateError,
  type StepGenerateJsonOptions,
  type StepGenerateOptions,
  StepTransportError,
  stepEnv,
  stepFetch,
  stepGenerate,
  stepGenerateJson,
  stepSpeak,
  stripJsonFence,
  WAV_HEADER_BYTES,
} from "../../sdk/step-barrel.ts";
