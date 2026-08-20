// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload store: one record, bytes as objects — and NEITHER half names where it
 * lives.
 *
 * The ONLY store, written over two interfaces: {@link UploadRecords} for the
 * record (who the upload is, how much of it is readable, whether that is all of
 * it, and which objects hold which windows) and {@link UploadBlobs} for the bytes.
 * Each has two implementations, and the pairing is decided once — in
 * `workflow-uploads.ts` — by whether the deployment has a `DATABASE_URL`: the
 * app's own database plus a bucket when it does, the local workflow world's data
 * directory when it does not (`_upload-files.ts`, which carries why that is not
 * the file backend this store used to have).
 *
 * ## The record is the record; the bucket is the bytes
 *
 * Splitting them is what makes a part's arrival cheap. A part goes from the
 * browser straight to the bucket, so the only thing that crosses the guest is one
 * small `update` naming a window that landed — no bytes, no chunk rows, and
 * nothing on the connection pool proportional to the file.
 *
 * `parts` is the raw boundary list rather than the merged {@link UploadInfo.ranges}
 * because a merge loses which OBJECT holds a byte: two adjacent parts are one
 * range and two objects. `ranges` is derived on the way out, and `size` is derived
 * from that — the contiguous prefix, which is the one number a reader may act on.
 *
 * ## A part is RECORDED, not believed
 *
 * {@link UploadStore.recordPart} is the direct path's write, and its body is
 * nothing: the bytes are already in the bucket. So the store asks the bucket how
 * big the object is before it records the window. A client that claimed a part it
 * never uploaded would otherwise advance `size` past a hole, and a step reading
 * there gets silence rather than an error — a transcript with a gap in it and
 * nothing anywhere reporting one. `UploadBlobs.size` never over-reports, so that
 * one question is the whole defence.
 *
 * ## Why the boundary merge is under a LOCK
 *
 * Parts land concurrently and each one reads `parts`, adds its window, and writes
 * it back — the read-modify-write that interleaves at every `await` and silently
 * drops an arrival. `ctx.db` exposes one method and no transaction, and the pool
 * gives no connection affinity, so `SELECT … FOR UPDATE` is not available to us
 * here; `createKeyedLock` per upload id is, and it is sound because one guest
 * process serves one sandbox's routes. It is also what the file home relies on
 * outright — a JSON record has no atomic read-modify-write of its own — which is
 * why the lock lives HERE, above both implementations, rather than in either.
 */

import { mapStream } from "../sdk/_map-stream.ts";
import { createKeyedLock, withLock } from "../sdk/keyed-lock.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { assertUploadToken, type UploadInfo } from "../sdk/step-uploads.ts";
import { UPLOAD_PART_BYTES } from "../sdk/upload-constants.ts";
import {
  partKey,
  partsCovering,
  rangesOf,
  type UploadBlobs,
  type UploadPart,
} from "./_upload-blobs.ts";
import type { UploadRecord, UploadRecords } from "./_upload-records.ts";
import {
  assertPartOffset,
  assertPartTotal,
  chunked,
  concat,
  contiguousBytes,
  newUploadId,
  UnknownUploadError,
  UPLOAD_WINDOW_CONCURRENCY,
  UploadPartError,
  type UploadStore,
  UploadTooLargeError,
} from "./_upload-store.ts";

/** One cut window and the byte it starts at — see {@link windows}. */
type PlacedWindow = { at: number; bytes: Uint8Array };

/**
 * Build the store.
 *
 * `prefix` is where this deployment's objects live in the bucket — the platform
 * passes an agent-scoped one, so a key can never name another app's object even
 * though the bucket is shared.
 */
export function createBlobUploadStore(opts: {
  records: UploadRecords;
  blobs: UploadBlobs;
  prefix: string;
  maxBytes: number;
}): UploadStore {
  const { records, blobs, prefix, maxBytes } = opts;
  // Serialized per upload, because every write is a read-modify-write of one row's
  // `parts` — see the module doc.
  const boundaries = createKeyedLock();

  const key = (id: string, at: number): string => partKey(prefix, id, at);

  /** What a caller sees, derived from one record. */
  function info(id: string, held: UploadRecord, size = held.size): UploadInfo {
    // Only while there is something to resume: a finished upload is covered end to
    // end, and a reader's answer to an absent list is to assume nothing — see
    // `UploadInfo.ranges`.
    const ranges = held.expected !== undefined && !held.complete ? rangesOf(held.parts) : undefined;
    return {
      id,
      name: held.name,
      type: held.type,
      size,
      complete: held.complete,
      ...omitUndefined({ ranges }),
    };
  }

  /**
   * Add one window to the record and publish what it makes readable.
   *
   * The one place `parts` is written, and the only thing that decides `size` and
   * `complete` — so a part landing out of order advances neither until the gap in
   * front of it closes.
   */
  async function addPart(id: string, part: UploadPart): Promise<UploadInfo> {
    return await withLock(boundaries, id, async () => {
      // Re-read INSIDE the lock: the copy read before the bytes went is stale by
      // exactly the parts that landed while they did.
      const held = await records.read(id);
      if (!held) throw new UnknownUploadError(id);
      const parts = [...held.parts.filter((one) => one.at !== part.at), part];
      const size = contiguousBytes(rangesOf(parts));
      // A declared total is the ONLY thing that can make an upload complete here. A
      // streamed one declares none, and its prefix reaching its own length says
      // nothing — every window satisfies that — so its `complete` is left alone and
      // `stream` sets it when the BODY ends, which is the only moment anything knows
      // there is no more coming.
      const complete = held.expected === undefined ? held.complete : size >= held.expected;
      await records.update(id, { parts, size, complete });
      return info(id, { ...held, parts, complete }, size);
    });
  }

  /**
   * Cut a body into window objects as it streams, adding each to the record.
   *
   * `UPLOAD_PART_BYTES` windows, which is the same size the browser's fan-out
   * uses — so one byte layout serves every route an upload can arrive by, and
   * `read` maps a window onto objects without asking how the bytes got here.
   *
   * ## The windows go up CONCURRENTLY, and the socket keeps filling while they do
   *
   * This was a loop — read a window, write it, repeat — and a loop of that shape
   * uses one link at a time: the bucket sat idle for however long 8 MiB takes to
   * arrive, and then the uplink sat idle for however long the bucket takes to
   * acknowledge it. Neither wait is bandwidth, so overlapping them is close to
   * free: {@link UPLOAD_WINDOW_CONCURRENCY} writes are in flight while the next
   * window is being read off the wire.
   *
   * **What bounds memory is the window's WIDTH, not the arrival rate.**
   * `mapStream` pulls the next window only once a slot has freed, so peak usage
   * here is `UPLOAD_WINDOW_CONCURRENCY * UPLOAD_PART_BYTES` plus the one being
   * assembled — a number this module chooses, rather than one the sender does.
   *
   * **Nothing about retry changes**, which is the property this had to keep: a
   * window is still buffered whole before its `put` starts, so the bytes are in
   * hand for as long as the write takes and a failed one can be re-sent by
   * whoever owns the failure. Overlapping the writes only decides WHEN each one
   * runs, never what it holds.
   *
   * A published (streamed) upload's `size` advances in the same jumps it already
   * did for a parts upload: `addPart` merges boundaries under the id's lock and
   * `contiguousBytes` counts only from byte zero, so a window that lands ahead of
   * its predecessor is stored and simply not yet readable. That is the same
   * guarantee as before — a reader never sees a size covering a hole — reached by
   * the same code.
   */
  async function putWindows(
    id: string,
    body: AsyncIterable<Uint8Array>,
    limit: number,
    publish: boolean,
  ): Promise<number> {
    let size = 0;
    const written = mapStream(
      windows(body, limit),
      UPLOAD_WINDOW_CONCURRENCY,
      async ({ at, bytes }) => {
        const stored = await blobs.put(key(id, at), once(bytes), { limit });
        if (publish) await addPart(id, { at, bytes: stored });
        return stored;
      },
    );
    for await (const bytes of written) size += bytes;
    return size;
  }

  return {
    async create(meta, body, options): Promise<UploadInfo> {
      await records.ensure();
      const id = newUploadId();
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // The windows go up FIRST and the row last, so an upload exists only once all
      // of its bytes do — the invariant the chunk store had, unchanged. A torn
      // upload leaves objects nothing can reach; the sweep that reclaims them is
      // not written.
      const size = await putWindows(id, body, options?.limit ?? maxBytes, false);
      await records.insert(id, {
        name,
        type,
        size,
        complete: true,
        parts: windowList(size),
      });
      return { id, name, type, size, complete: true };
    },

    async stream(id, meta, body, options): Promise<UploadInfo> {
      await records.ensure();
      // Validated here as well as at the route: this id becomes part of an object
      // KEY, so a token that escaped the check would address another prefix.
      assertUploadToken(id);
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // The row goes FIRST here, which is the whole point of this method: the record
      // has to exist before the bytes do, so a run can be started on it and read
      // what has arrived.
      await records.claim(id, { name, type, size: 0, complete: false, parts: [] });
      const size = await putWindows(id, body, options?.limit ?? maxBytes, true);
      await records.finish(id, size);
      return { id, name, type, size, complete: true };
    },

    async beginParts(id, meta, total, options): Promise<UploadInfo> {
      await records.ensure();
      assertUploadToken(id);
      assertPartTotal(total, options?.limit ?? maxBytes);
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // An upload of NO bytes is finished the moment it is declared: no part can
      // ever arrive to close it, so anything else is a record that waits forever.
      await records.claim(id, {
        name,
        type,
        size: 0,
        complete: total === 0,
        expected: total,
        parts: [],
      });
      return { id, name, type, size: 0, complete: total === 0 };
    },

    async writePart(id, offset, body): Promise<UploadInfo> {
      await records.ensure();
      assertPartOffset(offset);
      const held = await declared(id, offset);
      // The refusal is a {@link UploadPartError} rather than the
      // {@link UploadTooLargeError} `put` raises: nothing about the FILE is too large
      // here — the caller contradicted its own declared total, which is a 400 and not
      // a 413, and a client retrying a 413 is retrying something that can never be
      // accepted.
      const bytes = await blobs
        .put(key(id, offset), body, { type: held.type, limit: Math.max(0, held.total - offset) })
        .catch((err: unknown) => {
          if (err instanceof UploadTooLargeError) {
            throw new UploadPartError(
              `A part at ${offset} runs past the ${held.total} bytes this upload declared.`,
              { cause: err },
            );
          }
          throw err;
        });
      return await addPart(id, { at: offset, bytes });
    },

    async recordPart(id, offset): Promise<UploadInfo> {
      await records.ensure();
      assertPartOffset(offset);
      const held = await declared(id, offset);
      // Asked of the BUCKET, never taken from the caller — see the module doc. A
      // part nobody uploaded is a 400 rather than a hole that reads as silence.
      const bytes = await blobs.size(key(id, offset));
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
      if (bytes === 0 && held.total > 0) {
        throw new UploadPartError(
          `The part at ${offset} of upload ${id} measured 0 bytes, but the upload declares ` +
            `${held.total}. Recording it would leave a hole that reads as silence.`,
        );
      }
      if (offset + bytes > held.total) {
        throw new UploadPartError(
          `The part at ${offset} holds ${bytes} bytes, which runs past this upload's ${held.total}.`,
        );
      }
      return await addPart(id, { at: offset, bytes });
    },

    async info(id): Promise<UploadInfo | undefined> {
      await records.ensure();
      const held = await records.read(id);
      return held ? info(id, held) : undefined;
    },

    async read(id, start, end): Promise<Uint8Array> {
      await records.ensure();
      const held = await records.read(id);
      if (!held) return new Uint8Array(0);
      const wanted = partsCovering(held.parts, start, end);
      // One read per object the window overlaps, in order. A window inside a single
      // part is one read, which is the ordinary case: a header probe, or a segment
      // cut to the part size.
      const pieces = await Promise.all(
        wanted.map(async ({ part, from, to }) => await blobs.read(key(id, part.at), from, to)),
      );
      return concat(
        pieces,
        pieces.reduce((total, piece) => total + piece.length, 0),
      );
    },
  };

  /** The declared shape a part has to fit, or the reason it cannot. */
  async function declared(id: string, offset: number): Promise<{ type: string; total: number }> {
    const held = await records.read(id);
    if (!held) throw new UnknownUploadError(id);
    if (held.expected === undefined) {
      throw new UploadPartError(`Upload ${id} was not begun as a parts upload.`);
    }
    const total = held.expected;
    if (offset > total) {
      throw new UploadPartError(`A part at ${offset} starts past this upload's ${total} bytes.`);
    }
    return { type: held.type, total };
  }
}

/**
 * A body as `UPLOAD_PART_BYTES` windows, refusing anything past `limit`.
 *
 * Each window carries the offset it starts at, which it knows and its consumer
 * would otherwise have to derive from the previous write's return value — i.e.
 * from a value that only exists once that write has finished. Yielding it here is
 * what lets the writes overlap: a window is addressable the moment it is cut.
 */
async function* windows(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<PlacedWindow> {
  let held: Uint8Array[] = [];
  let bytes = 0;
  let at = 0;
  for await (const piece of chunked(body, limit)) {
    held.push(piece);
    bytes += piece.length;
    if (bytes >= UPLOAD_PART_BYTES) {
      yield { at, bytes: concat(held, bytes) };
      at += bytes;
      held = [];
      bytes = 0;
    }
  }
  if (bytes > 0) yield { at, bytes: concat(held, bytes) };
}

/** One value as an iterable, so a window can be handed to `put` unchanged. */
async function* once(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

/** The windows a whole-file write of `size` bytes produced, in order. */
function windowList(size: number): UploadPart[] {
  const parts: UploadPart[] = [];
  for (let at = 0; at < size; at += UPLOAD_PART_BYTES) {
    parts.push({ at, bytes: Math.min(UPLOAD_PART_BYTES, size - at) });
  }
  return parts;
}
