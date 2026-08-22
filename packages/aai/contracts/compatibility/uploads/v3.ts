// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:uploads` epoch 3.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * What epoch 3 added is `UploadInfo.ranges`: WHICH windows of an unfinished parts
 * upload have landed, as against `size`, which is only how far the file can be READ
 * from byte zero. The two answer different questions and a body must not confuse
 * them — a window inside a range that is not inside `size` is stored and not
 * readable, because a hole sits in front of it.
 *
 * The `"use step"` directives are inert here — nothing compiles this through the
 * Workflow DevKit's builder — which is the point: what is frozen is the way an author
 * WRITES against the store, and the only thing this must keep doing is compile.
 */

import { type UploadInfo, type UploadRange, uploadInfo } from "../../../sdk/step-barrel.ts";

/** What a caller names the windows by — exported so a signature can mention it. */
export type Window = UploadRange;

/** What one poll of an arriving upload tells a body. */
export type Arrived = {
  /** Bytes readable from zero — NOT the total, until `complete`. */
  size: number;
  /** Whether that is all of them. The only field an exit may be decided on. */
  complete: boolean;
  /** How many disjoint windows are stored, which for a whole-file write is none. */
  windows: number;
};

/**
 * The poll a body waiting on an arriving upload runs.
 *
 * `ranges` is absent for a finished upload and for anything that did not arrive as
 * parts, so a reader defaults it rather than branching on the upload's shape.
 */
export async function arrived(id: string): Promise<Arrived> {
  "use step";

  const info: UploadInfo = await uploadInfo(id);
  return { size: info.size, complete: info.complete, windows: (info.ranges ?? []).length };
}

/**
 * Whether one window is wholly stored — which is NOT the same as readable.
 *
 * The distinction epoch 3 introduces: this window's bytes are present, and a body
 * that wants to READ them still has to wait for `size` to reach past them, because
 * everything before the first gap is what the store will hand back.
 */
export async function stored(id: string, want: Window): Promise<boolean> {
  "use step";

  const info = await uploadInfo(id);
  const landed: readonly UploadRange[] =
    info.ranges ?? (info.complete ? [{ start: 0, end: info.size }] : []);
  return landed.some((range) => range.start <= want.start && range.end >= want.end);
}
