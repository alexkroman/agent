// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `workflow-files`.
 *
 * The FILES half of a workflow page: what an upload reports while its bytes
 * travel (`UploadStatus`, `<UploadProgressBar>`) and what a page renders a
 * stored file back with (`useDownloadUrl`, `<AudioResult>`). Split from
 * `workflow` so the run hooks and the file components are versioned apart —
 * a change to how a file is drawn is not an epoch of every page that starts a
 * run.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  AudioResult,
  type AudioResultCaptions,
  type AudioResultProps,
  UploadProgressBar,
  type UploadStatus,
  type UseDownloadUrlOptions,
  type UseDownloadUrlResult,
  useDownloadUrl,
} from "../../index.ts";
