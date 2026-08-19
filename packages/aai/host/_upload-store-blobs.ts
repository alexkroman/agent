// Copyright 2026 the AAI authors. MIT license.
/**
 * The upload store: one metadata row in the app's database, bytes as objects.
 *
 * The ONLY store. There used to be two — chunk rows in Postgres, files under
 * `aai dev` — and both held the bytes themselves. `_upload-blobs.ts` carries why
 * they are gone; what this module owns is the half that stayed in Postgres, which
 * is the record: who the upload is, how much of it is readable, whether that is
 * all of it, and which objects hold which windows.
 *
 * ## The row is the record; the bucket is the bytes
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
 * process serves one sandbox's routes. The file store serialized its sidecar the
 * same way and for the same reason.
 */

import type { Db } from "../sdk/db.ts";
import { createKeyedLock, withLock } from "../sdk/keyed-lock.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { assertUploadToken, type UploadInfo } from "../sdk/step-uploads.ts";
import { UPLOAD_PART_BYTES } from "../sdk/upload-constants.ts";
import { ensureOnce } from "./_ensure-once.ts";
import {
  partKey,
  partsCovering,
  partsOf,
  rangesOf,
  type UploadBlobs,
  type UploadPart,
} from "./_upload-blobs.ts";
import {
  assertPartOffset,
  assertPartTotal,
  chunked,
  concat,
  contiguousBytes,
  newUploadId,
  UnknownUploadError,
  UPLOADS_TABLE,
  UploadIdTakenError,
  UploadPartError,
  type UploadStore,
  UploadTooLargeError,
} from "./_upload-store.ts";

/** What one upload's row holds beyond {@link UploadInfo}. */
type StoredRow = {
  name: string;
  type: string;
  complete: boolean;
  expected: string | null;
  /**
   * The boundary list AS THE DRIVER GIVES IT — a `::text` string, so `unknown` here and
   * `partsOf` at every read. See `partsOf` for the bug that made this explicit.
   */
  parts: unknown;
};

/**
 * Build the store.
 *
 * `prefix` is where this deployment's objects live in the bucket — the platform
 * passes an agent-scoped one, so a key can never name another app's object even
 * though the bucket is shared.
 */
export function createBlobUploadStore(opts: {
  db: Db;
  blobs: UploadBlobs;
  prefix: string;
  maxBytes: number;
}): UploadStore {
  const { db, blobs, prefix, maxBytes } = opts;
  // Serialized per upload, because every write is a read-modify-write of one row's
  // `parts` — see the module doc.
  const boundaries = createKeyedLock();

  const ensureTables = ensureOnce(async () => {
    // Created lazily and idempotently rather than by a migration step, for the
    // reason `workflow-keys.ts` gives: an agent's first workflow may be its first
    // ever deploy, and there is no provisioning pass to hang a DDL step off.
    await db.query(`create table if not exists ${UPLOADS_TABLE} (
      id text primary key,
      name text not null default '',
      type text not null default '',
      size bigint not null,
      complete boolean not null default true,
      expected bigint,
      parts jsonb,
      created_at timestamptz not null default now()
    )`);
    // ADDED by `alter`, because `create table if not exists` is a NO-OP against a
    // table that already exists — so an agent that stored an upload before this
    // column existed would keep a column-short table forever and every read would
    // fail on an unknown column. There is no chunk table to add: the only
    // deployments that ever had one are unreleased.
    await db.query(`alter table ${UPLOADS_TABLE} add column if not exists parts jsonb`);
  });

  const key = (id: string, at: number): string => partKey(prefix, id, at);

  /** The row, or undefined when nothing has begun under `id`. */
  async function row(id: string): Promise<(StoredRow & { size: string }) | undefined> {
    const rows = await db.query<StoredRow & { size: string }>(
      `select name, type, size, complete, expected, parts from ${UPLOADS_TABLE} where id = $1`,
      [id],
    );
    return rows[0];
  }

  /** The record as a caller sees it, derived from one row. */
  function record(id: string, held: StoredRow, size: number): UploadInfo {
    const complete = held.complete !== false;
    // Only while there is something to resume: a finished upload is covered end to
    // end, and a reader's answer to an absent list is to assume nothing — see
    // `UploadInfo.ranges`.
    const ranges = held.expected !== null && !complete ? rangesOf(partsOf(held.parts)) : undefined;
    return {
      id,
      name: held.name,
      type: held.type,
      size,
      complete,
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
      const held = await row(id);
      if (!held) throw new UnknownUploadError(id);
      const parts = [...partsOf(held.parts).filter((one) => one.at !== part.at), part];
      const size = contiguousBytes(rangesOf(parts));
      // A declared total is the ONLY thing that can make an upload complete here. A
      // streamed one declares none, and its prefix reaching its own length says
      // nothing — every window satisfies that — so its `complete` is left alone and
      // `stream` sets it when the BODY ends, which is the only moment anything knows
      // there is no more coming.
      const complete =
        held.expected === null ? held.complete !== false : size >= Number(held.expected);
      await db.query(
        // `$2::text::jsonb`, NOT `$2::jsonb` — see `partsOf` for what the missing
        // `::text` stored.
        `update ${UPLOADS_TABLE} set parts = $2::text::jsonb, size = $3, complete = $4
         where id = $1`,
        [id, JSON.stringify(parts), size, complete],
      );
      // The merged list as an ARRAY, not the string that was read: `record` goes back
      // through `partsOf`, which accepts either.
      return record(id, { ...held, parts, complete }, size);
    });
  }

  /**
   * Claim an id, refusing one that is already held.
   *
   * `returning id` rather than a read-back: a row comes back only when THIS
   * statement inserted it, so an id already held is refused even by a caller
   * declaring an identical upload — which is what makes a caller-chosen id safe.
   */
  async function claim(
    id: string,
    meta: { name: string; type: string },
    expected: number | null,
    complete: boolean,
  ): Promise<void> {
    const claimed = await db.query<{ id: string }>(
      `insert into ${UPLOADS_TABLE} (id, name, type, size, complete, expected, parts)
       values ($1, $2, $3, 0, $4, $5, '[]'::jsonb) on conflict (id) do nothing returning id`,
      [id, meta.name, meta.type, complete, expected],
    );
    if (claimed.length === 0) throw new UploadIdTakenError(id);
  }

  /**
   * Cut a body into window objects as it streams, adding each to the record.
   *
   * `UPLOAD_PART_BYTES` windows, which is the same size the browser's fan-out
   * uses — so one byte layout serves every route an upload can arrive by, and
   * `read` maps a window onto objects without asking how the bytes got here.
   */
  async function putWindows(
    id: string,
    body: AsyncIterable<Uint8Array>,
    limit: number,
    publish: boolean,
  ): Promise<number> {
    let at = 0;
    for await (const window of windows(body, limit)) {
      const bytes = await blobs.put(key(id, at), once(window), { limit });
      if (publish) await addPart(id, { at, bytes });
      at += bytes;
    }
    return at;
  }

  return {
    async create(meta, body, options): Promise<UploadInfo> {
      await ensureTables();
      const id = newUploadId();
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // The windows go up FIRST and the row last, so an upload exists only once all
      // of its bytes do — the invariant the chunk store had, unchanged. A torn
      // upload leaves objects nothing can reach; the sweep that reclaims them is
      // not written.
      const size = await putWindows(id, body, options?.limit ?? maxBytes, false);
      await db.query(
        // `$5::text::jsonb` for the reason `addPart`'s update carries — `partsOf` owns it.
        `insert into ${UPLOADS_TABLE} (id, name, type, size, complete, parts)
         values ($1, $2, $3, $4, true, $5::text::jsonb)`,
        [id, name, type, size, JSON.stringify(windowList(size))],
      );
      return { id, name, type, size, complete: true };
    },

    async stream(id, meta, body, options): Promise<UploadInfo> {
      await ensureTables();
      // Validated here as well as at the route: this id becomes part of an object
      // KEY, so a token that escaped the check would address another prefix.
      assertUploadToken(id);
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // The row goes FIRST here, which is the whole point of this method: the record
      // has to exist before the bytes do, so a run can be started on it and read
      // what has arrived.
      await claim(id, { name, type }, null, false);
      const size = await putWindows(id, body, options?.limit ?? maxBytes, true);
      await db.query(`update ${UPLOADS_TABLE} set size = $2, complete = true where id = $1`, [
        id,
        size,
      ]);
      return { id, name, type, size, complete: true };
    },

    async beginParts(id, meta, total, options): Promise<UploadInfo> {
      await ensureTables();
      assertUploadToken(id);
      assertPartTotal(total, options?.limit ?? maxBytes);
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // An upload of NO bytes is finished the moment it is declared: no part can
      // ever arrive to close it, so anything else is a record that waits forever.
      await claim(id, { name, type }, total, total === 0);
      return { id, name, type, size: 0, complete: total === 0 };
    },

    async writePart(id, offset, body): Promise<UploadInfo> {
      await ensureTables();
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
      await ensureTables();
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
      await ensureTables();
      const held = await row(id);
      // `bigint` comes back as a string from the driver — `Number` rather than
      // trusting the shape, so a column type change is a NaN here instead of a
      // string silently used as a byte count.
      return held ? record(id, held, Number(held.size)) : undefined;
    },

    async read(id, start, end): Promise<Uint8Array> {
      await ensureTables();
      const held = await row(id);
      if (!held) return new Uint8Array(0);
      const wanted = partsCovering(partsOf(held.parts), start, end);
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
    const held = await row(id);
    if (!held) throw new UnknownUploadError(id);
    if (held.expected === null) {
      throw new UploadPartError(`Upload ${id} was not begun as a parts upload.`);
    }
    const total = Number(held.expected);
    if (offset > total) {
      throw new UploadPartError(`A part at ${offset} starts past this upload's ${total} bytes.`);
    }
    return { type: held.type, total };
  }
}

/** A body as `UPLOAD_PART_BYTES` windows, refusing anything past `limit`. */
async function* windows(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncGenerator<Uint8Array> {
  let held: Uint8Array[] = [];
  let bytes = 0;
  for await (const piece of chunked(body, limit)) {
    held.push(piece);
    bytes += piece.length;
    if (bytes >= UPLOAD_PART_BYTES) {
      yield concat(held, bytes);
      held = [];
      bytes = 0;
    }
  }
  if (bytes > 0) yield concat(held, bytes);
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
