// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload store: one record, bytes as objects — and NEITHER half names where it
 * lives.
 *
 * The ONLY store, written over two interfaces: {@link UploadRecords} for the
 * record (who the upload is, how much of it is readable, whether that is all of
 * it, and which objects hold which windows) and {@link UploadBackend} for the bytes.
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
 * {@link UploadStore.recordParts} is the direct path's write, and its body is
 * nothing: the bytes are already in the bucket. So the store asks the bucket how
 * big the object is before it records the window. A client that claimed a part it
 * never uploaded would otherwise advance `size` past a hole, and a step reading
 * there gets silence rather than an error — a transcript with a gap in it and
 * nothing anywhere reporting one. `UploadBackend.size` never over-reports, so that
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

import {
  assertUploadToken,
  mapStream,
  type OpenUpload,
  UPLOAD_PART_BYTES,
} from "@alexkroman1/aai/host-internal";
import { mapConcurrent, type UploadInfo } from "@alexkroman1/aai/step";
import { createKeyedLock, omitUndefined, withLock } from "@alexkroman1/aai/utils";
import {
  partKey,
  partsCovering,
  rangesOf,
  type UploadBackend,
  type UploadPart,
} from "./_upload-blobs.ts";
import { concat, once, windows } from "./_upload-byte-util.ts";
import { assertUploadOpen, declaredTotal, measuredPart } from "./_upload-parts-checks.ts";
import type { UploadRecord, UploadRecords } from "./_upload-records.ts";
import {
  assertPartOffset,
  assertPartTotal,
  contiguousBytes,
  newUploadId,
  UnknownUploadError,
  UPLOAD_PROBE_CONCURRENCY,
  UPLOAD_WINDOW_CONCURRENCY,
  UploadCompleteError,
  UploadPartError,
  type UploadStore,
  UploadTooLargeError,
} from "./_upload-store.ts";

/**
 * What a merge produces: the row to write, and the answer to give the caller.
 *
 * `state` is EXACTLY {@link UploadRecords.update}'s parameter and nothing more,
 * which is load-bearing rather than tidy: the file home writes `{ ...held,
 * ...state }`, so any extra key on the object handed to `update` is persisted into
 * the record verbatim. Returning one object with `info` alongside the three
 * columns would put a whole `UploadInfo` in a dev deployment's upload JSON.
 */
type MergedParts = {
  state: { parts: UploadPart[]; size: number; complete: boolean };
  info: UploadInfo;
};

/**
 * Build the store.
 *
 * `prefix` is where this deployment's objects live in the bucket — the platform
 * passes an agent-scoped one, so a key can never name another app's object even
 * though the bucket is shared.
 */
export function createBlobUploadStore(opts: {
  records: UploadRecords;
  blobs: UploadBackend;
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
   * Add windows to the record and publish what they make readable.
   *
   * The one place `parts` is written, and the only thing that decides `size` and
   * `complete` — so a part landing out of order advances neither until the gap in
   * front of it closes.
   *
   * **It takes a LIST because the lock and the write are the per-request costs,
   * not the per-part ones.** One acquisition, one read, one whole-array write,
   * however many windows the caller landed — which is what makes
   * {@link UploadStore.recordParts} worth batching over the wire. Adding one
   * window is the same call with one element, so there is one merge rule rather
   * than two.
   *
   * **`held` is the record READ UNDER THIS LOCK, and the parameter is what stops
   * it being read twice.** A caller that already has to inspect the record before
   * it can measure anything — {@link UploadStore.recordParts}, which needs the
   * declared total to check a window against — used to read it, and then this
   * read it again inside the lock, so a claim carrying no bytes cost THREE
   * round trips to the record's home. That second read exists for staleness, and
   * a caller holding the lock across its own read cannot be stale: nothing else
   * may write `parts` for this id while the lock is held. So the read moves to
   * whoever takes the lock, and this merges what it is given.
   */
  function mergeParts(id: string, held: UploadRecord, added: readonly UploadPart[]): MergedParts {
    const replaced = new Set(added.map((one) => one.at));
    const parts = [...held.parts.filter((one) => !replaced.has(one.at)), ...added];
    const size = contiguousBytes(rangesOf(parts));
    // A declared total is the ONLY thing that can make an upload complete here. A
    // streamed one declares none, and its prefix reaching its own length says
    // nothing — every window satisfies that — so its `complete` is left alone and
    // `stream` sets it when the BODY ends, which is the only moment anything knows
    // there is no more coming.
    const complete = held.expected === undefined ? held.complete : size >= held.expected;
    return { state: { parts, size, complete }, info: info(id, { ...held, parts, complete }, size) };
  }

  /**
   * {@link mergeParts} for a caller that holds no record: take the lock, read,
   * merge, write.
   *
   * The shape every path except {@link UploadStore.recordParts} wants — a window
   * whose bytes this process just wrote, with nothing about the record inspected
   * beforehand. The re-read is INSIDE the lock because the copy a caller read
   * before the bytes went is stale by exactly the parts that landed while they
   * did.
   */
  async function addParts(id: string, added: readonly UploadPart[]): Promise<UploadInfo> {
    return await withLock(boundaries, id, async () => {
      const held = await records.read(id);
      if (!held) throw new UnknownUploadError(id);
      const merged = mergeParts(id, held, added);
      await records.update(id, merged.state);
      return merged.info;
    });
  }

  /**
   * Cut a body into window objects as it streams, adding each to the record.
   *
   * `UPLOAD_PART_BYTES` windows, which is the same size the browser's fan-out
   * uses — so one byte layout serves every route an upload can arrive by, and
   * `read` maps a window onto objects without asking how the bytes got here.
   *
   * **A PUBLISHED cut ramps up to that size; a `create` cut does not.** `publish`
   * decides both, and it is one flag rather than two because the two conditions are
   * the same one from either side. Only a published window's arrival is OBSERVABLE
   * — `create`'s record does not exist until the last byte is stored — and only a
   * published cut may be non-uniform, because `create` derives its boundary list
   * from {@link windowList}, which assumes the grid. See {@link windows} for what
   * the ramp buys and what it costs.
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
   * A published (streamed) upload's `size` advances in JUMPS either way: `addParts`
   * merges boundaries under the id's lock and `contiguousBytes` counts only from
   * byte zero, so a window that lands ahead of its predecessor is stored and simply
   * not yet readable. A reader never sees a size covering a hole; what the ramp
   * changes is how big the first jumps are.
   */
  async function putWindows(
    id: string,
    body: AsyncIterable<Uint8Array>,
    limit: number,
    publish: boolean,
  ): Promise<number> {
    let size = 0;
    const written = mapStream(
      windows(body, limit, publish),
      UPLOAD_WINDOW_CONCURRENCY,
      async ({ at, bytes }) => {
        const stored = await blobs.put(key(id, at), once(bytes), { limit });
        if (publish) await addParts(id, [{ at, bytes: stored }]);
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
      // upload leaves objects nothing can reach; on the platform, `aai-sweep-blob-gc`'s
      // uploads arm is the sweep that reclaims them. **This ordering is why that arm
      // needs a grace window at all** — every other method here writes the row first,
      // so this is the only one whose bytes ever exist unrecorded.
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
      return await addParts(id, [{ at: offset, bytes }]);
    },

    async recordParts(id, offsets): Promise<UploadInfo> {
      await records.ensure();
      if (offsets.length === 0) {
        throw new UploadPartError(`A claim on upload ${id} named no parts.`);
      }
      // Before anything is measured, because a batch naming the same byte twice is a
      // caller that has lost track of its own windows — and the merge below would
      // quietly keep whichever copy came last rather than saying so.
      if (new Set(offsets).size !== offsets.length) {
        throw new UploadPartError(`A claim on upload ${id} named the same part twice.`);
      }
      for (const offset of offsets) assertPartOffset(offset);
      // THE WHOLE CLAIM IS ONE LOCKED SECTION, and that is what makes it ONE read.
      //
      // This used to be a read for the declared total, then the probes, then
      // `addParts` taking the lock and reading AGAIN for a list it could trust —
      // three round trips to the record's home for a request carrying no bytes, on
      // the path whose entire purpose is to carry no bytes. Reading inside the lock
      // collapses the two, because the second one only ever existed to answer
      // staleness and nothing may write this id's `parts` while the lock is held.
      //
      // What it costs is that a second claim on the SAME upload waits out this
      // one's probes rather than overlapping them. That is not a path any client
      // takes — `createClaimer` keeps at most one claim in flight and coalesces the
      // rest — and where it does happen (two tabs resuming one caller-named id) it
      // is the more correct answer: measuring and recording become atomic per
      // upload, where before two claims naming overlapping windows could interleave
      // between their probes and their merge.
      return await withLock(boundaries, id, async () => {
        // THE READ AND THE PROBES OVERLAP, because neither needs the other. The
        // record answers "what did this upload declare"; the bucket answers "how big
        // is the object at this key" — and a key is composed from the id and the
        // offset, both of which the request carried. Run in sequence they were
        // 600 ms then 400 ms on the harness; run together they are 600 ms, and the
        // probes are free.
        //
        // What it costs is one wasted round of `HEAD`s when the record turns out not
        // to exist, or not to be a parts upload. Both are client errors, both are
        // bounded by `UPLOAD_CLAIM_BATCH`, and a `HEAD` for an absent object is the
        // cheapest request the bucket serves — against which the alternative is
        // paying the serialization on every SUCCESSFUL claim.
        const [held, sizes] = await Promise.all([
          records.read(id),
          // Asked of the BUCKET, never taken from the caller — see the module doc. A
          // part nobody uploaded is a 400 rather than a hole that reads as silence.
          // Concurrent because these are independent probes of independent objects
          // that carry no bytes at all, which is why the width is
          // `UPLOAD_PROBE_CONCURRENCY` and not the byte path's — that constant's doc
          // has the round-count measurement.
          mapConcurrent(
            offsets,
            UPLOAD_PROBE_CONCURRENCY,
            async (offset) => await blobs.size(key(id, offset)),
          ),
        ]);
        // The RECORD's refusals first, so an upload nobody began is still a 404 and
        // not whichever probe happened to come back empty. `size` answers
        // `undefined` for an absent object rather than throwing, so this ordering is
        // a choice about which error to report and never a race.
        if (!held) throw new UnknownUploadError(id);
        // Asked about the largest offset because that is the one its own
        // past-the-total check can fail on; every smaller offset in the batch is
        // covered by the same answer.
        const total = declaredTotal(id, held, Math.max(...offsets));
        // Every window is checked before ANY is written — see the interface's "all or
        // nothing". A batch holding one bad offset throws here and records none of
        // itself, which is the same guarantee the concurrent callback used to give by
        // rejecting early; the checks moved out of it so they can see a total the
        // probes did not have to wait for.
        const measured = offsets.map((offset, n) => measuredPart(id, offset, sizes[n], total));
        // A FINISHED upload is closed to further windows — but a claim that names
        // only what is already recorded is a re-send whose answer was lost, and
        // failing that would end an upload whose every byte is stored. See the
        // interface's "a claim on a FINISHED upload is a no-op unless it would
        // CHANGE something": this is the one write that can tell the two apart,
        // because the probes above measured every named window before anything is
        // merged.
        if (held.complete) {
          if (measured.every((one) => recorded(held.parts, one))) return info(id, held);
          throw new UploadCompleteError(id);
        }
        const merged = mergeParts(id, held, measured);
        await records.update(id, merged.state);
        return merged.info;
      });
    },

    // All THREE reads go through one look-up of the record, which is what makes the
    // count answerable at all — `read`'s own `id` parameter is the reason it used to
    // resolve the row for itself, once per chunk of a download.
    open: openRecord,
    info: async (id) => (await openRecord(id))?.info,
    read: async (id, start, end) =>
      (await (await openRecord(id))?.read(start, end)) ?? new Uint8Array(0),
  };

  /**
   * The record, and a reader over the windows THAT record named.
   *
   * The boundary list is PINNED for as long as the caller holds it — see
   * {@link OpenUpload}. One look-up per read operation rather than one per chunk,
   * and a part landing mid-download can no longer answer bytes the response's own
   * `Content-Length` already promised were something else.
   *
   * One blob read per object a window overlaps, in order. A window inside a single
   * part is one read, which is the ordinary case: a header probe, or a segment cut
   * to the part size.
   */
  async function openRecord(id: string): Promise<OpenUpload | undefined> {
    await records.ensure();
    const held = await records.read(id);
    if (!held) return;
    return {
      info: info(id, held),
      read: async (start, end) => {
        const wanted = partsCovering(held.parts, start, end);
        const pieces = await Promise.all(
          wanted.map(async ({ part, from, to }) => await blobs.read(key(id, part.at), from, to)),
        );
        return concat(
          pieces,
          pieces.reduce((total, piece) => total + piece.length, 0),
        );
      },
    };
  }

  /**
   * The declared shape a part has to fit, or the reason it cannot.
   *
   * "Already finished" is one of those reasons, and it is checked HERE rather than
   * beside the `put` because this is the read: a window whose upload is closed must
   * not reach the bucket at all, or the refusal arrives after the bytes it was
   * supposed to keep out. See {@link assertUploadOpen}.
   *
   * **KIND before STATE**, so the two refusals do not shadow each other. A finished
   * STREAMED or whole-file upload is both "not a parts upload" (400) and "complete"
   * (409), and the first is the more specific answer — a client cannot add parts to
   * one at any point in its life, complete or not. Reversing the order would move
   * that case's status the moment the body ended.
   */
  async function declared(id: string, offset: number): Promise<{ type: string; total: number }> {
    const held = await records.read(id);
    if (!held) throw new UnknownUploadError(id);
    const total = declaredTotal(id, held, offset);
    assertUploadOpen(id, held);
    return { type: held.type, total };
  }
}

/**
 * Whether this window is ALREADY in the record, byte for byte.
 *
 * What makes a re-sent claim on a finished upload a no-op rather than a refusal.
 * Both fields have to match: an offset alone would let a replacement of a DIFFERENT
 * length pass as a repeat, which is the rewrite `UploadCompleteError` exists to
 * refuse.
 */
function recorded(parts: readonly UploadPart[], one: UploadPart): boolean {
  return parts.some((part) => part.at === one.at && part.bytes === one.bytes);
}

/** The windows a whole-file write of `size` bytes produced, in order. */
function windowList(size: number): UploadPart[] {
  const parts: UploadPart[] = [];
  for (let at = 0; at < size; at += UPLOAD_PART_BYTES) {
    parts.push({ at, bytes: Math.min(UPLOAD_PART_BYTES, size - at) });
  }
  return parts;
}
