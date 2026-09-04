// Copyright 2026 the AAI authors. MIT license.
/**
 * How a file is CUT into parts — the synchronous half of the parallel upload.
 *
 * Split from `workflow-upload-parts.ts` at the 500-line source cap, on a seam that
 * module already implied: everything here answers "what windows would this file
 * become", with no network, no retry budget and no progress reporting. What is left
 * next door is how those windows are SENT.
 *
 * The seam is also where the DECLINE decision lives, and that decision has to stay
 * synchronous — two of the three reasons to decline the parts path are properties of
 * the file, so deciding them before anything is awaited keeps a small upload's first
 * request in the same tick as the call.
 *
 * ## A CALLER-NAMED upload is cut differently, and one part is not enough
 *
 * `partsPlan`'s `resumable` flag is what `streamUploadFile` passes and `uploadFile`
 * does not, and the rule behind it is two-fold because **resumability is a SHAPE
 * and a GRANULARITY**:
 *
 * - **The shape.** The parts routes are the only one an interrupted upload can be
 *   picked up in — the store records which windows landed and publishes them as
 *   `UploadInfo.ranges`, where a single `PUT` to a chosen id can only ever be sent
 *   once, because that 409 is what makes choosing an id safe. So `uploadStream`,
 *   whose whole reason to exist over `upload` is that the id outlives the attempt,
 *   cannot decline the path that makes the id worth having. It did, for every file
 *   that fits in one part — the ordinary size of a recording off a phone — so
 *   pausing one and resuming it sent the WHOLE file again and was then refused as a
 *   taken id: a pause button that was a cancel with a longer failure, the exact
 *   thing `aai-ui/_upload-session.ts` says it is not.
 * - **The granularity**, which the shape alone does not buy. A part is
 *   ALL-OR-NOTHING: a window interrupted half-written covers nothing, so a resume
 *   sends it again in full. At the default 8 MiB part size every smaller file is
 *   exactly one window, so a resume still re-sent all of it — the reported symptom,
 *   with the 409 removed and nothing else fixed. A file the requested part size
 *   cannot divide is therefore re-cut at {@link UPLOAD_CHUNK_BYTES}, the store's own
 *   alignment grid and so the finest window a resume can address: a 4 MiB recording
 *   paused at 90% re-sends at most the megabyte it was in the middle of.
 *
 * The caller's `partBytes` is overridden rather than respected in that second
 * branch, which costs nothing — the branch is reached only when the file is smaller
 * than one part of the size asked for, so the preference had nothing to divide. A
 * file under one chunk stays one window, there being nothing finer to cut it into;
 * the shape is still resumable and the resume sends under a megabyte. An EMPTY file
 * declines either way: no bytes to send, and nothing to resume.
 */

import { UPLOAD_CHUNK_BYTES, UPLOAD_PART_BYTES } from "./constants.ts";
import type { UploadBody } from "./workflow-upload-client.ts";
import type { UploadPartsOptions } from "./workflow-upload-parts.ts";

export type UploadPartsPlan = { total: number; parts: Part[] };

/** A window of the file, and the part index that reports its progress. */
export type Part = { start: number; end: number; index: number };

/**
 * The file's byte length, when it can be cut by byte at all.
 *
 * `undefined` is what makes this path DECLINE — see the module doc. A string is
 * excluded deliberately rather than encoded first: encoding it to measure it is a
 * second copy of the whole body, for a body that is not what this exists for.
 */
function sliceableBytes(file: UploadBody): number | undefined {
  if (typeof file === "string") return undefined;
  if (file instanceof ArrayBuffer) return file.byteLength;
  if (ArrayBuffer.isView(file)) return file.byteLength;
  // Read structurally rather than `instanceof Blob`: a `File` from another realm
  // (an iframe, a worker) fails an instance check while slicing perfectly well.
  const described = file as { size?: unknown; slice?: unknown };
  return typeof described.size === "number" && typeof described.slice === "function"
    ? described.size
    : undefined;
}

/**
 * One window of the body, however it is spelled.
 *
 * A VIEW in both byte-array arms, never a copy. `ArrayBuffer.prototype.slice`
 * copies where the `isView` arm below does not, and the copy bought nothing: the
 * caller holds the whole body for the length of the upload either way (a resume
 * re-cuts the same body, and every part is re-sliced per attempt), so a window
 * aliasing it retains nothing that was not already retained. Nothing downstream
 * mutates a window — a part is handed to `fetch` or to `XMLHttpRequest.send` and
 * read — so aliasing is unobservable apart from the copy it removes, which at
 * the default part size is 8 MiB per part in flight.
 */
export function sliceOf(file: UploadBody, start: number, end: number): UploadBody {
  if (file instanceof ArrayBuffer) return new Uint8Array(file, start, end - start);
  if (ArrayBuffer.isView(file)) {
    return new Uint8Array(file.buffer, file.byteOffset + start, end - start);
  }
  return (file as Blob).slice(start, end);
}

/**
 * How this file would be cut, or `undefined` when the parts path declines it.
 *
 * SYNCHRONOUS, and separate from {@link uploadInParts} for that reason alone: two
 * of the three reasons to decline are properties of the file, so deciding them
 * before anything is awaited keeps a small upload's first request in the same tick
 * as the call — the third reason (an agent with no `/parts` routes) is an ANSWER
 * and necessarily costs a round trip.
 *
 * `resumable` is what a CALLER-NAMED upload passes — see the module doc.
 */
export function partsPlan(
  file: UploadBody,
  settings: UploadPartsOptions,
  opts: { resumable?: boolean } = {},
): UploadPartsPlan | undefined {
  const total = sliceableBytes(file);
  if (total === undefined) return undefined;
  const parts = planParts(total, settings.partBytes ?? UPLOAD_PART_BYTES);
  if (parts.length >= MIN_PARTS) return { total, parts };
  // No parts at all is an empty file, which declines either way: there is nothing
  // to send and nothing to resume.
  if (parts.length === 0 || opts.resumable !== true) return undefined;
  // One part, for an upload that has to be resumable. See RESUMABLE_PLAN.
  return { total, parts: planParts(total, UPLOAD_CHUNK_BYTES) };
}

/**
 * Parts below which the fan-out is not worth its two extra round trips.
 *
 * The right floor wherever the only thing this path buys is SPEED: one part is the
 * single request with a claim and a closing read in front of it, and there is
 * nothing to overlap.
 */
const MIN_PARTS = 2;

/** The windows to send, in order. */
export function planParts(total: number, partBytes: number): Part[] {
  // Rounded up to a whole number of chunks — the store's alignment rule, applied
  // here so a caller's `partBytes` is a preference rather than a way to fail.
  const size = Math.max(
    UPLOAD_CHUNK_BYTES,
    Math.ceil(partBytes / UPLOAD_CHUNK_BYTES) * UPLOAD_CHUNK_BYTES,
  );
  const parts: Part[] = [];
  for (let start = 0; start < total; start += size) {
    parts.push({ start, end: Math.min(start + size, total), index: parts.length });
  }
  return parts;
}
