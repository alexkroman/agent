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
 * a step body has no `ToolContext` and no session, so what it may name is a
 * different question from what a tool body may name, and a signature change here
 * breaks a different set of files. That split is the whole reason the subpath
 * exists; see `sdk/step-barrel.ts`.
 *
 * `stepFetch`/`multipartBody`/`StepTransportError` are the ones an author must
 * not be steered off: a step that reaches for `fetch` instead speaks HTTP/2, and
 * a fan-out over one connection is where a capacity limit stops being a status a
 * retry policy can read. See `sdk/step-fetch.ts`.
 *
 * `stepSpeak` and `encodeWav`/`wavHeader`/`pcmDurationMs` are the reason to read
 * this contract beside `uploads`: a step that SPEAKS is useless without
 * somewhere to put what it made. `stepSpeak` is a slot the way `stepFetch` is —
 * the synthesizer needs a WebSocket client, which this subpath may not carry —
 * and the WAV framing is the zero-dependency half. `wavHeader` is `encodeWav`
 * without the join, for a caller handing the header and the samples to something
 * that takes a list (`multipartBody`, on this same contract) rather than holding
 * a second copy of the audio to put them in one buffer first.
 *
 * `stepInfo` is the one member that reads the ENGINE rather than doing work: it
 * says which attempt of a step this is and whether it is the last, which is what
 * lets a body degrade instead of failing. Its `maxAttempts` travels with the
 * attempt on purpose — see `sdk/step-attempt.ts` — so a signature change here
 * breaks bodies that branch on a retry, which are the ones whose failure is
 * quietest.
 *
 * `stepWebhookUrl` is the one member of this capability whose value LEAVES the
 * system: it is the callback URL a step hands a third party, and the same URL
 * `ctx.workflows.publicWebhookUrl` mints for a tool. A signature change here
 * breaks a body that had no other way to be woken — see `sdk/step-webhook.ts`.
 *
 * Re-exported from `@alexkroman1/aai/step`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  encodeWav,
  isTransientStatus,
  type MultipartBody,
  type MultipartPart,
  mapConcurrent,
  multipartBody,
  type PcmFormat,
  pcmDurationMs,
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
  type StepInfo,
  StepTransportError,
  stepEmit,
  stepEnv,
  stepFetch,
  stepGenerate,
  stepGenerateJson,
  stepInfo,
  stepReport,
  stepSpeak,
  stepWebhookUrl,
  stripJsonFence,
  WAV_HEADER_BYTES,
  wavHeader,
} from "../../sdk/step-barrel.ts";
