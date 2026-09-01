// Copyright 2026 the AAI authors. MIT license.
/**
 * Session slots and the session event log, on the platform's own database.
 *
 * This is turn-level durability without a tenant database. A tool's `ctx.slots`
 * and the session event log are committed at the end of every tool call, awaited,
 * so a crash preserves the turn — and both lived in the app's database until now.
 *
 * ## Tenancy is in the KEY, which is stronger than a check
 *
 * That is the design, and it is worth naming what it replaced: the DevKit's
 * journal had a fixed schema with no tenant column, so a `workflow_run_owner`
 * mapping table carried ownership beside it. Both are gone. This schema is the platform's own, so the slug is
 * part of the primary key and part of every statement below. A guessed session id
 * therefore reaches nothing: there is no query here that can be pointed at another
 * agent's rows, so there is no check to forget.
 *
 * ## The statements mirror `session-state-postgres.ts`, deliberately
 *
 * That module is the contract both ends derive from, and the memory backend is a
 * valid test double for it only because all three agree. Two of its choices are
 * load-bearing and reproduced with their reasons:
 *
 * - **One `unnest` statement for a commit**, however many slots changed, so a
 *   flush is one round trip. A per-shape `values` list would buy no plan reuse —
 *   the driver runs with `prepare: false` — and a fixed parameter shape is one
 *   less thing to get wrong.
 * - **`on conflict do nothing` on an append**, which is what makes a retried flush
 *   idempotent. The index is assigned above the backend, so a re-append of a
 *   stored index has to be a no-op rather than an error.
 *
 * ## `jsonb` NORMALIZES, so a value is preserved by MEANING and not by bytes
 *
 * `{"items":[1,2]}` is stored and read back as `{"items": [1, 2]}`. That is what
 * the column being `jsonb` buys — it parses on write, which is the check this
 * process cannot fake — and the cost is that the exact serialization a caller
 * handed over is not the one it gets back.
 *
 * Harmless, because every consumer parses; worth writing down, because the MEMORY
 * backend does preserve bytes, so the two differ on something a spec might
 * reasonably assert. The POSTGRES backend has had this property all along, so
 * this is consistent with it rather than new.
 *
 * ## `countEvents` answers `max + 1`, NOT a count
 *
 * The trap the postgres backend's own doc spells out, and it survives the move
 * unchanged. The log need not be dense: an event past the cap advances the position
 * without being stored, and a partly-failed flush leaves a hole. Under a count both
 * cases hand a resumed session an index it has already used, so its `tail` goes
 * BACKWARDS and the re-used appends are silently dropped by the `on conflict`
 * above. Every backend must answer `max + 1` or the memory one stops being a valid
 * double.
 */

import type { SqlExec } from "./secret-store.ts";

/** One stored event, as the runtime's log records it. */
export type PlatformSessionEvent = {
  /** Assigned above the backend. The database never invents one. */
  index: number;
  /** The event itself, already serialized. */
  event: string;
};

/** Every stored slot for one session, keyed by slot. */
export async function loadSlots(
  sql: SqlExec,
  slug: string,
  sessionId: string,
): Promise<Record<string, string>> {
  const rows = await sql(
    `select slot, value::text as value from aai_platform.session_slots
      where slug = $1 and session_id = $2`,
    [slug, sessionId],
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.slot === "string" && typeof row.value === "string") out[row.slot] = row.value;
  }
  return out;
}

/**
 * Store the slots that changed.
 *
 * ONE statement for however many, via `unnest` — see the module doc. An empty map
 * is a no-op rather than a statement: a tool call that changed nothing still
 * flushes, and `unnest` of two empty arrays would be a round trip for no rows.
 */
export async function commitSlots(
  sql: SqlExec,
  slug: string,
  sessionId: string,
  values: Record<string, string>,
): Promise<void> {
  const slots = Object.keys(values);
  if (slots.length === 0) return;
  await sql(
    `insert into aai_platform.session_slots (slug, session_id, slot, value, updated_at)
     select $1, $2, s.slot, s.value::jsonb, now()
     from unnest($3::text[], $4::text[]) as s(slot, value)
     on conflict (slug, session_id, slot)
     do update set value = excluded.value, updated_at = now()`,
    [slug, sessionId, slots, slots.map((slot) => values[slot] ?? "null")],
  );
}

/**
 * Reclaim one session.
 *
 * BOTH tables, unlike the postgres backend — and the difference is a grant
 * rather than a decision. There, `ctx.db` hands tool code arbitrary SQL on the same
 * role, so the event table is granted `select, insert` only and reclaiming it is
 * the sweep's job alone. Here the tenant has no credential on this database at all,
 * so the append-only property is structural and `discard` can do what it says.
 */
export async function discardSession(sql: SqlExec, slug: string, sessionId: string): Promise<void> {
  // ONE statement, not two awaited in series. The two deletes are independent —
  // no ordering requirement either way — and this runs on a connection reserved
  // out of a pool of `ADMIN_POOL_MAX`, so the second round trip was holding that
  // reservation for nothing. A CTE also makes the pair atomic, which two
  // statements on an unwrapped connection were not.
  await sql(
    `with slots as (
       delete from aai_platform.session_slots where slug = $1 and session_id = $2
     )
     delete from aai_platform.session_events where slug = $1 and session_id = $2`,
    [slug, sessionId],
  );
}

/**
 * Append events at the indices they already carry.
 *
 * `on conflict do nothing`, which is what makes a retried flush idempotent — see
 * the module doc. Empty is a no-op for the same reason a commit of nothing is.
 */
export async function appendEvents(
  sql: SqlExec,
  slug: string,
  sessionId: string,
  events: readonly PlatformSessionEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await sql(
    `insert into aai_platform.session_events (slug, session_id, event_index, event)
     select $1, $2, e.idx::bigint, e.event::jsonb
     from unnest($3::bigint[], $4::text[]) as e(idx, event)
     on conflict (slug, session_id, event_index) do nothing`,
    [slug, sessionId, events.map((e) => e.index), events.map((e) => e.event)],
  );
}

/** Events from `startIndex` inclusive, in index order, at most `limit`. */
export async function readEvents(
  sql: SqlExec,
  slug: string,
  sessionId: string,
  startIndex: number,
  limit: number,
): Promise<PlatformSessionEvent[]> {
  const rows = await sql(
    `select event_index, event::text as event from aai_platform.session_events
      where slug = $1 and session_id = $2 and event_index >= $3
      order by event_index
      limit $4`,
    [slug, sessionId, startIndex, limit],
  );
  return rows.flatMap((row) => {
    const index = Number(row.event_index);
    return Number.isInteger(index) && typeof row.event === "string"
      ? [{ index, event: row.event }]
      : [];
  });
}

/**
 * The next free index — one past the HIGHEST stored, never a count.
 *
 * The module doc has the argument. `coalesce(max(...), -1) + 1` so an empty log
 * answers 0 rather than `NaN`, and so the arithmetic is the database's rather than
 * this process's.
 */
export async function nextEventIndex(
  sql: SqlExec,
  slug: string,
  sessionId: string,
): Promise<number> {
  const rows = await sql(
    `select coalesce(max(event_index), -1) + 1 as next from aai_platform.session_events
      where slug = $1 and session_id = $2`,
    [slug, sessionId],
  );
  const next = Number(rows[0]?.next);
  return Number.isInteger(next) && next >= 0 ? next : 0;
}

/**
 * How long a row outlives the last write to it.
 *
 * Read by `pg-cron.ts`, which is where the sweep lives: a scheduled DATABASE job
 * survives replica churn, and this one needs nothing but SQL. An in-process pass
 * was the first draft and is the wrong home — `orphan-previews.ts` moved the other
 * way only because it reaps through the Management API.
 *
 * Two days, the same window the per-app sweep used, and for the same reason: the
 * cost of keeping one is a few KB, and the cost of dropping one early is a caller
 * who reconnects to an agent that has forgotten them — which is the failure this
 * whole path exists to remove, arriving by a new route.
 */
export const SESSION_STATE_RETENTION = "2 days";
