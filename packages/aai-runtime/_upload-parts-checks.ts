// Copyright 2026 the AAI authors. MIT license.
/**
 * What a parts upload's own DECLARATION permits, checked against one window.
 *
 * Two pure functions, both answering the same question from different ends: a
 * `beginParts` wrote a total, and a window either fits inside it or does not. They
 * are here rather than in `_upload-store-blobs.ts` because that file crossed the
 * 500-line cap, and this is the seam it had: everything else in it closes over the
 * store's `records`, `blobs` and lock, while these two take a record and a number
 * and return a value.
 *
 * **The reason they are separable at all is that a declared total is IMMUTABLE.**
 * `beginParts` writes `expected` and nothing ever rewrites it — the platform's
 * `updateUpload` deliberately touches only `size`, `complete` and `parts`, so "a
 * late window silently redeclares an upload's total" is unrepresentable. That is
 * what lets a caller read the record once and check every window in a batch
 * against the copy it holds, which is the round trip `UploadStore.recordParts`
 * stopped paying.
 *
 * @internal
 */

import type { UploadPart } from "./_upload-blobs.ts";
import type { UploadRecord } from "./_upload-records.ts";
import { UploadPartError } from "./_upload-store.ts";

/**
 * One probed window, or the reason it may not be recorded.
 *
 * Lifted out of the probe callback when the probes stopped waiting for the record:
 * these three refusals all need the declared total, and the probe does not, so
 * keeping them together with the `HEAD` would have serialized the two again.
 */
export function measuredPart(
  id: string,
  offset: number,
  bytes: number | undefined,
  total: number,
): UploadPart {
  if (bytes === undefined) {
    throw new UploadPartError(
      `No bytes are stored for the part at ${offset} of upload ${id}. Upload the part to ` +
        "its signed URL before recording it.",
    );
  }
  // A window of NO bytes, where the upload declares some. Refused rather than
  // recorded, and this is not hypothetical: `UploadBlobs.size` read a missing
  // `Content-Length` as `0` for a while (see `contentLength`), so every part of
  // every parts upload on the platform was recorded as an empty window. Nothing
  // below could see it — a zero-length range is well formed and `contiguousBytes`
  // sums it happily to 0 — so the only symptom was a stored file nothing could
  // read. The refusal above exists to keep a hole out of the record; a
  // zero-length window IS a hole, so it belongs under the same rule.
  if (bytes === 0 && total > 0) {
    throw new UploadPartError(
      `The part at ${offset} of upload ${id} measured 0 bytes, but the upload declares ` +
        `${total}. Recording it would leave a hole that reads as silence.`,
    );
  }
  if (offset + bytes > total) {
    throw new UploadPartError(
      `The part at ${offset} holds ${bytes} bytes, which runs past this upload's ${total}.`,
    );
  }
  return { at: offset, bytes };
}

export function declaredTotal(id: string, held: UploadRecord, offset: number): number {
  if (held.expected === undefined) {
    throw new UploadPartError(`Upload ${id} was not begun as a parts upload.`);
  }
  const total = held.expected;
  if (offset > total) {
    throw new UploadPartError(`A part at ${offset} starts past this upload's ${total} bytes.`);
  }
  return total;
}
