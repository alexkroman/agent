// Copyright 2026 the AAI authors. MIT license.
/**
 * The Postgres upload backend: one metadata row, N chunk rows, and a range read that
 * slices inside the database.
 */

import type { Db } from "../sdk/db.ts";
import { assertUploadToken, type UploadInfo } from "../sdk/step-uploads.ts";
import { ensureOnce } from "./_ensure-once.ts";
import {
  assertPartOffset,
  assertPartTotal,
  chunked,
  chunkSeq,
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
 * How many chunks one `writePart` commits per statement.
 *
 * A part used to be stored one awaited `INSERT` per `UPLOAD_CHUNK_BYTES`, and that
 * shape has two costs a batch removes, both measured in production:
 *
 * - **The body drains at the speed of a round trip per megabyte.** The loop awaits
 *   a commit before pulling the next chunk off the request, so the socket moves
 *   only as fast as this app's Postgres — which for a deployed agent is a pooler in
 *   another AWS region. The platform's forward measures exactly that drain to
 *   decide whether a guest is alive, so a part that is storing perfectly well looks
 *   like a stall: 6 upload `PUT`s answered 503 or 408 in one hour, three of them
 *   aborted at 121-125s against a 120s window that had just been raised from 30s.
 * - **It holds a pool connection for the whole part.** `postgres-db.ts` pools FOUR
 *   by default and the whole guest shares it — the workflow engine's polling, every
 *   `/stream` re-read, session state — so the client's four concurrent parts take
 *   the pool for the length of the upload. Measured over the same hour: every
 *   non-upload request on that agent ran at **p50 1.34s while a part was in flight
 *   against 0.43s when none was**, a 3.1x slowdown across 801 and 366 samples, with
 *   `GET /workflows/runs` peaking at 17.7s.
 *
 * FOUR rather than the whole part, because the app role carries
 * `statement_timeout = '10s'` (`aai-server/app-database.ts`) and one statement has
 * to stay well inside it. Four cuts an 8 MiB part from eight round trips to two and
 * bounds the extra memory at 4 MiB per part in flight, where buffering the part
 * whole would be bounded only by the upload's own declared total — 2 GiB.
 */
const PART_CHUNKS_PER_STATEMENT = 4;

/**
 * Group an async iterator into runs of at most `size`, emitting a short last one.
 *
 * Local to this backend deliberately: the file store writes into a descriptor, so
 * it has no round trip to amortize and batching there would only add latency.
 */
async function* batched<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let batch: T[] = [];
  for await (const item of items) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

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
  });

  /**
   * How many bytes are present from byte ZERO — the `size` a parts upload publishes.
   *
   * One statement rather than reading the offsets back and walking them: a 2 GB
   * upload is two thousand chunk rows, well past `MAX_DB_RESULT_ROWS`, so the walk
   * would fail on exactly the files parts exist for. `lag` gives each row the end of
   * the one before it, so a GAP is a row whose start is not that end, and the
   * prefix is the earliest such end — falling back to the far end when there is no
   * gap at all, and to 0 for an upload with no chunks yet.
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

  // One statement, two callers: `create` and `stream` differ in what they do
  // AROUND the bytes (which record is written when, and what a failure leaves
  // behind) and not in how a chunk is stored, so the SQL and the column list
  // live once — a schema change has one place to be made.
  const insertChunk = async (
    id: string,
    seq: number,
    byteOffset: number,
    chunk: Uint8Array,
  ): Promise<void> => {
    await db.query(
      `insert into ${UPLOAD_CHUNKS_TABLE} (upload_id, seq, byte_offset, bytes)
       values ($1, $2, $3, $4)`,
      [id, seq, byteOffset, Buffer.from(chunk)],
    );
  };

  /**
   * One part's worth of chunks, upserted in ONE statement.
   *
   * `do update` for the reason the single-row insert above does not need it: a part
   * is RETRIED whenever a connection dies mid-flight, which is the ordinary failure
   * of the thing parts exist for, and a retry must be the same upload rather than a
   * duplicate-key error the client cannot recover from.
   *
   * Safe as a multi-row upsert only because a batch's `seq` values are DISTINCT —
   * Postgres refuses a statement whose `ON CONFLICT DO UPDATE` would touch one row
   * twice. `chunked` yields whole `UPLOAD_CHUNK_BYTES` pieces except for a short
   * last one and a part starts chunk-aligned, so the offsets in a batch are
   * strictly increasing and `chunkSeq` maps them one-to-one.
   */
  const insertChunkBatch = async (
    id: string,
    batch: readonly { bytes: Uint8Array; at: number }[],
  ): Promise<void> => {
    const params: unknown[] = [id];
    const rows = batch.map(({ bytes, at }) => {
      params.push(chunkSeq(at), at, Buffer.from(bytes));
      return `($1, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
    });
    await db.query(
      `insert into ${UPLOAD_CHUNKS_TABLE} (upload_id, seq, byte_offset, bytes)
       values ${rows.join(", ")}
       on conflict (upload_id, seq) do update
         set byte_offset = excluded.byte_offset, bytes = excluded.bytes`,
      params,
    );
  };

  return {
    async create(meta, body, options): Promise<UploadInfo> {
      await ensureTables();
      const id = newUploadId();
      let size = 0;
      let seq = 0;
      try {
        for await (const chunk of chunked(body, options?.limit ?? maxBytes)) {
          await insertChunk(id, seq, size, chunk);
          seq += 1;
          size += chunk.length;
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
      let seq = 0;
      for await (const chunk of chunked(body, options?.limit ?? maxBytes)) {
        await insertChunk(id, seq, size, chunk);
        seq += 1;
        size += chunk.length;
        // The size is published per CHUNK, which is the whole mechanism: it is what
        // a polling run reads to learn how far it may go. One small update per
        // megabyte beside an insert that already happened.
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
      // Batched rather than one awaited statement per chunk — see
      // `PART_CHUNKS_PER_STATEMENT`, which carries the two production measurements
      // that argue for it.
      for await (const batch of batched(
        partChunks(body, offset, total),
        PART_CHUNKS_PER_STATEMENT,
      )) {
        await insertChunkBatch(id, batch);
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
      }>(`select id, name, type, size, complete from ${UPLOADS_TABLE} where id = $1`, [id]);
      const row = rows[0];
      // `bigint` comes back as a string from the driver — `Number` rather than
      // trusting the shape, so a column type change is a NaN here instead of a
      // string silently used as a byte count.
      return row
        ? {
            id: row.id,
            name: row.name,
            type: row.type,
            size: Number(row.size),
            complete: row.complete !== false,
          }
        : undefined;
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
