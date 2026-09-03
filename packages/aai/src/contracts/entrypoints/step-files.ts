// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `step-files`.
 *
 * The upload ↔ local-FILE round trip a media step spends most of its lines on:
 * a temp directory whose lifetime is a lexical scope, a windowed read from the
 * upload store to a path, and a streamed write back the other way.
 *
 * Its own capability rather than part of `step`, for the same reason it is its
 * own subpath: it imports `node:fs/promises`, `node:os` and `node:path`, and
 * `@alexkroman1/aai/step` is an `sdk/` barrel that must stay runnable in a
 * browser and in Deno — so these three live in `host/` and are reached by a
 * subpath of their own. `/ffmpeg` is its partner and the only other capability
 * under the same rule; a reader arriving at one needs the other.
 *
 * It is CONTRACTED rather than deny-listed as non-authoring, and the test is who
 * reads it: a step is precisely this surface's audience, exactly as
 * for `/ffmpeg`. Nothing here is framework plumbing an author never names.
 *
 * The promise is the SHAPE of the round trip rather than the byte count.
 * `STEP_FILE_WINDOW_BYTES` and `STEP_FILE_READ_CONCURRENCY` are on the contract
 * because both are defaults a caller may override through an option — the same
 * test, and a spec drives the multi-window and concurrent paths through them.
 * What must not move is that neither function ever holds a whole recording in
 * memory (the read now holds the width times the window, which is a constant and
 * not a fraction of the file), and that what crosses a step boundary is an upload
 * id rather than a path — a step is journaled by its RETURN VALUE and may be
 * replayed in another process, so a path in one names a file that is gone.
 *
 * Re-exported from `@alexkroman1/aai/step-files`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type ReadUploadToFileOptions,
  readUploadToFile,
  STEP_FILE_READ_CONCURRENCY,
  STEP_FILE_WINDOW_BYTES,
  type WithTempDirOptions,
  type WriteUploadFromFileOptions,
  withTempDir,
  writeUploadFromFile,
} from "../../host/step-files.ts";
