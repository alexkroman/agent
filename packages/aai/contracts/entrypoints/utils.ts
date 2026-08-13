// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `utils`.
 *
 * The zero-dependency helpers a tool body may reach for, plus the two contracts
 * both ends of a platform interaction have to derive identically (the slug
 * shape and the `aai login` confirmation code).
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
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  linkConfirmationCode,
  MAX_SLUG_LENGTH,
  mapInBatches,
  normalizeSpeechText,
  omitUndefined,
  PREVIEW_SLUG_SUFFIX,
  pushCapped,
  RESERVED_SLUGS,
  safeJsonParse,
  VALID_SLUG_RE,
  withLock,
} from "../../sdk/utils.ts";
