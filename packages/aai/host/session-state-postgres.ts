// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the session-state store: one row per `(session, slot)` in
 * the app's own schema.
 *
 * ## Why the table is created here rather than provisioned
 *
 * Because there is no provisioning pass to hang a DDL step off — an agent's
 * first session may be its first ever deploy. That is the same position
 * `host/workflow-wake-hint.ts` and `host/workflow-keys.ts` are in, so this takes
 * the same route with the same posture: `create table if not exists` in the
 * tenant's own schema, owned and written by the tenant's own role, and therefore
 * **never authority for anything the platform decides**. The platform reads it
 * only to reclaim rows whose guest is gone.
 *
 * ## What the app's schema guarantees, which is the premise
 *
 * The schema and role name is `app_` + the first 16 hex chars of
 * `sha256(slug)` — DERIVED from the slug, so it cannot change when a sandbox is
 * replaced — and `DATABASE_URL` is recomposed at every sandbox construction from
 * the stored `app-db:<slug>` meta, which lives in Vault and outlives any
 * sandbox. `provisionAppDatabase` rotates the role password on every call and
 * has exactly one caller, the storage-enable route: **a deploy does not
 * re-provision**, so a redeploy neither rotates the credential nor touches the
 * schema. That is what makes a value written by one sandbox readable by its
 * replacement.
 *
 * One consequence worth stating because it is not obvious: **disabling storage
 * destroys persisted state**, since `deprovision` drops the schema.
 *
 * ## The connection budget
 *
 * `APP_DB_CONNECTION_LIMIT` is 4 per app role and one guest serves many
 * concurrent sessions, so this shares a pool with `ctx.db`, the workflow world
 * and the wake-hint publisher. It therefore takes the runtime's ALREADY-OPEN
 * handle rather than opening its own — the wake hint opens a second one because
 * it runs on a timer with no session in hand, and this never does.
 *
 * Note `statement_timeout` on the app role is `USERSET`, so the 10s setting is
 * not what bounds a commit; the bound that holds is the tool call's own deadline.
 */

import type { Db } from "../sdk/db.ts";
import type { SessionStateBackend } from "./session-state-store.ts";

/**
 * The table session state lives in — the ONE contract both ends derive from.
 *
 * The guest writes it and `aai-server`'s TTL sweep reads it out of
 * `app_<hash>.<this table>`, so spelling it in the SDK rather than in either
 * consumer is what keeps a rename from being two edits that can disagree. The
 * platform imports this constant.
 *
 * Named `aai_`-first for a reason that is a product one rather than a technical
 * one: `appDatabaseUsage` counts every base table in the app schema and the
 * studio shows that as the USER's own database usage, so a table an author did
 * not create has to say whose it is.
 *
 * @internal
 */
export const SESSION_STATE_TABLE = "aai_session_state";

/**
 * `jsonb` rather than `text`, even though every read and write here is a string.
 *
 * The value crosses this boundary serialized, so `text` would work and would be
 * marginally cheaper. `jsonb` earns it by making the column REJECT anything that
 * is not JSON at write time — the one check the driver can make that the process
 * above it cannot fake — which is exactly the class of bug an in-memory store
 * cannot represent.
 *
 * `updated_at` is what the platform's TTL sweep reads, so it is maintained on
 * every upsert rather than only on insert.
 */
const CREATE_TABLE_SQL = (table: string) => `create table if not exists ${table} (
  session_id text not null,
  slot text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (session_id, slot)
)`;

const LOAD_SQL = `select slot, value::text as value from ${SESSION_STATE_TABLE} where session_id = $1`;

/**
 * One statement for however many slots changed, so a flush is one round trip
 * against a connection budget of four.
 *
 * `unnest` rather than a generated `values` list with a growing parameter count:
 * the driver is in transaction-pooling mode (`prepare: false`), so a per-shape
 * statement buys no plan reuse and a fixed three-parameter shape is one less
 * thing to get wrong.
 */
const COMMIT_SQL = `insert into ${SESSION_STATE_TABLE} (session_id, slot, value, updated_at)
select $1, s.slot, s.value::jsonb, now()
from unnest($2::text[], $3::text[]) as s(slot, value)
on conflict (session_id, slot)
do update set value = excluded.value, updated_at = now()`;

const DISCARD_SQL = `delete from ${SESSION_STATE_TABLE} where session_id = $1`;

/**
 * The session EVENT log's table — the second contract both ends derive from, for
 * the same reason as {@link SESSION_STATE_TABLE} and swept by the same job.
 *
 * @internal
 */
export const SESSION_EVENT_TABLE = "aai_session_events";

/**
 * `(session_id, event_index)` is the primary key, which is what makes a retried flush
 * idempotent: `on conflict do nothing` turns a re-append of an index already
 * stored into the no-op the backend contract promises. The index is assigned
 * above this module, so the database never invents one — a `serial` here would
 * hand out positions the live session had already told a client about.
 *
 * `jsonb` for the same reason the slot table uses it: the column rejects
 * anything that is not JSON at write time, which is the one check the process
 * above cannot fake.
 */
const CREATE_EVENT_TABLE_SQL = (table: string) => `create table if not exists ${table} (
  session_id text not null,
  event_index bigint not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, event_index)
)`;

/**
 * The DDL an app's schema needs before a session can store anything.
 *
 * **The platform applies this at PROVISIONING time**
 * (`aai-server/app-database.ts`), which is the one place an app schema is
 * created — the tables are part of what "this app has a database" means, exactly
 * as its role and grants are. It lives HERE because the shape is the SDK's; the
 * platform executes it rather than knowing it, so there is one source of truth
 * and no second copy to drift.
 *
 * It used to run in the GUEST, `create table if not exists` on the read and write
 * paths behind two `ensureOnce` memos. Two reasons that went:
 *
 * - **It bought nothing it appeared to.** The argument for guest-side DDL was
 *   that the table shape belongs to the bundle's own SDK version — but
 *   `if not exists` is a no-op once the table exists, so a newer SDK expecting an
 *   added column was broken either way. The property was never there to protect.
 * - **It was two round trips and a `42P07` NOTICE per guest boot**, dumped into
 *   the log an operator reads to diagnose a session.
 *
 * `schema` qualifies the names for a caller whose `search_path` is not the app's
 * — which is every platform caller, since the admin connection is pinned
 * nowhere. The guest's own role IS pinned (`alter role … set search_path`), so it
 * would need no qualification; it no longer runs this at all.
 *
 * @internal
 */
export function sessionStateDdl(schema?: string): string[] {
  const qualify = (table: string) => (schema ? `"${schema}".${table}` : table);
  return [
    CREATE_TABLE_SQL(qualify(SESSION_STATE_TABLE)),
    CREATE_EVENT_TABLE_SQL(qualify(SESSION_EVENT_TABLE)),
  ];
}

const APPEND_EVENTS_SQL = `insert into ${SESSION_EVENT_TABLE} (session_id, event_index, event)
select $1, s.event_index::bigint, s.event::jsonb
from unnest($2::bigint[], $3::text[]) as s(event_index, event)
on conflict (session_id, event_index) do nothing`;

const READ_EVENTS_SQL = `select event_index, event::text as event from ${SESSION_EVENT_TABLE}
where session_id = $1 and event_index >= $2 order by event_index limit $3`;

/**
 * The NEXT FREE INDEX, which is `max + 1` and deliberately not `count(*)`.
 *
 * The two agree only for a log that is dense from zero, and this one need not be:
 * an event past `MAX_SESSION_EVENTS` advances the position without ever being
 * stored, and a flush that failed while later ones succeeded leaves a hole. Both
 * make `count(*)` SMALLER than the highest index written — so a session resuming
 * onto a replacement process continued at a position it had already used, its
 * `tail` went backwards (which the store's contract says must never happen), and
 * `on conflict do nothing` silently discarded every re-used index.
 */
const NEXT_EVENT_INDEX_SQL = `select coalesce(max(event_index) + 1, 0)::int as count
from ${SESSION_EVENT_TABLE} where session_id = $1`;

const DISCARD_EVENTS_SQL = `delete from ${SESSION_EVENT_TABLE} where session_id = $1`;

/**
 * Session state stored in the app's own Postgres schema.
 *
 * @internal
 */
export function createPostgresStateBackend(opts: { db: Db }): SessionStateBackend {
  const { db } = opts;
  // No DDL here, deliberately: the tables come with the schema
  // (`sessionStateDdl`, applied by the platform when an app's database is
  // provisioned). This backend used to `create table if not exists` on both the
  // read and write paths behind two memos — two round trips and a `42P07` NOTICE
  // on every guest boot, for a guarantee `if not exists` cannot give (see
  // `sessionStateDdl`). A missing table now surfaces as the honest error it is:
  // this app's schema was never provisioned with one.

  return {
    name: "postgres",
    durable: true,
    async load(sessionId) {
      const rows = await db.query<{ slot: string; value: string }>(LOAD_SQL, [sessionId]);
      return new Map(rows.map((row) => [row.slot, row.value]));
    },
    async commit(sessionId, values) {
      await db.query(COMMIT_SQL, [sessionId, [...values.keys()], [...values.values()]]);
    },
    async discard(sessionId) {
      // Both, in one call, because one session's durable footprint is both
      // tables — see the backend type's doc.
      await db.query(DISCARD_SQL, [sessionId]);
      await db.query(DISCARD_EVENTS_SQL, [sessionId]);
    },
    async appendEvents(sessionId, pending) {
      await db.query(APPEND_EVENTS_SQL, [
        sessionId,
        pending.map((event) => event.index),
        pending.map((event) => event.json),
      ]);
    },
    async readEvents(sessionId, startIndex, limit) {
      const rows = await db.query<{ event_index: number; event: string }>(READ_EVENTS_SQL, [
        sessionId,
        startIndex,
        limit,
      ]);
      return rows.map((row) => ({ index: Number(row.event_index), json: row.event }));
    },
    async countEvents(sessionId) {
      const rows = await db.query<{ count: number }>(NEXT_EVENT_INDEX_SQL, [sessionId]);
      return rows[0]?.count ?? 0;
    },
  };
}
