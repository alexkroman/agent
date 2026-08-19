// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload store's CONTRACT: its types, its two invariants, and the helpers both
 * backends share.
 *
 * Split from `workflow-uploads.ts` because that module builds the backends and the
 * backends need these names — an import cycle, and biome says so. The line the
 * split follows is the one that was already load-bearing: **the chunking is the
 * contract, where the pieces go is not** (`chunked`'s own doc has said so since
 * before there were two callers). So everything a backend must agree with the other
 * backend about lives here, which is exactly what makes the file backend a valid
 * double for the Postgres one.
 *
 * Nothing here is new public surface: `workflow-uploads.ts` re-exports the names
 * that were already reachable through `@alexkroman1/aai/runtime`.
 *
 * ORIGINAL CONTEXT — where an uploaded file lives between the form that sent it and
 * the step that reads it.
 *
 * The problem it solves is the one `MAX_WORKFLOW_INPUT_BYTES` states: a run's
 * input is journaled and replayed on every resume, so bytes may not travel in
 * it. Before this the only answer was "put the file somewhere else and pass a
 * URL", which is fine for a recording that is already hosted and useless for a
 * person with a file on their laptop — the case every transcription and document
 * app opens on. So the app gets a place of its own.
 *
 * Each backend is its own module (`_upload-store-postgres.ts`,
 * `_upload-store-files.ts`); what stays here is the CONTRACT they share — the
 * chunking, the id minting, and the two invariants below — because that is exactly
 * what makes the memory backend a valid double for the Postgres one.
 *
 * ## Two backends, and it is the SAME split the workflow world makes
 *
 * - **Postgres** when the app has a database — the ordinary deployed case, and
 *   the one that matters, because a durable run is precisely the thing that
 *   outlives the container that started it. An upload in a container's `/tmp`
 *   is gone by the time a resumed run reaches segment 27, which would make the
 *   whole point of a journal unreachable.
 * - **Files** otherwise — `aai dev` against a project with no `DATABASE_URL`,
 *   next to the Local World's own `.workflow-data/`. Forgotten when the
 *   directory is, which is the same honest dev tradeoff the Local World already
 *   makes about runs.
 *
 * ## Bytes are stored in CHUNKS, and read with `substring`
 *
 * A recording is not a value: a two-hour WAV is a couple of hundred megabytes,
 * and both halves of the naive shape — buffer it to insert it, select it whole
 * to read 64 KB of header — are the memory this process does not have. So the
 * body streams into `UPLOAD_CHUNK_BYTES` rows as it arrives, and a range
 * read asks Postgres for exactly the bytes inside each covering chunk. A header
 * probe therefore moves 64 KB, not the file.
 *
 * ## The metadata row is written LAST — for an ordinary upload
 *
 * There is no transaction around a multi-megabyte stream, so "does this upload
 * exist" has to be answerable by one row that only appears when the bytes are
 * all in. An interrupted upload leaves orphan chunks (best-effort deleted) and
 * no upload — which reads correctly to every caller as "there is no such
 * upload", rather than as a file that is silently short.
 *
 * ## A STREAMED upload is the deliberate exception, and `complete` is the price
 *
 * `create` cannot serve a run that wants to start before the bytes are in: it
 * mints the id at the END, and there is nothing to put in the run input. `stream`
 * is the other shape — the CALLER names the id, the record appears at the first
 * byte, and its `size` grows as chunks land.
 *
 * That is a real relaxation of the invariant above, so it is paid for explicitly
 * rather than quietly:
 *
 * - **The record carries `complete`.** For a streamed upload it is `false` until
 *   the last byte is stored; for a `create`d one it is `true` from the moment the
 *   record exists, because that is when the upload starts existing. So the two
 *   kinds are distinguishable by every reader, and a reader that does not care
 *   (the byte range routes, `readUpload`) needs no change.
 * - **A short read is the honest answer, not an error.** `readUpload` clamps its
 *   window to `size`, which for an in-flight upload is what has arrived. That
 *   behaviour predates streaming — it exists so a plan computed from a header can
 *   end one byte past the file — and it is exactly what a run reading ahead of the
 *   uplink needs.
 * - **An interrupted stream leaves an INCOMPLETE upload rather than none.** That
 *   is the part the old invariant was protecting against, and here it is the
 *   correct outcome: a run may already have transcribed the first half, and
 *   deleting it would throw that away. `complete` never becomes true, so nothing
 *   can mistake it for the whole file, and the caller's own abandonment bound is
 *   what ends the wait.
 * - **A chosen id may not collide.** `stream` refuses an id that already exists,
 *   so a second PUT cannot append to somebody else's upload.
 */

import { UPLOAD_CHUNK_BYTES, UPLOAD_ID_PREFIX } from "../sdk/constants.ts";
import type { UploadInfo, UploadReader } from "../sdk/step-uploads.ts";

/** The table one row per upload lives in. Prefixed so it cannot collide with an app's own. */
export const UPLOADS_TABLE = "aai_workflow_uploads";
/** The table the bytes live in, one `UPLOAD_CHUNK_BYTES` piece per row. */
export const UPLOAD_CHUNKS_TABLE = "aai_workflow_upload_chunks";

/** Raised by an upload store's `create` when the body ran past its cap. */
export class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`upload exceeds ${limit} bytes`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Raised by `stream` when the caller's chosen id is already taken.
 *
 * Its own error because the ROUTE has to answer 409: the request is well formed and
 * the id is simply not available, which a client retrying a `PUT` after a lost
 * response needs to tell apart from having composed the request wrong.
 */
export class UploadIdTakenError extends Error {
  constructor(id: string, options?: { cause?: unknown }) {
    // The cause is optional because the two backends learn this two different
    // ways: Postgres reads the row back and has nothing to attach, while the file
    // backend learns it from a failed exclusive `open` whose errno is worth
    // keeping — an `EACCES` there is a broken store, not a taken id.
    super(`upload ${id} already exists`, options);
    this.name = UploadIdTakenError.name;
  }
}

/** What an uploader declares about the file it is sending. */
export type UploadMeta = {
  /** Filename, as the browser reported it. Stored, never interpreted. */
  name?: string | undefined;
  /** MIME type the uploader declared. Stored, never sniffed. */
  type?: string | undefined;
};

/** The store, as the API routes and `readUpload` use it. */
export type UploadStore = UploadReader & {
  /**
   * Store one file, streaming it in.
   *
   * @throws {UploadTooLargeError} once more than `limit` bytes have arrived —
   *   raised as the stream runs, so an oversized body is never held.
   */
  create(
    meta: UploadMeta,
    body: AsyncIterable<Uint8Array>,
    opts?: { limit?: number },
  ): Promise<UploadInfo>;
  /**
   * Store one file under an id the CALLER chose, readable as it arrives.
   *
   * The record exists from the first byte with `complete: false`, so a run can be
   * started on this id before the upload finishes and read whatever has landed —
   * see the module doc for what that relaxes and how it is paid for.
   *
   * Resolves with the FINISHED record. A failure leaves the upload in place and
   * incomplete, deliberately: a reader may already have used the first half.
   *
   * @throws {UploadIdTakenError} when `id` already names an upload.
   * @throws {UploadTooLargeError} once more than `limit` bytes have arrived.
   */
  stream(
    id: string,
    meta: UploadMeta,
    body: AsyncIterable<Uint8Array>,
    opts?: { limit?: number },
  ): Promise<UploadInfo>;
};

/** A fresh upload id. Prefixed so a stray value in a log reads as what it is. */
export function newUploadId(): string {
  return `${UPLOAD_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Read a body into `UPLOAD_CHUNK_BYTES` pieces, refusing anything past `limit`.
 *
 * Shared by both backends because the SPLIT is the contract — a chunk's size is
 * what a range read's cost is measured in — while where the pieces go is not.
 * Counted as it arrives rather than from a declared length, the same rule
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
