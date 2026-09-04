// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `uploads`.
 *
 * How a step reads a file the run did not carry. A workflow's
 * input is journaled and replayed on every resume, so bytes travel to
 * `POST /workflows/uploads` instead and the input carries the id — which makes
 * these the whole of what an author writes against.
 *
 * Its own capability rather than part of `utils`, because it is a promise about
 * a STORE: the id shape, the half-open window, and the clamping are what a
 * template's fan-out is written on top of, and none of it moves when a
 * zero-dependency helper next door does.
 *
 * `stepWriteUpload` is here for the same reason and not in `utils`: it is the same
 * store from the other side — the way a step hands a file it PRODUCED to a
 * caller that can only read JSON.
 *
 * Re-exported from `@alexkroman1/aai/step`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type ReadUploadOptions,
  stepReadUpload,
  // The other half of the `size`-versus-`complete` promise, and it belongs to
  // THIS capability rather than to `transcribe` or `step-files`: it is a claim
  // about the store — `size` is the readable prefix — and both of those readers
  // got it wrong independently before there was one place to get it right.
  stepRequireCompleteUpload,
  stepUploadInfo,
  stepWriteUpload,
  UploadIncompleteError,
  type UploadInfo,
  type UploadRange,
  type UploadSlice,
  type WriteUploadOptions,
} from "../../sdk/step-barrel.ts";
