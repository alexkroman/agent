// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `step-files`.
 *
 * The upload ↔ local-FILE round trip a media step spends most of its lines on:
 * a temp directory whose lifetime is a lexical scope, a windowed read from the
 * upload store to a path, and a streamed write back the other way.
 *
 * Its own capability rather than part of `step`, for the same reason it is its
 * own subpath: it imports `node:fs/promises`, `node:os` and `node:path`, and a
 * `workflows/*.ts` module keeps every MODULE-scope import in a workflow bundle
 * that is a `node:vm` Script with no `require`. So this is **body-use only** —
 * name it inside a step, or from a module only a step body
 * reaches — and `@alexkroman1/aai/step` stays free of `node:` imports so that
 * rule has somewhere to point. `/ffmpeg` is its partner and the only other
 * capability under the same rule; a reader arriving at one needs the other.
 *
 * It is CONTRACTED rather than deny-listed as non-authoring, and the test is who
 * reads it: a step is precisely this surface's audience, exactly as
 * for `/ffmpeg`. Nothing here is framework plumbing an author never names.
 *
 * The promise is the SHAPE of the round trip rather than the byte count.
 * `STEP_FILE_WINDOW_BYTES` is on the contract because both functions take it as
 * an option and a spec drives their multi-window paths through it; what must not
 * move is that neither ever holds a whole recording in memory, and that what
 * crosses a step boundary is an upload id rather than a path — a step is
 * journaled by its RETURN VALUE and may be replayed in another process, so a
 * path in one names a file that is gone.
 *
 * Re-exported from `@alexkroman1/aai/step-files`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type ReadUploadToFileOptions,
  readUploadToFile,
  STEP_FILE_WINDOW_BYTES,
  type WithTempDirOptions,
  type WriteUploadFromFileOptions,
  withTempDir,
  writeUploadFromFile,
} from "../../host/step-files.ts";
