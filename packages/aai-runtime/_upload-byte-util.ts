// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning a body into BUFFERS, and nothing about an upload's contract.
 *
 * Three functions the whole upload surface shares and none of which knows what an
 * upload is: cut a body into pieces, join pieces into one buffer, drain a body into
 * one buffer with a cap. They sat at the bottom of `_upload-store.ts` — which is
 * the store's INTERFACE, its error vocabulary and its invariants — and that file
 * crossed the 500-line cap when `UPLOAD_PROBE_CONCURRENCY` arrived.
 *
 * This is the seam that file already had rather than the smallest cut available:
 * these are byte plumbing with four importers, all of them a blob backend
 * (`_upload-blobs.ts`, `-http.ts`, `-brokered.ts`) or the file home, and not one
 * of them reads anything else from the store's module. The error classes are the
 * other candidate and stay put: the docs on the five cross-reference each other by
 * position ("its own error for the reason the four above are"), and they have 23
 * importers.
 *
 * `UploadTooLargeError` is the one thing that travels the other way, because the
 * cap is what makes these safe — a body is counted AS IT ARRIVES rather than read
 * off a length a client controls independently of what it sends.
 *
 * @internal
 */

import { UPLOAD_CHUNK_BYTES } from "@alexkroman1/aai/host-internal";
import { UploadTooLargeError } from "./_upload-store.ts";

/**
 * Read a body into `UPLOAD_CHUNK_BYTES` pieces, refusing anything past `limit`.
 *
 * The piece size a body is assembled from before it is grouped into window objects,
 * and the unit `readUploadRoute` writes to a socket in. Counted as it arrives rather
 * than from a declared length, the same rule
 * `readBody` follows and for the same reason: a client controls that header
 * independently of what it sends.
 */
export async function* chunked(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<Uint8Array> {
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let total = 0;
  for await (const piece of body) {
    total += piece.length;
    if (total > limit) throw new UploadTooLargeError(limit);
    held.push(piece);
    heldBytes += piece.length;
    while (heldBytes >= UPLOAD_CHUNK_BYTES) {
      const joined = concat(held, heldBytes);
      yield joined.subarray(0, UPLOAD_CHUNK_BYTES);
      const rest = joined.subarray(UPLOAD_CHUNK_BYTES);
      held = rest.length > 0 ? [rest] : [];
      heldBytes = rest.length;
    }
  }
  if (heldBytes > 0) yield concat(held, heldBytes);
}

/**
 * One buffer from several.
 *
 * `Buffer.concat` does the copy — it is the native one, and this is the upload
 * hot path (a chunk per megabyte, in and out). The one thing it does NOT do is
 * skip the copy for a single part that is already the right length, which here
 * is the ordinary case: `chunked` yields whole `UPLOAD_CHUNK_BYTES` pieces.
 */
export function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1 && parts[0]?.length === size) return parts[0];
  return Buffer.concat(parts, size);
}

/**
 * Drain a body into one buffer, refusing it the moment it passes `limit`.
 *
 * The three {@link UploadBlobs} implementations each open an object write by
 * buffering — Storage has no append and no streaming PUT of unknown length, so
 * an object's bytes have to be in hand to write them — and each had written the
 * same accumulate-count-and-cap loop. The cap is what makes it safe: the size is
 * counted AS IT ARRIVES rather than read off a declared length a client controls
 * independently of what it really sends, so an oversized body is refused while
 * streaming instead of buffered and then measured.
 *
 * @throws {UploadTooLargeError} once more than `limit` bytes have arrived.
 * @internal
 */
export async function collectCapped(
  body: AsyncIterable<Uint8Array>,
  limit: number | undefined,
): Promise<Uint8Array> {
  const held: Uint8Array[] = [];
  let size = 0;
  for await (const piece of body) {
    size += piece.length;
    if (limit !== undefined && size > limit) throw new UploadTooLargeError(limit);
    held.push(piece);
  }
  return concat(held, size);
}
