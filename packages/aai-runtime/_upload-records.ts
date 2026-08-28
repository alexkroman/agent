// Copyright 2026 the AAI authors. MIT license.
/**
 * Where an upload's RECORD lives, as the store addresses it — and the Postgres
 * implementation of it.
 *
 * `_upload-blobs.ts` did this for the BYTES and the argument here is the same
 * one, arriving one layer over: the store is a set of invariants about windows
 * (an ordinary upload does not exist until it is finished; a streamed one exists
 * from its first byte; a part is recorded only once the bucket confirms it), and
 * none of that is about SQL. Pulling the six statements behind an interface is
 * what lets one store serve two homes instead of two stores drifting.
 *
 * ## The two homes, and why the split is not a preference
 *
 * A record has to be **at least as durable as the runs that read it**. That is the
 * whole rule, and it is the one the deleted file backend broke: it stored a dev
 * upload perfectly well and lost it by the time a resumed run read it, with
 * nothing reporting a thing — because the runs were in Postgres and the bytes were
 * in a directory. So the record's home follows the WORLD's
 * (`workflow-world.ts`), which is decided by exactly the same input:
 *
 * - **`DATABASE_URL` set** → the Postgres world, whose runs outlive any one
 *   process and any one machine. Records go in the app's own database
 *   ({@link createPostgresUploadRecords}) and the bytes in a bucket.
 * - **absent** → the LOCAL world, whose run state is a directory and whose queue
 *   is in memory. Records and bytes go in that same directory
 *   (`_upload-records-files.ts`, `_upload-blobs-files.ts`), so the two
 *   durabilities are equal BY CONSTRUCTION rather than by a claim — in a guest,
 *   where the directory is per-process and both die with it, and under `aai dev`,
 *   where it is the project's and both survive a restart.
 *
 * That last property is what the old fallback could not have at any level of
 * care, and it is why this is not that mistake again.
 *
 * ## Normalized, so the driver's shapes stop at this boundary
 *
 * {@link UploadRecord} is numbers, booleans and a parsed boundary list. The store
 * used to read a `bigint` as a string, an absent total as `null` and `parts` as
 * `unknown`, and coerce all three at every call site — which is how `Number()`
 * around a `size` came to be load-bearing in four places. Those coercions now
 * live in the one implementation whose driver has an opinion about them.
 *
 * @internal
 */

import type { Db } from "@alexkroman1/aai/internal";
import { ensureOnce } from "./_ensure-once.ts";
import { partsOf, type UploadPart } from "./_upload-blobs.ts";
import { UPLOADS_TABLE, UploadIdTakenError } from "./_upload-store.ts";

/**
 * One upload's record, in the shapes the store actually wants.
 *
 * `size` is the CONTIGUOUS readable prefix rather than the sum of what has
 * arrived — see `contiguousBytes`. `expected` is the total a parts upload
 * declared and is absent for every other kind, which is what tells the two apart
 * (a streamed upload's completion is decided by its body ending, never by its
 * prefix reaching a number nobody declared).
 *
 * @internal
 */
export type UploadRecord = {
  name: string;
  type: string;
  size: number;
  complete: boolean;
  /** The declared total of a PARTS upload; absent for streamed and whole-file ones. */
  expected?: number | undefined;
  /** Raw window boundaries, un-merged: a merge loses which object holds a byte. */
  parts: UploadPart[];
};

/**
 * The record operations the upload store performs, and only those.
 *
 * Deliberately not a table abstraction: no listing, no delete, no query. Every
 * method here is a statement the store already issued, and an implementation that
 * wanted more would be answering a question the store does not ask.
 *
 * @internal
 */
export type UploadRecords = {
  /**
   * Make the home usable — a DDL pass, a `mkdir`. Called before every operation
   * and expected to memoize (see `ensureOnce`): an agent's first workflow may be
   * its first ever deploy, so there is no provisioning pass to hang it off.
   */
  ensure(): Promise<void>;
  /** One record, or `undefined` when nothing has begun under `id`. */
  read(id: string): Promise<UploadRecord | undefined>;
  /**
   * Claim `id` for an upload whose bytes have NOT all arrived.
   *
   * @throws {UploadIdTakenError} when the id is already held — even by an
   *   identical declaration, which is what makes a caller-chosen id safe.
   */
  claim(id: string, record: UploadRecord): Promise<void>;
  /**
   * Write the record of an upload whose bytes are ALL already stored.
   *
   * Its own method rather than a `claim` with a fuller record, because the two
   * are different facts: this id was minted here and cannot collide, and the
   * record is finished on arrival. Collapsing them would put an
   * `on conflict` clause on a statement that has no conflict to answer and would
   * make "the id was taken" a reachable failure for a caller that chose no id.
   */
  insert(id: string, record: UploadRecord): Promise<void>;
  /** Publish a merged boundary list and what it makes readable. */
  update(
    id: string,
    state: { size: number; complete: boolean; parts: UploadPart[] },
  ): Promise<void>;
  /**
   * A streamed upload's body ended: this is all of it.
   *
   * Not an {@link UploadRecords.update} with `complete: true`, because the FACT is
   * different and so is the statement. Every window has already joined the
   * boundary list, so there is nothing to merge — and completion here is decided
   * by the body ending rather than by a prefix reaching a declared total, which is
   * the one thing a streamed upload never has.
   */
  finish(id: string, size: number): Promise<void>;
};

/** What one upload's row holds, in the shapes the DRIVER answers with. */
type StoredRow = {
  name: string;
  type: string;
  /** `bigint`, which postgres.js hands back as a STRING. */
  size: string;
  complete: boolean;
  /** `bigint` or NULL — absent is not the same value, and the store reads which. */
  expected: string | null;
  /**
   * The boundary list AS THE DRIVER GIVES IT, hence `unknown` and `partsOf` on the
   * way out. See `partsOf` for the corrupt write that made this explicit.
   */
  parts: unknown;
};

/**
 * Records in the app's own Postgres — the durable home, and the only one that can
 * serve a run resumed by another process.
 *
 * @internal
 */
export function createPostgresUploadRecords(db: Db): UploadRecords {
  const ensure = ensureOnce(async () => {
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

  return {
    ensure,

    async read(id): Promise<UploadRecord | undefined> {
      const rows = await db.query<StoredRow>(
        `select name, type, size, complete, expected, parts from ${UPLOADS_TABLE} where id = $1`,
        [id],
      );
      const held = rows[0];
      if (!held) return undefined;
      return {
        name: held.name,
        type: held.type,
        // `Number` rather than trusting the shape, so a column type change is a
        // NaN here instead of a string silently used as a byte count.
        size: Number(held.size),
        complete: held.complete !== false,
        ...(held.expected === null ? {} : { expected: Number(held.expected) }),
        parts: partsOf(held.parts),
      };
    },

    async claim(id, record): Promise<void> {
      // `returning id` rather than a read-back: a row comes back only when THIS
      // statement inserted it, so an id already held is refused even by a caller
      // declaring an identical upload.
      const claimed = await db.query<{ id: string }>(
        `insert into ${UPLOADS_TABLE} (id, name, type, size, complete, expected, parts)
       values ($1, $2, $3, 0, $4, $5, '[]'::jsonb) on conflict (id) do nothing returning id`,
        [id, record.name, record.type, record.complete, record.expected ?? null],
      );
      if (claimed.length === 0) throw new UploadIdTakenError(id);
    },

    async insert(id, record): Promise<void> {
      await db.query(
        // `$5::text::jsonb`, NOT `$5::jsonb` — see `partsOf` for what the missing
        // `::text` stored.
        `insert into ${UPLOADS_TABLE} (id, name, type, size, complete, parts)
         values ($1, $2, $3, $4, true, $5::text::jsonb)`,
        [id, record.name, record.type, record.size, JSON.stringify(record.parts)],
      );
    },

    async update(id, state): Promise<void> {
      await db.query(
        // `$2::text::jsonb` for the reason `insert` carries — `partsOf` owns it.
        `update ${UPLOADS_TABLE} set parts = $2::text::jsonb, size = $3, complete = $4
         where id = $1`,
        [id, JSON.stringify(state.parts), state.size, state.complete],
      );
    },

    async finish(id, size): Promise<void> {
      await db.query(`update ${UPLOADS_TABLE} set size = $2, complete = true where id = $1`, [
        id,
        size,
      ]);
    },
  };
}
