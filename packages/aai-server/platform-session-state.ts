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
 * BOTH tables — and this is now the CONTRACT every backend answers to rather
 * than this one's local advantage. It used to differ from `ctx.db`'s backend,
 * which dropped slots only on the ground that a per-app role held `select,
 * insert` on the event table; that role went with per-app databases, so the
 * asymmetry outlived its mechanism and left "discarded" meaning two things
 * depending on where a session ran. `aai-runtime/session-state-conformance.ts`
 * carries the decision and asserts it as a shared case on every arm, this
 * route's included (`session-state-conformance-platform.scenario.test.ts`).
 * Nothing here changed: the statement below was already right.
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

/**
 * Events from `startIndex` inclusive, in index order, at most `limit`.
 *
 * ## A row this cannot read fails the PAGE, and is never skipped
 *
 * The same refusal `nextEventIndex` makes below, for a reason one step removed
 * and just as silent. This is a CURSOR read: a caller takes the page, advances
 * past the highest index in it, and never asks that range again. So a row
 * dropped here is not a degraded answer, it is a HOLE — the event is gone from
 * the stream and nothing anywhere says so, because a page it was skipped from
 * looks exactly like a page that never held it. `flatMap` returning `[]` for an
 * unreadable row was doing precisely that.
 *
 * The read is `readIndex`'s, i.e. `typeof` FIRST, and the coercion trap is
 * WORSE here than one method over: `Number(row.event_index)` turns a NULL
 * column into `0`, which passes `Number.isInteger` — so such a row was not even
 * dropped, it was emitted AT INDEX 0, displacing the real first event of the
 * session in every reader's page.
 *
 * A throw is safe for the reason it is safe below, plus one more. Both columns
 * are `not null` (`20260827020000_platform_session_state.sql`) and `event::text`
 * of a `jsonb` is always a string, so this is unreachable on a healthy request.
 * And unlike `countEvents` this method is on no hydrate path: its one consumer
 * is the read-only session-events surface
 * (`aai-runtime/session-event-stream.ts` -> `session-events-api.ts`), where a
 * rejection is a logged 500 on a diagnostic read rather than a failed session.
 *
 * Note what it does NOT take over. A stored event whose JSON will not PARSE is
 * still dropped with a warning one layer up, deliberately: that is a judgement
 * about event CONTENT, made where there is a logger to announce it. This is a
 * judgement about whether the READ happened.
 */
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
  return rows.map((row) => {
    const index = readIndex(row.event_index);
    if (!Number.isInteger(index) || index < 0 || typeof row.event !== "string") {
      // The INDEX only. Never the sessionId — the slug is already in
      // `withReserved`'s `detail` — and never the event body, which is a
      // caller's own data and would be reaching a warn line.
      throw new Error(`session-state readEvents read a non-event at ${String(row.event_index)}`);
    }
    return { index, event: row.event };
  });
}

/**
 * The driver's `next`, read WITHOUT coercing an unreadable answer into one.
 *
 * The ORDER is the whole finding, and it is the same one the runtime's client
 * states one package over: `typeof` FIRST, then `Number`. `Number(null)` is `0`
 * and `Number("")` is `0`, so a check applied to the COERCED value passes a NULL
 * column straight through as the one answer that must never be guessed — which
 * is how a `: 0` fallback here survived review and why the obvious repair
 * (keeping `Number(...)` and throwing on `!Number.isInteger`) still would not
 * have caught it. Verified: that draft answered `0` for `{ next: null }`.
 *
 * A `NaN` return means "this is not an index", which BOTH callers refuse —
 * `readEvents` above and `nextEventIndex` below.
 */
function readIndex(answered: unknown): number {
  // What a fake `SqlExec` and the memory-shaped arms hand back.
  if (typeof answered === "number") return answered;
  // `event_index` is a `bigint` and postgres.js returns `int8` as a STRING, so
  // this is the production path — see `nextEventIndex`'s own doc. Digits only:
  // `Number` is willing to read `""`, `" "` and `"0x10"`, and none of those is
  // something this column can produce.
  if (typeof answered === "string" && /^\d+$/.test(answered)) return Number(answered);
  // Belt and braces for a driver configured to hand `int8` back as a `bigint`.
  if (typeof answered === "bigint") return Number(answered);
  return Number.NaN;
}

/**
 * The next free index — one past the HIGHEST stored, never a count.
 *
 * The module doc has the argument. `coalesce(max(...), -1) + 1` so an empty log
 * answers 0 rather than `NaN`, and so the arithmetic is the database's rather than
 * this process's.
 *
 * ## `event_index` is a `bigint`, so the driver hands this back as a STRING
 *
 * postgres.js returns `int8` as a string — `"6"`, not `6` — and the aggregate
 * above is `bigint` arithmetic, so `Number` is the READ and not a tidy-up. The
 * same rule `platform-workflow-journal.ts` states for `millis`. Nothing but the
 * real-Postgres arm can see it: every other arm of the session-state contract
 * answers a JS number by construction, so removing the read reddens 12 cases in
 * `session-state-conformance-platform.scenario.test.ts` and nothing anywhere
 * else. `platform-session-state.test.ts` pins it in the unit tier for exactly
 * that reason — a fact reachable only from the arm that needs a database is a
 * fact somebody deletes.
 *
 * ## An answer this cannot read THROWS, and never defaults to 0
 *
 * `0` is the one value that must not be guessed here: it means "this session has
 * no events", so a resumed session restarts its log at 0 and its appends
 * overwrite history from the start — silently, because `on conflict do nothing`
 * discards the re-appends. The runtime's client
 * (`aai-runtime/session-state-platform.ts`) refuses an unreadable `countEvents`
 * for precisely that reason, and this end used to do the opposite — a defence in
 * depth pointing the wrong way. Measured: with the `: 0` fallback in place, an
 * A/B removing the read above reddened six shared cases and left FIVE zero-log
 * ones green, passing on the fallback rather than on a correct read. Both ends
 * refuse now; neither guesses, and that A/B reddens all 12.
 *
 * It is also unreachable on a healthy request, which is what makes a throw safe:
 * an aggregate with no `group by` returns exactly one row and `coalesce` makes
 * `next` non-null, so this cannot 503 a working session. `withReserved` maps it
 * to a 503 with the value in the warn line. The coercion trap that made the
 * fallback look harmless is `readIndex`'s subject and is why the read is
 * `typeof`-first. Same shape as `readPlatformDbCapacity` refusing an unreadable
 * `max_connections`, and as `claimAttempt` refusing an empty `returning`.
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
  const answered = rows[0]?.next;
  const next = readIndex(answered);
  if (!Number.isInteger(next) || next < 0) {
    // The value only, never the sessionId: this string reaches a warn line, and
    // the slug is already in `withReserved`'s `detail`.
    throw new Error(`session-state countEvents read a non-index: ${String(answered)}`);
  }
  return next;
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
