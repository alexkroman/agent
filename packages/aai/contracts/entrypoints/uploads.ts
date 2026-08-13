// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `uploads`.
 *
 * How a `"use step"` body reads a file the run did not carry. A workflow's
 * input is journaled and replayed on every resume, so bytes travel to
 * `POST /workflows/uploads` instead and the input carries the id — which makes
 * these three the whole of what an author writes against.
 *
 * Its own capability rather than part of `utils`, because it is a promise about
 * a STORE: the id shape, the half-open window, and the clamping are what a
 * template's fan-out is written on top of, and none of it moves when a
 * zero-dependency helper next door does.
 *
 * Re-exported from `@alexkroman1/aai/utils`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type ReadUploadOptions,
  readUpload,
  type UploadInfo,
  type UploadSlice,
  uploadInfo,
} from "../../sdk/utils.ts";
