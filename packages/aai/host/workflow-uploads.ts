// Copyright 2026 the AAI authors. MIT license.
/**
 * Where an uploaded file lives between the form that sent it and the step that
 * reads it.
 *
 * The problem it solves is the one `MAX_WORKFLOW_INPUT_BYTES` states: a run's
 * input is journaled and replayed on every resume, so bytes may not travel in
 * it. Before this the only answer was "put the file somewhere else and pass a
 * URL", which is fine for a recording that is already hosted and useless for a
 * person with a file on their laptop — the case every transcription and document
 * app opens on. So the app gets a place of its own.
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
 * body streams into {@link UPLOAD_CHUNK_BYTES} rows as it arrives, and a range
 * read asks Postgres for exactly the bytes inside each covering chunk. A header
 * probe therefore moves 64 KB, not the file.
 *
 * ## The metadata row is written LAST
 *
 * There is no transaction around a multi-megabyte stream, so "does this upload
 * exist" has to be answerable by one row that only appears when the bytes are
 * all in. An interrupted upload leaves orphan chunks (best-effort deleted) and
 * no upload — which reads correctly to every caller as "there is no such
 * upload", rather than as a file that is silently short.
 */

import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_WORKFLOW_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_ID_PREFIX,
} from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import type { UploadInfo, UploadReader } from "../sdk/step-uploads.ts";
import { ensureOnce } from "./_ensure-once.ts";

/** The table one row per upload lives in. Prefixed so it cannot collide with an app's own. */
export const UPLOADS_TABLE = "aai_workflow_uploads";
/** The table the bytes live in, {@link UPLOAD_CHUNK_BYTES} at a time. */
export const UPLOAD_CHUNKS_TABLE = "aai_workflow_upload_chunks";

/** Raised by {@link UploadStore.create} when the body ran past its cap. */
export class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`upload exceeds ${limit} bytes`);
    this.name = "UploadTooLargeError";
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
};

/**
 * Build the store for one server.
 *
 * Takes a resolver for the database rather than a URL so the caller decides
 * what "has storage" means, and takes the directory unconditionally: the file
 * backend is what answers when there is no database, and a server with neither
 * would have no uploads at all, which is a worse dev experience than a
 * directory nobody asked for.
 *
 * @internal
 */
export function createUploadStore(opts: { db?: Db | undefined; dir: string }): UploadStore {
  return opts.db ? createPostgresUploadStore(opts.db) : createFileUploadStore(opts.dir);
}

/** A fresh upload id. Prefixed so a stray value in a log reads as what it is. */
function newUploadId(): string {
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
async function* chunked(
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

/** One buffer from several. */
function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1 && parts[0]?.length === size) return parts[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The Postgres backend: one metadata row, N chunk rows, and a range read that
 * slices inside the database.
 */
function createPostgresUploadStore(db: Db): UploadStore {
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
        for await (const chunk of chunked(body, options?.limit ?? MAX_WORKFLOW_UPLOAD_BYTES)) {
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
      const info: UploadInfo = { id, name: meta.name ?? "", type: meta.type ?? "", size };
      // Last, so an upload exists only once all of its bytes do.
      await db.query(
        `insert into ${UPLOADS_TABLE} (id, name, type, size) values ($1, $2, $3, $4)`,
        [id, info.name, info.type, size],
      );
      return info;
    },

    async info(id): Promise<UploadInfo | undefined> {
      await ensureTables();
      const rows = await db.query<{ id: string; name: string; type: string; size: string }>(
        `select id, name, type, size from ${UPLOADS_TABLE} where id = $1`,
        [id],
      );
      const row = rows[0];
      // `bigint` comes back as a string from the driver — `Number` rather than
      // trusting the shape, so a column type change is a NaN here instead of a
      // string silently used as a byte count.
      return row
        ? { id: row.id, name: row.name, type: row.type, size: Number(row.size) }
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

/**
 * The file backend: one file of bytes, one of metadata, beside the Local
 * World's own state.
 */
function createFileUploadStore(dir: string): UploadStore {
  const ensureDir = ensureOnce(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  });
  const bytesPath = (id: string): string => join(dir, `${id}.bin`);
  const metaPath = (id: string): string => join(dir, `${id}.json`);

  return {
    async create(meta, body, options): Promise<UploadInfo> {
      await ensureDir();
      const id = newUploadId();
      const file = await open(bytesPath(id), "w");
      let size = 0;
      try {
        for await (const chunk of chunked(body, options?.limit ?? MAX_WORKFLOW_UPLOAD_BYTES)) {
          await file.write(chunk);
          size += chunk.length;
        }
      } catch (err: unknown) {
        await file.close();
        await rm(bytesPath(id), { force: true });
        throw err;
      }
      await file.close();
      const info: UploadInfo = { id, name: meta.name ?? "", type: meta.type ?? "", size };
      // Written last, for the reason the Postgres backend writes its row last.
      await writeFile(metaPath(id), JSON.stringify(info), "utf-8");
      return info;
    },

    async info(id): Promise<UploadInfo | undefined> {
      try {
        return JSON.parse(await readFile(metaPath(id), "utf-8")) as UploadInfo;
      } catch {
        // A missing (or half-written) sidecar IS "no such upload" — the same
        // answer the Postgres backend gives for a missing row.
        return undefined;
      }
    },

    async read(id, start, end): Promise<Uint8Array> {
      const file = await open(bytesPath(id), "r");
      try {
        const bytes = new Uint8Array(end - start);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
  };
}
