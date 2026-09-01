// Copyright 2026 the AAI authors. MIT license.
/**
 * Workflow upload RECORDS on the platform's own database.
 *
 * The bytes are not here — those go to the platform's bucket through the upload
 * broker (`_upload-blobs.ts`). This is the record: what an upload is called, how
 * much of it is contiguously readable, whether it is finished, and which object
 * holds which byte range.
 *
 * ## Why it moved
 *
 * `createUploadStore` decided an upload's home from whether the agent had a
 * `ctx.db`, on a premise its own comment stated — "a database means durable runs,
 * so the bytes have to be durable too". The workflow queue moving here falsified
 * it: a deployed app's runs are durable with no database of the author's. So a
 * deployed guest with no `DATABASE_URL` got durable runs and put their uploads on
 * a disk that recycles, which is how one sandbox filled its filesystem and
 * `ENOSPC`'d every write while three layers retried it as transient.
 *
 * ## Tenancy is in the KEY, which is stronger than a check
 *
 * The slug is half the primary key and appears in every statement below, so no
 * query here can be pointed at another agent's rows — the same arrangement as
 * `platform-session-state.ts`, and for the same reason: this schema is the
 * platform's own. A `workflow_run_owner` mapping table used to be needed because the
 * DevKit's schema is fixed and has no tenant column.
 *
 * ## The write volume, and the tripwire that would change this design
 *
 * The obvious objection is traffic: a record is written once per batch of window
 * arrivals, and a big upload has many windows. Measured, it is not close:
 * `UPLOAD_CLAIM_BATCH` coalesces claims — one is in flight at a time and
 * everything landing during it joins the next — so a deployed agent recorded a
 * **128 MiB file's 16 parts in 3 to 5 claims** (that constant's own doc has the
 * measurement). At `UPLOAD_PART_BYTES` of 8 MiB, the 2 GiB ceiling is 256 windows
 * and therefore some tens of writes.
 *
 * For scale, session SLOTS are committed at the end of every tool call and one
 * busy retail turn mutates ~106 KB. A whole maximal upload writes on the order of
 * one such turn.
 *
 * **What would change the answer:** `update` rewrites the WHOLE `parts` array, so
 * bytes written across an upload are O(N²) in window count. At N=256 the largest
 * single write is ~25 KB and that is fine. Raise `MAX_WORKFLOW_UPLOAD_BYTES` much,
 * or lower `UPLOAD_PART_BYTES`, and it stops being fine — the fix then is an
 * append-only `workflow_upload_parts` table, one row per window, which turns the
 * O(N²) into O(N) at the cost of an aggregate on read. Not worth it now, and the
 * numbers above are what that judgement rests on.
 *
 * ## The driver's shapes are coerced HERE
 *
 * `size` and `expected` are `bigint`, which postgres.js hands back as STRINGS,
 * and `parts` is `jsonb`, which arrives as whatever the driver parsed. The
 * runtime's `UploadRecords` contract wants numbers and a typed list, and its own
 * doc says the coercions "live in the one implementation whose driver has an
 * opinion about them". This is now a second such implementation, so it does the
 * same rather than pushing strings across the wire for the guest to guess at.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { SqlExec } from "./secret-store.ts";

/**
 * One window: the byte it starts at, and how many bytes it holds.
 *
 * Mirrors the runtime's `UploadPart` exactly (`_upload-blobs.ts`) — `at` is also
 * the stored object's key suffix, which is why a window needs no key of its own.
 * Spelled here rather than imported because this package must not depend on
 * `aai-runtime`'s internals for a wire shape; the field names are the contract and
 * `uploads-platform.ts` is the other end of it.
 */
export type PlatformUploadPart = { at: number; bytes: number };

/** One upload's record, in the shapes the runtime's store wants. */
export type PlatformUploadRecord = {
  name: string;
  type: string;
  /** The CONTIGUOUS readable prefix, not the sum of what has arrived. */
  size: number;
  complete: boolean;
  /** A PARTS upload's declared total; absent for streamed and whole-file ones. */
  expected?: number | undefined;
  parts: PlatformUploadPart[];
};

/**
 * Raised when `claim` finds the id already held.
 *
 * Its own error rather than a boolean, because the caller's answer is an HTTP
 * status: a claimed id is a 409 and nothing else here is. The runtime maps it back
 * to its own `UploadIdTakenError`, which is what makes a caller-chosen id safe.
 */
export class PlatformUploadIdTakenError extends Error {
  constructor(id: string) {
    super(`upload id already taken: ${id}`);
    this.name = "PlatformUploadIdTakenError";
  }
}

/**
 * A number out of a driver value, or `undefined`.
 *
 * `typeof` first, never a bare `Number()`: `Number(null)` is 0 and `Number("")` is
 * 0, so coercing first turns "this column was NULL" into a perfectly plausible
 * zero. For `expected` that is the difference between "a parts upload declaring
 * zero bytes" and "not a parts upload at all", which is what decides how
 * completion is judged. The same trap `countEvents` and `parkedFor` were caught by.
 */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The boundary list as the driver gives it, dropping anything malformed.
 *
 * Dropped rather than thrown on: a corrupt entry would make an upload unreadable
 * forever, where a missing window makes the prefix shorter and a resumed read asks
 * for it again. The runtime's `partsOf` makes the same choice for the same reason.
 */
function partsOf(value: unknown): PlatformUploadPart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const at = numberOf(entry.at);
    const bytes = numberOf(entry.bytes);
    if (at === undefined || bytes === undefined) return [];
    return [{ at, bytes }];
  });
}

/** One upload's record, or `undefined` when nothing has begun under `id`. */
export async function readUpload(
  sql: SqlExec,
  slug: string,
  id: string,
): Promise<PlatformUploadRecord | undefined> {
  const rows = await sql(
    `select name, type, size, complete, expected, parts
       from aai_platform.workflow_uploads where slug = $1 and id = $2`,
    [slug, id],
  );
  const row = rows[0];
  if (!row) return undefined;
  const size = numberOf(row.size);
  if (size === undefined) return undefined;
  const expected = numberOf(row.expected);
  return {
    name: typeof row.name === "string" ? row.name : "",
    type: typeof row.type === "string" ? row.type : "",
    size,
    complete: row.complete === true,
    // Spread rather than `expected: undefined`: under
    // `exactOptionalPropertyTypes` the two differ, and ABSENT is the value that
    // means "not a parts upload".
    ...omitUndefined({ expected }),
    parts: partsOf(row.parts),
  };
}

/**
 * Claim `id` for an upload whose bytes have not all arrived.
 *
 * `on conflict do nothing` plus a returning-row check rather than a read-then-write:
 * two guests racing the same caller-chosen id would both read "free" and both
 * insert, and the second would win silently. The insert IS the claim.
 *
 * @throws {PlatformUploadIdTakenError} when the id is already held — even by an
 *   identical declaration, which is what makes a caller-chosen id safe.
 */
export async function claimUpload(
  sql: SqlExec,
  slug: string,
  id: string,
  record: PlatformUploadRecord,
): Promise<void> {
  const rows = await sql(
    `insert into aai_platform.workflow_uploads
       (slug, id, name, type, size, complete, expected, parts)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
     on conflict (slug, id) do nothing
     returning id`,
    [
      slug,
      id,
      record.name,
      record.type,
      record.size,
      record.complete,
      record.expected ?? null,
      JSON.stringify(record.parts),
    ],
  );
  if (rows.length === 0) throw new PlatformUploadIdTakenError(id);
}

/**
 * Write the record of an upload whose bytes are ALL already stored.
 *
 * Separate from {@link claimUpload} because the facts differ: this id was minted
 * by the store and cannot collide, so there is no conflict for an `on conflict`
 * clause to answer and "the id was taken" must not be a reachable failure for a
 * caller that chose no id. It is an upsert only so a retried request is
 * idempotent.
 */
export async function insertUpload(
  sql: SqlExec,
  slug: string,
  id: string,
  record: PlatformUploadRecord,
): Promise<void> {
  await sql(
    `insert into aai_platform.workflow_uploads
       (slug, id, name, type, size, complete, expected, parts)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
     on conflict (slug, id) do update set
       name = excluded.name,
       type = excluded.type,
       size = excluded.size,
       complete = excluded.complete,
       expected = excluded.expected,
       parts = excluded.parts,
       updated_at = now()`,
    [
      slug,
      id,
      record.name,
      record.type,
      record.size,
      record.complete,
      record.expected ?? null,
      JSON.stringify(record.parts),
    ],
  );
}

/**
 * Publish a merged boundary list and what it makes readable.
 *
 * Only the three columns a window arrival can change. `name`, `type` and
 * `expected` are the declaration's and are never rewritten by a write — an update
 * that carried them would let a late window silently redeclare an upload's total.
 */
export async function updateUpload(
  sql: SqlExec,
  slug: string,
  id: string,
  state: { size: number; complete: boolean; parts: PlatformUploadPart[] },
): Promise<void> {
  await sql(
    `update aai_platform.workflow_uploads
       set size = $3, complete = $4, parts = $5::text::jsonb, updated_at = now()
     where slug = $1 and id = $2`,
    [slug, id, state.size, state.complete, JSON.stringify(state.parts)],
  );
}

/**
 * A streamed upload's body ended: this is all of it.
 *
 * Not an {@link updateUpload} with `complete: true`, because the fact is different
 * and so is the statement — every window has already joined the boundary list, so
 * there is nothing to merge, and `parts` must be left exactly as it is.
 */
export async function finishUpload(
  sql: SqlExec,
  slug: string,
  id: string,
  size: number,
): Promise<void> {
  await sql(
    `update aai_platform.workflow_uploads
       set size = $3, complete = true, updated_at = now()
     where slug = $1 and id = $2`,
    [slug, id, size],
  );
}

/**
 * How long an upload's record outlives its creation.
 *
 * Read by `pg-cron.ts`, where the sweep lives. Seven days rather than session
 * state's two: an upload is an INPUT to runs that may sleep — `podcast-digest`
 * parks for days between digests — so expiring one at two days would break the
 * workflow the retention exists to support. The bytes have their own lifetime in
 * the bucket; this bounds the row.
 */
export const UPLOAD_RECORD_RETENTION = "7 days";
