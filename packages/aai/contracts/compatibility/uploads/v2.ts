// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:uploads` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * What epoch 2 added is the other half of the store: an upload can be READ WHILE IT
 * IS STILL ARRIVING. `UploadInfo` gained `complete`, and that one field is the whole
 * contract — a body polls it, and `readUpload`'s window clamps to what has landed,
 * which it already did before any of this existed.
 *
 * The `"use step"` directives are inert here — nothing compiles this through the
 * Workflow DevKit's builder — which is the point: what is frozen is the way an author
 * WRITES against the store, and the only thing this must keep doing is compile.
 */

import { readUpload, type UploadInfo, uploadInfo } from "../../../sdk/step-barrel.ts";

/** How much of the file the first step looks at. */
const HEADER_BYTES = 64 * 1024;

/** What one poll of an arriving upload tells a body. */
export type Arrived = {
  /** Bytes stored so far — NOT the total, until `complete`. */
  size: number;
  /** Whether that is all of them. The only field an exit may be decided on. */
  complete: boolean;
};

/**
 * The poll a body waiting on a streamed upload runs.
 *
 * The reason `complete` is read separately from `size`: a size that has stopped
 * growing is what both a slow link and a dead client look like.
 */
export async function arrived(id: string): Promise<Arrived> {
  "use step";

  const info: UploadInfo = await uploadInfo(id);
  return { size: info.size, complete: info.complete };
}

/**
 * Read a window that may not have arrived yet.
 *
 * The clamp is the mechanism: a window past what is stored comes back SHORT rather
 * than failing, and the returned `end` is how a caller learns which it got.
 */
export async function readAhead(id: string, start: number, end: number): Promise<number> {
  "use step";

  const slice = await readUpload(id, { start, end });
  return slice.end - slice.start;
}

/** The header, which is the first thing to arrive and all a plan needs. */
export async function readHeader(id: string): Promise<Uint8Array> {
  "use step";

  const head = await readUpload(id, { end: HEADER_BYTES });
  return head.bytes;
}
