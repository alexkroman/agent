// Copyright 2026 the AAI authors. MIT license.
/**
 * The Postgres upload backend: one metadata row, N chunk rows, and a range read that
 * slices inside the database.
 */

import type { Db } from "../sdk/db.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { assertUploadToken, type UploadInfo } from "../sdk/step-uploads.ts";
import { ensureOnce } from "./_ensure-once.ts";
import { batchEnd, type ChunkRow, inBatches, placed } from "./_upload-batches.ts";
import {
  assertPartOffset,
  assertPartTotal,
  type ByteRange,
  chunked,
  concat,
  newUploadId,
  partChunks,
  UnknownUploadError,
  UPLOAD_CHUNKS_TABLE,
  UPLOADS_TABLE,
  UploadIdTakenError,
  UploadPartError,
  type UploadStore,
} from "./_upload-store.ts";

/**
 * The most windows a record will report.
 *
 * A budget on the ISLANDS query, which is the only statement here whose result set
 * the caller sizes — see `coverage`. 256 is a 2 GiB upload at the default part size
 * cut into parts that all landed out of order and none of which merged, i.e. the
 * worst case a client using the defaults can construct. Past that the caller cut
 * far finer than the default, and telling them "re-send it" beats the alternative,
 * which was a statement over `MAX_DB_RESULT_ROWS` and therefore a 500 on every read
 * of that upload's record for as long as it existed.
 */
export const MAX_UPLOAD_RANGES = 256;

export function createPostgresUploadStore(db: Db, maxBytes: number): UploadStore {
  // Created lazily and idempotently rather than by a migration step, for the
  // reason `workflow-keys.ts` gives: an agent's first workflow may be its first
  // ever deploy, and there is no provisioning pass to hang a DDL step off.
  const ensureTables = ensureOnce(async () => {
    await db.query(`create table if not exists ${UPLOADS_TABLE} (
      id text primary key,
      name text not null default '',
      type text not null default '',
      size bigint not null,
      created_at timestamptz not null default now()
    )`);
    // ADDED by `alter`, not by the `create` above, because that statement is a
    // NO-OP against a table that already exists — so an agent that stored an
    // upload before streaming existed would keep a column-short table forever and
    // every read would fail on an unknown column. `default true` is what makes
    // every upload that predates this correct: it exists, so it is finished.
    await db.query(
      `alter table ${UPLOADS_TABLE} add column if not exists complete boolean not null default true`,
    );
    // Added the same way and for the same reason: an agent that stored an upload
    // before parts existed has a table this `create` will not touch. NULL is the
    // honest default — every upload that predates parts declared no total, and
    // that is exactly what makes `writePart` refuse to append to one.
    await db.query(`alter table ${UPLOADS_TABLE} add column if not exists expected bigint`);
    await db.query(`create table if not exists ${UPLOAD_CHUNKS_TABLE} (
      upload_id text not null,
      seq int not null,
      byte_offset bigint not null,
      bytes bytea not null,
      primary key (upload_id, seq)
    )`);
    // `bytea` defaults to `extended` storage, which means Postgres attempts LZ
    // compression on every one of these values before writing it. A chunk is a
    // megabyte of whatever the uploader sent, and what people upload here is
    // recorded audio and video — already compressed, or PCM, and neither pays for
    // the attempt. The guest doing it reserves ONE cpu, and it is the same cpu the
    // write path above is bounded by.
    //
    // Best-effort, and this is the one place in `ensureTables` that swallows: the
    // statement needs table ownership, and a store that refused to work because it
    // could not turn an OPTIMIZATION off would be strictly worse than a slower one.
    // It applies to values written from here on rather than rewriting what is
    // already stored, which is why it is safe to run on every boot.
    await db
      .query(`alter table ${UPLOAD_CHUNKS_TABLE} alter column bytes set storage external`)
      .catch(() => undefined);
  });

  /**
   * How many bytes are present from byte ZERO — the `size` every writer publishes.
   *
   * ONE row by construction, which is the property that matters: this runs on the
   * per-part write path, and `postgres-db.ts` THROWS when a statement answers with
   * more than `MAX_DB_RESULT_ROWS`. A shape that returns a row per island is fine
   * for a read and wrong here, because the row count would then be a function of
   * how the caller cut its file.
   *
   * `lag` gives each row the end of the one before it, so a GAP is a row whose start
   * is not that end, and the prefix is the earliest such end — falling back to the
   * far end when there is no gap at all, and to 0 for an upload with no chunks yet.
   */
  async function contiguousSize(id: string): Promise<number> {
    const rows = await db.query<{ size: string | number | null }>(
      `with covered as (
         select byte_offset as start_at,
                byte_offset + octet_length(bytes) as end_at,
                lag(byte_offset + octet_length(bytes)) over (order by byte_offset) as prev_end
           from ${UPLOAD_CHUNKS_TABLE} where upload_id = $1
       )
       select coalesce(
         (select min(coalesce(prev_end, 0)) from covered where coalesce(prev_end, 0) <> start_at),
         (select max(end_at) from covered),
         0
       ) as size`,
      [id],
    );
    return Number(rows[0]?.size ?? 0);
  }

  /**
   * The windows that have LANDED, merged — or `undefined` when there are too many
   * to report.
   *
   * The same gaps-and-islands walk as above, stopping at the group-by instead of
   * reducing to the prefix: one row per island. That row count is the caller's to
   * decide — it is bounded by how finely they cut the file and in what order the
   * pieces arrived — so this is the one statement here whose result set is not
   * bounded by construction, and `MAX_DB_RESULT_ROWS` makes an unbounded result set
   * a THROW. A sparse upload was therefore permanently a 500 on every read of its
   * record, with no way for its owner to correct it.
   *
   * So it asks for one more than {@link MAX_UPLOAD_RANGES} and answers `undefined`
   * when that arrives. `undefined` is a shape the client already handles — it is
   * what an agent too old to report ranges answers — and its answer there is to
   * re-send the whole file, which is the honest outcome for an upload nobody can
   * describe compactly.
   */
  async function coverage(id: string): Promise<ByteRange[] | undefined> {
    const rows = await db.query<{ start_at: string | number; end_at: string | number }>(
      `with covered as (
         select byte_offset as start_at,
                byte_offset + octet_length(bytes) as end_at,
                lag(byte_offset + octet_length(bytes)) over (order by byte_offset) as prev_end
           from ${UPLOAD_CHUNKS_TABLE} where upload_id = $1
       ),
       islands as (
         select start_at,
                end_at,
                sum(case when prev_end is null or prev_end <> start_at then 1 else 0 end)
                  over (order by start_at) as island
           from covered
       )
       select min(start_at) as start_at, max(end_at) as end_at
         from islands group by island order by 1 limit ${MAX_UPLOAD_RANGES + 1}`,
      [id],
    );
    if (rows.length > MAX_UPLOAD_RANGES) return undefined;
    return rows.map((row) => ({ start: Number(row.start_at), end: Number(row.end_at) }));
  }

  /**
   * One batch of chunks, written in ONE statement.
   *
   * One helper for all three writers: they differ in what they do AROUND the bytes
   * (which record is written when, and what a failure leaves behind) and not in how
   * a chunk is stored, so the SQL and the column list live once.
   *
   * `upsert` is the one thing they do not share. A part is RETRIED whenever a
   * connection dies mid-flight, which is the ordinary failure of the thing parts
   * exist for, so a repeat has to be the same upload rather than a duplicate-key
   * error the client cannot recover from. `create` and `stream` write each seq once
   * by construction, and a plain insert is what makes a bug there LOUD.
   *
   * Safe as a multi-row upsert only because a batch's `seq` values are DISTINCT —
   * Postgres refuses a statement whose `ON CONFLICT DO UPDATE` would touch one row
   * twice. `chunked` yields whole `UPLOAD_CHUNK_BYTES` pieces except for a short
   * last one and a part starts chunk-aligned, so the offsets in a batch are
   * strictly increasing and `chunkSeq` maps them one-to-one.
   */
  const insertChunks = async (
    id: string,
    batch: readonly ChunkRow[],
    upsert: boolean,
  ): Promise<void> => {
    if (batch.length === 0) return;
    const params: unknown[] = [id];
    const rows = batch.map(({ seq, at, bytes }) => {
      params.push(seq, at, Buffer.from(bytes));
      return `($1, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
    });
    await db.query(
      `insert into ${UPLOAD_CHUNKS_TABLE} (upload_id, seq, byte_offset, bytes)
       values ${rows.join(", ")}${
         upsert
           ? ` on conflict (upload_id, seq) do update
             set byte_offset = excluded.byte_offset, bytes = excluded.bytes`
           : ""
}`,
      params,
    );
  };

  return {
    async create(meta, body, options): Promise<UploadInfo> {
      await ensureTables();
      const id = newUploadId();
      let size = 0;
      try {
        for await (const batch of inBatches(placed(chunked(body, options?.limit ?? maxBytes)))) {
          await insertChunks(id, batch, false);
          size = batchEnd(batch);
        }
      } catch (err: unknown) {
        // Best effort: the metadata row was never written, so these rows are
        // unreachable either way — this only stops them taking up space.
        await db
          .query(`delete from ${UPLOAD_CHUNKS_TABLE} where upload_id = $1`, [id])
          .catch(() => undefined);
        throw err;
      }
      const info: UploadInfo = {
        id,
        name: meta.name ?? "",
        type: meta.type ?? "",
        size,
        complete: true,
      };
      // Last, so an upload exists only once all of its bytes do.
      await db.query(
        `insert into ${UPLOADS_TABLE} (id, name, type, size, complete)
         values ($1, $2, $3, $4, true)`,
        [id, info.name, info.type, size],
      );
      return info;
    },

    async stream(id, meta, body, options): Promise<UploadInfo> {
      await ensureTables();
      assertUploadToken(id);
      const name = meta.name ?? "";
      const type = meta.type ?? "";
      // FIRST, and `on conflict do nothing` + a read-back rather than a bare
      // insert: this is what makes a chosen id safe. A second PUT to the same id
      // has to be refused rather than appended to, and one statement's row count
      // cannot tell "I inserted it" from "it was already mine".
      await db.query(
        `insert into ${UPLOADS_TABLE} (id, name, type, size, complete)
         values ($1, $2, $3, 0, false) on conflict (id) do nothing`,
        [id, name, type],
      );
      const claimed = await db.query<{ size: string; complete: boolean }>(
        `select size, complete from ${UPLOADS_TABLE} where id = $1`,
        [id],
      );
      const row = claimed[0];
      if (!row || Number(row.size) !== 0 || row.complete) throw new UploadIdTakenError(id);

      let size = 0;
      for await (const batch of inBatches(placed(chunked(body, options?.limit ?? maxBytes)))) {
        await insertChunks(id, batch, false);
        size = batchEnd(batch);
        // The size is published per BATCH, which is the whole mechanism: it is what
        // a polling run reads to learn how far it may go.
        //
        // Per batch rather than per CHUNK, which is what it used to be — and that
        // doubled this loop's round trips, an update beside every insert, on the
        // path a page's upload bar and a streaming run are both waiting on. What
        // the cadence costs a reader is bounded by `UPLOAD_WRITE_BATCH_MS`; what it
        // cost to publish was half the throughput of the one write this store
        // exists to do quickly.
        //
        // Nothing is deleted on failure, unlike `create`: an incomplete upload is a
        // legitimate readable state here, and a reader may already have used it.
        await db.query(`update ${UPLOADS_TABLE} set size = $2 where id = $1`, [id, size]);
      }
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
      const complete = total === 0;
      // `returning id` rather than the read-back `stream` does, and it is the
      // stronger claim: a row comes back only when THIS statement inserted it, so
      // an id already held is refused even by a caller declaring an identical
      // upload. `stream` cannot tell those apart — it reads the row's own state
      // back, which for two identical claims is identical — and here they are
      // routine, because a client that retries a `beginParts` after a lost
      // response sends exactly the same declaration.
      const claimed = await db.query<{ id: string }>(
        `insert into ${UPLOADS_TABLE} (id, name, type, size, complete, expected)
         values ($1, $2, $3, 0, $5, $4) on conflict (id) do nothing returning id`,
        [id, name, type, total, complete],
      );
      if (claimed.length === 0) throw new UploadIdTakenError(id);
      return { id, name, type, size: 0, complete };
    },

    async writePart(id, offset, body): Promise<UploadInfo> {
      await ensureTables();
      assertPartOffset(offset);
      const rows = await db.query<{
        name: string;
        type: string;
        expected: string | null;
        complete: boolean;
      }>(`select name, type, expected, complete from ${UPLOADS_TABLE} where id = $1`, [id]);
      const row = rows[0];
      if (!row) throw new UnknownUploadError(id);
      if (row.expected === null) {
        throw new UploadPartError(`Upload ${id} was not begun as a parts upload.`);
      }
      const total = Number(row.expected);
      if (offset > total) {
        throw new UploadPartError(`A part at ${offset} starts past this upload's ${total} bytes.`);
      }
      // Grouped rather than one awaited statement per chunk — see
      // `UPLOAD_WRITE_BATCH_CHUNKS`, which carries the two production measurements
      // that argue for it.
      for await (const batch of inBatches(partChunks(body, offset, total))) {
        await insertChunks(id, batch, true);
      }
      const size = await contiguousSize(id);
      const complete = size >= total;
      // Published once per PART rather than per chunk, unlike `stream`: the size a
      // part changes is the contiguous prefix, which costs the query above, and a
      // part is the unit a caller retries anyway. A run reading ahead therefore
      // sees the file grow by parts (megabytes) rather than by chunks.
      await db.query(`update ${UPLOADS_TABLE} set size = $2, complete = $3 where id = $1`, [
        id,
        size,
        complete,
      ]);
      // No `ranges` here, deliberately: this is the per-part write path, and the
      // islands query is the one whose row count the CALLER decides — see
      // `coverage`. Nothing reads them from a part's response anyway; a resume
      // reads them from the record (`info`), once, before it sends anything.
      return { id, name: row.name, type: row.type, size, complete };
    },

    async info(id): Promise<UploadInfo | undefined> {
      await ensureTables();
      const rows = await db.query<{
        id: string;
        name: string;
        type: string;
        size: string;
        complete: boolean;
        expected: string | null;
      }>(`select id, name, type, size, complete, expected from ${UPLOADS_TABLE} where id = $1`, [
        id,
      ]);
      const row = rows[0];
      if (!row) return undefined;
      const complete = row.complete !== false;
      // A SECOND statement, and only for the one record that has something to say:
      // an unfinished PARTS upload. Everything else answers from the row it already
      // read — a whole-file write has no windows and a finished upload is covered
      // end to end — so the read a polling run makes over and over is unchanged.
      // `coverage` answers `undefined` for an upload with too many windows to
      // report, which is the same answer as "this agent does not report them" —
      // and `omitUndefined` below turns both into an absent field.
      const ranges = row.expected !== null && !complete ? await coverage(id) : undefined;
      // `bigint` comes back as a string from the driver — `Number` rather than
      // trusting the shape, so a column type change is a NaN here instead of a
      // string silently used as a byte count.
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        size: Number(row.size),
        complete,
        ...omitUndefined({ ranges }),
      };
    },

    async read(id, start, end): Promise<Uint8Array> {
      await ensureTables();
      // `substring` runs in the DATABASE, so a 64 KB header probe moves 64 KB
      // and not the megabyte chunk it happens to sit in. Postgres string
      // positions are 1-based, hence the `+ 1`; the bounds are per ROW, which is
      // what makes one statement answer a range spanning several chunks.
      const rows = await db.query<{ part: Uint8Array }>(
        `select substring(
             bytes
             from (greatest(byte_offset, $2) - byte_offset + 1)::int
             for  (least(byte_offset + octet_length(bytes), $3) - greatest(byte_offset, $2))::int
           ) as part
           from ${UPLOAD_CHUNKS_TABLE}
          where upload_id = $1
            and byte_offset < $3
            and byte_offset + octet_length(bytes) > $2
          order by seq`,
        [id, start, end],
      );
      const parts = rows.map((row) => new Uint8Array(row.part));
      return concat(
        parts,
        parts.reduce((total, part) => total + part.length, 0),
      );
    },
  };
}
