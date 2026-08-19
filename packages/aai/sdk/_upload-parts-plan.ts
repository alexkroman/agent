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
 */

import { UPLOAD_CHUNK_BYTES, UPLOAD_PART_BYTES } from "./constants.ts";
import type { UploadBody } from "./workflow-upload-client.ts";
import type { UploadPartsSettings } from "./workflow-upload-parts.ts";

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

/** One window of the body, however it is spelled. */
export function sliceOf(file: UploadBody, start: number, end: number): UploadBody {
  if (file instanceof ArrayBuffer) return file.slice(start, end);
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
 */
export function partsPlan(
  file: UploadBody,
  settings: UploadPartsSettings,
): UploadPartsPlan | undefined {
  const total = sliceableBytes(file);
  if (total === undefined) return undefined;
  const parts = planParts(total, settings.partBytes ?? UPLOAD_PART_BYTES);
  // One part is the single request with two extra round trips in front of it.
  if (parts.length < 2) return undefined;
  return { total, parts };
}

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
