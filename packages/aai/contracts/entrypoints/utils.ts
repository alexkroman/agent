// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `utils`.
 *
 * The zero-dependency helpers a tool body — or a `"use step"` body, which is
 * what `mapInBatches`, `stepEnv`/`requireStepEnv`, `stepGenerate`, `report` and
 * the two retry helpers are for — may reach for, plus the two contracts both
 * ends of a platform interaction have to derive identically (the slug shape and
 * the `aai login` confirmation code).
 *
 * `stepFetch`/`multipartBody`/`StepTransportError` are part of it and are the
 * ones an author must not be steered off: a step that reaches for `fetch`
 * instead speaks HTTP/2, and a fan-out over one connection is where a capacity
 * limit stops being a status a retry policy can read. See `sdk/step-fetch.ts`.
 *
 * Re-exported from `@alexkroman1/aai/utils`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createKeyedLock,
  errorDetail,
  errorMessage,
  isRecord,
  isTransientStatus,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  linkConfirmationCode,
  MAX_SLUG_LENGTH,
  type MultipartBody,
  type MultipartPart,
  mapInBatches,
  multipartBody,
  normalizeSpeechText,
  omitUndefined,
  PREVIEW_SLUG_SUFFIX,
  pushCapped,
  RESERVED_SLUGS,
  report,
  requireStepEnv,
  responseErrorMessage,
  retryAfter,
  type StepFetchInit,
  StepGenerateError,
  type StepGenerateJsonOptions,
  type StepGenerateOptions,
  StepTransportError,
  safeJsonParse,
  stepEnv,
  stepFetch,
  stepGenerate,
  stepGenerateJson,
  stripJsonFence,
  VALID_SLUG_RE,
  withLock,
} from "../../sdk/utils.ts";
