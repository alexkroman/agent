// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:uploads` epoch 1.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * The shape a fan-out over an uploaded file is written in: one step reads the
 * header to decide where to cut, and one step per piece reads its own window.
 * The `"use step"` directives are inert here — nothing compiles this through
 * the Workflow DevKit's builder — which is the point: what is frozen is the way
 * an author WRITES against the store, and the only thing this must keep doing
 * is compile.
 */

import {
  type ReadUploadOptions,
  readUpload,
  type UploadInfo,
  type UploadSlice,
  uploadInfo,
} from "../../../sdk/utils.ts";

/** How much of the file the first step looks at. */
const HEADER_BYTES = 64 * 1024;

/** What one segment of the plan covers, in the same half-open pair the reader takes. */
export type Segment = ReadUploadOptions & { index: number };

/**
 * The header read: a window from the front, and the WHOLE file's size, which is
 * what a plan is computed from.
 */
export async function planSegments(uploadId: string): Promise<Segment[]> {
  "use step";

  const head: UploadSlice = await readUpload(uploadId, { end: HEADER_BYTES });
  const chunk = Math.max(1, Math.floor(head.info.size / 4));
  return Array.from({ length: 4 }, (_, index) => ({
    index,
    start: index * chunk,
    end: Math.min((index + 1) * chunk, head.info.size),
  }));
}

/** One segment's own window — `[start, end)`, unchanged from the plan. */
export async function readSegment(uploadId: string, segment: Segment): Promise<Uint8Array> {
  "use step";

  const { bytes } = await readUpload(uploadId, { start: segment.start, end: segment.end });
  return bytes;
}

/** What a finished run says it transcribed: the FILENAME, not the opaque id. */
export async function describeSource(uploadId: string): Promise<string> {
  "use step";

  const info: UploadInfo = await uploadInfo(uploadId);
  return info.name || info.id;
}
