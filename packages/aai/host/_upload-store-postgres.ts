// Copyright 2026 the AAI authors. MIT license.
/**
 * The Postgres upload backend: one metadata row, N chunk rows, and a range read that
 * slices inside the database.
 */

import type { Db } from "../sdk/db.ts";
import { assertUploadToken, type UploadInfo } from "../sdk/step-uploads.ts";
import { ensureOnce } from "./_ensure-once.ts";
import {
  chunked,
  concat,
  newUploadId,
  UPLOAD_CHUNKS_TABLE,
  UPLOADS_TABLE,
  UploadIdTakenError,
  type UploadStore,
} from "./_upload-store.ts";
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
    await db.query(`create table if not exists ${UPLOAD_CHUNKS_TABLE} (
      upload_id text not null,
      seq int not null,
      byte_offset bigint not null,
      bytes bytea not null,
      primary key (upload_id, seq)
    )`);
  });

  return {
    async create(meta, body, options): Promise<UploadInfo> {
      await ensureTables();
      const id = newUploadId();
      let size = 0;
      let seq = 0;
      try {
        for await (const chunk of chunked(body, options?.limit ?? maxBytes)) {
          await db.query(
            `insert into ${UPLOAD_CHUNKS_TABLE} (upload_id, seq, byte_offset, bytes)
             values ($1, $2, $3, $4)`,
            [id, seq, size, Buffer.from(chunk)],
          );
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
        await db.query(
          `insert into ${UPLOAD_CHUNKS_TABLE} (upload_id, seq, byte_offset, bytes)
           values ($1, $2, $3, $4)`,
          [id, seq, size, Buffer.from(chunk)],
        );
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
