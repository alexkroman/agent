// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 17.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 17's addition is one optional field on `stubUploads`: `complete`. It is what
 * lets a spec stage an upload that is STILL ARRIVING — the state a step polling one
 * has to handle, and the only one where `readUpload` legitimately comes back short.
 *
 * Being able to write that down is the whole point. A body that treats a stalled size
 * as the end of the file returns a transcript of most of a recording and reports
 * success, and no spec can catch that without an incomplete upload to hand it.
 */

import { readUpload, uploadInfo } from "../../../sdk/step-barrel.ts";
import { stubUploads } from "../../../sdk/testing.ts";

/** The step under test: how far has the upload got? */
async function arrived(id: string): Promise<{ size: number; complete: boolean }> {
  "use step";

  const info = await uploadInfo(id);
  return { size: info.size, complete: info.complete };
}

/**
 * Drive that step against an upload that is half here.
 *
 * `restore()` is not optional — a store left published makes the next file's steps
 * read this one's bytes, which presents as a passing test somewhere else.
 */
export async function readsAnArrivingUpload(): Promise<{ size: number; complete: boolean }> {
  const restore = stubUploads({
    half: { bytes: new Uint8Array([1, 2, 3]), name: "standup.wav", complete: false },
  });
  try {
    return await arrived("half");
  } finally {
    restore();
  }
}

/** A window past what has landed comes back SHORT, which is the contract. */
export async function readsShortWhenAhead(): Promise<number> {
  const restore = stubUploads({ half: { bytes: new Uint8Array([1, 2]), complete: false } });
  try {
    const slice = await readUpload("half", { start: 0, end: 1000 });
    return slice.bytes.length;
  } finally {
    restore();
  }
}

/** The default is a FINISHED upload, so every earlier spec shape is unchanged. */
export async function defaultsToComplete(): Promise<boolean> {
  const restore = stubUploads({ whole: new Uint8Array([1, 2, 3]) });
  try {
    return (await uploadInfo("whole")).complete;
  } finally {
    restore();
  }
}
