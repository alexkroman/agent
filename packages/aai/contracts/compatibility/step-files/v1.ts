// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step-files` epoch 1.
 *
 * The upload ↔ local-FILE round trip, written the way a media step writes it:
 * materialize the upload into a temp directory, run the tool that needs a path,
 * stream the result back into the store, and return an UPLOAD ID.
 *
 * Three properties this pins, each of which a first draft gets wrong:
 *
 * - **What crosses the step boundary is an id, never a path.** A step is
 *   journaled by its RETURN VALUE and may be replayed in a different process, so
 *   a path in one names a file that is gone — and the failure mode is a resumed
 *   run reading a directory another run is using. `withTempDir` makes the
 *   lifetime a lexical scope: created on entry, removed on exit, in a `finally`.
 * - **Nothing holds the whole recording.** Both functions move
 *   `STEP_FILE_WINDOW_BYTES` at a time, so a step's resident set is a constant
 *   rather than a function of the input. The window is on the contract because
 *   both take it as an option, which is what makes their multi-window paths
 *   reachable from a spec at all.
 * - **The import is inside the BODY.** These three name `node:fs/promises`,
 *   `node:os` and `node:path`, and a `workflows/*.ts` module keeps every
 *   module-scope import in a workflow bundle that is a `node:vm` Script with no
 *   `require`. The symptom of getting it wrong is a `ReferenceError: require is
 *   not defined` at REPLAY, from generated code inside the SDK, with nothing
 *   pointing back at the import. The `"use step"` directives here are inert —
 *   nothing compiles this through the DevKit's builder — so what is frozen is
 *   the SHAPE an author writes, and the only thing it must keep doing is
 *   compile.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { join } from "node:path";

import { runFfmpeg, wavEncodeArgs } from "../../../host/ffmpeg.ts";
import {
  type ReadUploadToFileOptions,
  readUploadToFile,
  STEP_FILE_WINDOW_BYTES,
  type WithTempDirOptions,
  type WriteUploadFromFileOptions,
  withTempDir,
  writeUploadFromFile,
} from "../../../host/step-files.ts";

/** The whole round trip, and the shape the subpath exists for. */
export async function toWav(uploadId: string): Promise<string> {
  "use step";

  return await withTempDir(async (dir) => {
    const source = join(dir, "source");
    const converted = join(dir, "converted.wav");
    await readUploadToFile(uploadId, source);
    await runFfmpeg([
      "-nostdin",
      "-y",
      "-i",
      source,
      ...wavEncodeArgs({ channels: 1, sampleRate: 16_000 }),
      converted,
    ]);
    const stored = await writeUploadFromFile(converted, {
      name: "audio.wav",
      type: "audio/wav",
    });
    return stored.id;
  });
}

/**
 * The prefix names the pipeline, which is worth setting: the directory is gone
 * by the time anyone looks, so the name is only ever read in a stack trace.
 */
export const options: WithTempDirOptions = { prefix: "aai-normalize-" };

/**
 * `size` defaults to what `uploadInfo` reports, so a caller that already has it
 * saves the round trip — and a caller reading an upload still ARRIVING passes
 * the prefix it knows is stored.
 */
export const readOptions: ReadUploadToFileOptions = {
  size: 4 * STEP_FILE_WINDOW_BYTES,
  windowBytes: STEP_FILE_WINDOW_BYTES,
};

/** The write takes `writeUpload`'s own metadata plus the window. */
export const writeOptions: WriteUploadFromFileOptions = {
  name: "audio.wav",
  type: "audio/wav",
  windowBytes: STEP_FILE_WINDOW_BYTES,
};

/** The read answers the byte count it wrote, which is what a progress line reports. */
export async function stage(uploadId: string, path: string): Promise<number> {
  "use step";

  return await readUploadToFile(uploadId, path, readOptions);
}

/** And the write answers the full `UploadInfo`, so the id and size come together. */
export async function store(path: string): Promise<{ id: string; size: number }> {
  "use step";

  const info = await writeUploadFromFile(path, writeOptions);
  return { id: info.id, size: info.size };
}
