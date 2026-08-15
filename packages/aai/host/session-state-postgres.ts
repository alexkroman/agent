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
import { ensureOnce } from "./_ensure-once.ts";
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
const CREATE_TABLE_SQL = `create table if not exists ${SESSION_STATE_TABLE} (
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
 * Session state stored in the app's own Postgres schema.
 *
 * @internal
 */
export function createPostgresStateBackend(opts: { db: Db }): SessionStateBackend {
  const { db } = opts;
  /**
   * `ensureOnce` owns the memo AND the clear-on-rejection: a failed DDL must not
   * be remembered as done, so a transient privilege or connection fault is
   * recoverable without a redeploy. Same reasoning as the wake hint's.
   */
  const ensureTable = ensureOnce(() => db.query(CREATE_TABLE_SQL).then(() => undefined));

  return {
    name: "postgres",
    durable: true,
    async load(sessionId) {
      // The table may not exist yet — this session may be the agent's first
      // ever. Creating it on the READ path as well as the write path is what
      // keeps a hydrate from failing the session start of a fresh deploy.
      await ensureTable();
      const rows = await db.query<{ slot: string; value: string }>(LOAD_SQL, [sessionId]);
      return new Map(rows.map((row) => [row.slot, row.value]));
    },
    async commit(sessionId, values) {
      await ensureTable();
      await db.query(COMMIT_SQL, [sessionId, [...values.keys()], [...values.values()]]);
    },
    async discard(sessionId) {
      await ensureTable();
      await db.query(DISCARD_SQL, [sessionId]);
    },
  };
}
