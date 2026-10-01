// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/utils` — the zero-dependency helpers a TOOL body reaches for.
 *
 * A FACADE. The subpath resolves here rather than at `utils.ts`, which buys two
 * things the direct form could not. That module can be SPLIT as it grows without
 * moving the published entry point — the path an implementation file happens to
 * have is not a thing to promise anyone — and a name it gains next reaches the
 * public surface only when a line is added below, rather than the moment it is
 * written.
 *
 * Named re-exports rather than `export *` for the second half of that: the
 * wildcard form re-exports whatever arrives, and needs a `noReExportAll`
 * suppression the escape-hatch ratchet only lets move down.
 *
 * @module utils
 */

export { type FitToolResultOptions, fitToolResult } from "./fit-tool-result.ts";
export {
  HttpError,
  type JsonClient,
  type JsonClientContext,
  type JsonClientOptions,
  type JsonRequestInit,
  jsonClient,
} from "./json-client.ts";
export { type NormalizePhoneOptions, normalizePhone } from "./phone.ts";
// A failure as a reason a person can HEAR — its own module for its own test.
export { type SpokenErrorReasonOptions, spokenErrorReason } from "./spoken-error-reason.ts";
// The forwarding half of the `T | ToolFailure` union above. Joined HERE rather
// than re-exported from `utils.ts`: that module declares `isToolFailure`, which
// `tool-failure-flow.ts` imports, so a re-export there would close a cycle.
export { failable, orFail } from "./tool-failure-flow.ts";
export {
  countWords,
  createKeyedLock,
  decodeHtmlEntities,
  errorDetail,
  errorMessage,
  formatBytes,
  formatDuration,
  formatMoney,
  isRecord,
  isToolFailure,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  omitUndefined,
  plural,
  pushCapped,
  responseErrorMessage,
  roundMoney,
  safeJsonParse,
  type ToolFailure,
  type ToolRefusal,
  type ToolRefusalReason,
  toolFailure,
  toolRefusal,
  withLock,
} from "./utils.ts";
