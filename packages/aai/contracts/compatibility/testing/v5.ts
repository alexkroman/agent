// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 5.
 *
 * Epoch 5 adds `stubUploads` — the store a `"use step"` body reads through when
 * there is no server around it, which is what makes a step that takes an
 * uploaded file testable in a user's own project at all. Epoch 4's context
 * builders are unchanged and `./v4.ts` is retained, so this file demonstrates
 * only what is new.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { type StubUpload, stubUploads } from "../../../sdk/testing.ts";
import { readUpload } from "../../../sdk/utils.ts";

/** The step under test: it reads a window of a file the run only named. */
export async function readHeader(uploadId: string): Promise<number> {
  "use step";

  const { bytes, info } = await readUpload(uploadId, { end: 44 });
  return bytes.length + info.size;
}

/** A file with a name and a type, for a step that reads either. */
const recording: StubUpload = {
  bytes: new Uint8Array(64),
  name: "standup.wav",
  type: "audio/wav",
};

/**
 * The spec shape: publish, exercise, and RESTORE — a store left published is
 * read by the next file's steps.
 */
export async function exerciseStep(): Promise<number> {
  const restore: () => void = stubUploads({
    upl_1: recording,
    // A bare `Uint8Array` is the common case: these bytes, no name.
    upl_2: new Uint8Array([1, 2, 3]),
  });
  try {
    return await readHeader("upl_1");
  } finally {
    restore();
  }
}
