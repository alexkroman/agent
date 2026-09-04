// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning a body into BUFFERS, and nothing about an upload's contract.
 *
 * Five functions the whole upload surface shares and none of which knows what an
 * upload is: cut a body into pieces, group those into placed WINDOWS, join pieces
 * into one buffer, hand one buffer over as an iterable, drain a body into one buffer
 * with a cap. They sat at the bottom of `_upload-store.ts` — which is
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

import { UPLOAD_CHUNK_BYTES, UPLOAD_PART_BYTES } from "@alexkroman1/aai/host-internal";
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

/** One cut window and the byte it starts at — see {@link windows}. */
export type PlacedWindow = { at: number; bytes: Uint8Array };

/**
 * A body as window objects, refusing anything past `limit`.
 *
 * Here rather than in `_upload-store-blobs.ts` because it is what this module is
 * for — cutting a body into buffers — and because that file is at the 500-line cap.
 * Each window carries the offset it starts at, which it knows and its consumer would
 * otherwise have to derive from the previous write's return value, i.e. from a value
 * that only exists once that write has finished. Yielding it here is what lets the
 * writes overlap: a window is addressable the moment it is cut.
 *
 * ## `grow` cuts the first windows SMALL, and that is a progress fix
 *
 * A window is one object, so nothing in it is READABLE — and therefore nothing is
 * published as `size` — until the whole window is stored. At a flat
 * `UPLOAD_PART_BYTES` that means a STREAMED upload publishes nothing for its first
 * 8 MiB: measured, an upload under that size reported `size: 0` for its entire life
 * and then the whole file at once. `size` was honest throughout (it is the
 * contiguous READABLE prefix, and none of it was readable), which is exactly why
 * the fix is the cut and not the number — a `size` counting bytes that have merely
 * arrived would send a reader to a window that is not there.
 *
 * Two things that cost, both real: a body watching `stepUploadInfo` sees no progress at
 * all, and a template judging a STALL on that number reads a healthy slow uplink as
 * dead (`templates/transcription-workflow`'s idle-poll bound gives up after five
 * minutes of an unchanging `size`).
 *
 * So a growing cut doubles from `UPLOAD_CHUNK_BYTES` to `UPLOAD_PART_BYTES` —
 * 1, 2, 4, 8, 8, … MiB. The first megabyte is readable as soon as it lands, and the
 * asymptotic shape is unchanged: a maximal 2 GiB upload gains THREE windows over
 * the flat cut, so the `parts` array — which every window arrival rewrites whole,
 * making bytes written O(N²) in window count (`aai-server/platform-uploads.ts` owns
 * that tripwire) — is not measurably worse. A flat `UPLOAD_CHUNK_BYTES` cut would
 * have been eight times the windows and sixty-four times those bytes, which is the
 * alternative this ramp exists to avoid.
 *
 * Every offset stays on the megabyte GRID a part upload's offsets are checked
 * against (`assertPartOffset`), so a streamed window and a part window remain the
 * same kind of object addressed the same way.
 *
 * ## A body that DIES still yields the window it was filling
 *
 * The bytes held for the window in progress have already arrived and are already
 * in this process's memory, so dropping them on the way out is losing data nobody
 * has to lose — and on the streamed path it is losing data a reader was promised:
 * `stream` writes its record FIRST precisely so a torn upload reads as "incomplete
 * and this much is readable" rather than as an absent file. So the cut yields what
 * it holds and THEN rethrows.
 *
 * It cost a megabyte the day the ramp landed. A torn 8 MiB stream published
 * 1 + 2 + 4 MiB and discarded the fourth megabyte it was holding against an 8 MiB
 * target, which `aai-server/workflow-uploads.scenario.test.ts` is the only thing in
 * the repo that could see. The flat cut had the same hole — up to a whole
 * `UPLOAD_PART_BYTES` of arrived bytes went out with it — and only ever looked
 * correct for a body whose length happened to land on a window boundary.
 *
 * The flush is one more window rather than a partial one: `chunked` holds its own
 * sub-chunk remainder and loses it on the same failure, so what is left here is
 * always whole `UPLOAD_CHUNK_BYTES` pieces and the offset stays on the grid. And it
 * really is STORED before the failure surfaces — `mapStream` awaits everything in
 * flight in its `finally` before rethrowing, so this is a deterministic extra
 * window and not a race with the unwinding.
 */
export async function* windows(
  body: AsyncIterable<Uint8Array>,
  limit: number,
  grow = false,
): AsyncGenerator<PlacedWindow> {
  let held: Uint8Array[] = [];
  let bytes = 0;
  let at = 0;
  let emitted = 0;
  try {
    for await (const piece of chunked(body, limit)) {
      held.push(piece);
      bytes += piece.length;
      if (bytes >= windowTarget(emitted, grow)) {
        yield { at, bytes: concat(held, bytes) };
        at += bytes;
        held = [];
        bytes = 0;
        emitted += 1;
      }
    }
  } catch (error: unknown) {
    // Caught rather than left to a `finally`, which a consumer that walks away
    // mid-cut would also run — and a `yield` in a generator being returned throws
    // over the caller's own reason for leaving.
    if (bytes > 0) yield { at, bytes: concat(held, bytes) };
    throw error;
  }
  if (bytes > 0) yield { at, bytes: concat(held, bytes) };
}

/**
 * How many bytes the `n`th window of a cut holds at most.
 *
 * `UPLOAD_PART_BYTES` flat, or a doubling ramp from one chunk up to it — see
 * {@link windows}. `chunked` yields whole `UPLOAD_CHUNK_BYTES` pieces, so every
 * target is reached exactly rather than overshot.
 */
function windowTarget(n: number, grow: boolean): number {
  if (!grow) return UPLOAD_PART_BYTES;
  return Math.min(UPLOAD_PART_BYTES, UPLOAD_CHUNK_BYTES * 2 ** n);
}

/** One value as an iterable, so a window can be handed to `put` unchanged. */
export async function* once(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
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
 * The three {@link UploadBackend} implementations each open an object write by
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
