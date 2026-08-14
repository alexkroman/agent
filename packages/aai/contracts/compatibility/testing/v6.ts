// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 6.
 *
 * **Epoch 6 is a RIPPLE, not a change to this capability.** `StartOptions`
 * gained `notify` — ask to be told when a run finishes — and this capability's
 * report mentions that type through a public signature, so its hash moved while
 * nothing an author writes here did. `aai:workflow` epoch 6 is where the
 * addition is demonstrated.
 *
 * So this file is epoch 5's example, re-frozen: what it proves is exactly
 * what a re-frozen epoch should prove — that the authoring shape still compiles
 * against current source. See `../agent/v1.ts` for what "frozen" obliges and why
 * the imports are relative.
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
