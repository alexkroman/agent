// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the session-state store: one row per `(session, slot)` in
 * the app's own database.
 *
 * ## Who creates the table
 *
 * Not this backend, and not on its read or write paths — see
 * {@link createPostgresStateBackend}, which carries that argument. The shape is
 * {@link sessionStateDdl} and the OWNER of the database applies it: a migration on
 * the platform's own, or {@link ensureSessionStateSchema} at boot for a deployment
 * that brought its own `DATABASE_URL`.
 *
 * This section used to say the opposite — "`create table if not exists` in the
 * tenant's own schema" — describing the lazy DDL that was removed from those paths,
 * so the header and the function body disagreed about the module's central rule.
 *
 * What has not changed is the posture: these tables are owned and written by the
 * TENANT's own role and are therefore **never authority for anything the platform
 * decides**. The platform reads them only to reclaim rows whose guest is gone.
 *
 * ## What the app's schema guarantees, which is the premise
 *
 * The schema and role name is `app_` + the first 16 hex chars of
 * `sha256(slug)` — DERIVED from the slug, so it cannot change when a sandbox is
 * replaced — and `DATABASE_URL` is recomposed at every sandbox construction from
 * the stored connection meta, which lives in Vault and outlives any
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
 * An app role's `connection limit` is 4 or 10 depending on its TIER
 * (`appDbConnectionLimit`, `aai-server/constants.ts`) and one guest serves many
 * concurrent sessions, so this shares a pool with `ctx.db`, the workflow world
 * and the wake-hint publisher. Note the STORAGE tier's 4 is the whole role's
 * entitlement, which is why this may not open a handle of its own. It therefore takes the runtime's ALREADY-OPEN
 * handle rather than opening its own — the wake hint opens a second one because
 * it runs on a timer with no session in hand, and this never does.
 *
 * Note `statement_timeout` on the app role is `USERSET`, so the 10s setting is
 * not what bounds a commit; the bound that holds is the tool call's own deadline.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { Db } from "@alexkroman1/aai/internal";
import { createPostgresDb } from "./postgres-db.ts";
import type { Logger } from "./runtime-config.ts";
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

/**
 * The session EVENT log's table — the second contract both ends derive from, for
 * the same reason as {@link SESSION_STATE_TABLE} and swept by the same job.
 *
 * @internal
 */
export const SESSION_EVENT_TABLE = "aai_session_events";

/**
 * BOTH tables, in ONE statement.
 *
 * A CTE rather than two awaited queries, the same shape
 * `aai-server/platform-session-state.ts`'s `discardSession` already had: the two
 * deletes are independent — no ordering requirement either way — so a second
 * round trip bought nothing, and a CTE makes the pair atomic where two
 * statements on an unwrapped connection were not.
 *
 * The `where session_id = $1` is on BOTH arms. Widening what a statement deletes
 * is exactly when a scoping predicate gets dropped, which is why the shared
 * conformance table asks "discard drops NOBODY else's event log" beside the
 * reach itself.
 *
 * **It sits BELOW `SESSION_EVENT_TABLE` and has to.** Naming the second table
 * moved this constant into that `const`'s temporal dead zone, which is a
 * module-load `ReferenceError` rather than a type error — three suites failed to
 * IMPORT (`Cannot access 'SESSION_EVENT_TABLE' before initialization`) while
 * `tsc` was clean, because every statement in this file is a template literal
 * evaluated at module scope in source order.
 */
const DISCARD_SQL = `with slots as (
  delete from ${SESSION_STATE_TABLE} where session_id = $1
)
delete from ${SESSION_EVENT_TABLE} where session_id = $1`;

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
 * (a migration on whichever database owns them), which is the one place a schema is
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
 * `schema` qualifies the names for a caller that is not already IN the app's
 * schema. The platform passes `public` and runs it on a connection into the app's
 * own DATABASE, where that is simply the default — there is no `search_path` pin
 * any more, because an app owning its own database needs none. The guest does not
 * run this at all.
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

/**
 * Apply {@link sessionStateDdl} to a database this process OWNS, once, at boot.
 *
 * The contract above says whoever owns the database applies the DDL — "a
 * migration on the platform's own, or the operator of a self-hosted deployment".
 * There are TWO of those operators and neither had a way to act on it: `aai dev`,
 * and the scaffold's `server.mjs`, which is what `npm start` runs. A project that
 * sets `DATABASE_URL` (which the scaffold's own `.env` invites, for durable
 * workflow runs) got a boot line reporting `sessionState: postgres, durable: true`
 * and then **every session died at start** with a fatal 1011 the client reads as
 * "Session failed to start", the real reason —
 * `relation "aai_session_events" does not exist` — being visible only in the
 * server's log. Reproduced on a clean project against a plain Postgres 16, on both
 * paths.
 *
 * The asymmetry is what makes it a bug rather than a missing chore: the workflow
 * world migrates itself on that same boot and says so, so one subsystem
 * provisions and the other silently does not.
 *
 * **Best-effort, and never fatal.** A self-hosted deployment whose role may not
 * CREATE — because a real migration already made these tables — must keep
 * booting, so a failure here is one warning and the run continues. If the tables
 * genuinely are absent, the backend's own error still says exactly that, which is
 * a better diagnostic than refusing to start.
 *
 * It opens its OWN single-connection pool and closes it: the caller (the CLI dev
 * server) has no `Db` of its own, the runtime builds one from the same URL
 * afterwards, and a pool held open for two statements would sit against the
 * connection budget `sdk/app-db-budget.ts` describes for the rest of the process.
 *
 * **PUBLIC, because the second of those operators is not ours.** `aai dev` could
 * have reached this through `@alexkroman1/aai-runtime/internal`, where it started;
 * `server.mjs` is a file that ships to a user and may only import the published
 * surface, so a self-hosted deployment could not apply the DDL it is contractually
 * responsible for. Hence the root barrel and the `session-state` capability — the
 * missing half of a rule this module already stated, not a convenience.
 *
 * @public
 */
export async function ensureSessionStateSchema(opts: {
  url: string;
  logger: Logger;
}): Promise<boolean> {
  const db = createPostgresDb({ url: opts.url, max: 1 });
  try {
    return await applySessionStateDdl({ db, logger: opts.logger });
  } finally {
    await db.close().catch(() => undefined);
  }
}

/**
 * {@link ensureSessionStateSchema} minus the pool — the half worth specifying.
 *
 * Split out so the decisions (which statements, in order, and warn-rather-than-
 * throw) are testable against a `Db` double, leaving the exported wrapper as
 * nothing but open/close. A test-only parameter on the wrapper would have bought
 * the same coverage and put the seam in the shipped signature.
 *
 * Not on `internal.ts`: the wrapper is the entry point a host calls, and this is
 * reachable from its own package's spec without widening that surface.
 *
 * @internal
 */
export async function applySessionStateDdl(opts: { db: Db; logger: Logger }): Promise<boolean> {
  try {
    // Sequentially, not `Promise.all`: two `create table if not exists` racing on
    // one connection is a needless way to meet Postgres's own catalog locks, and
    // there are two statements.
    for (const statement of sessionStateDdl()) await opts.db.query(statement);
    return true;
  } catch (err) {
    opts.logger.warn(
      `could not ensure the session-state tables (${SESSION_STATE_TABLE}, ${SESSION_EVENT_TABLE}) ` +
        `in DATABASE_URL: ${errorMessage(err)}. Sessions will fail to start unless a migration ` +
        "has already created them.",
    );
    return false;
  }
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
      // BOTH tables, and this backend is the one that CHANGED to say so.
      //
      // It dropped slots only, on the rule that "a log a tool can delete is not
      // a log" — which rested on `grantSessionTables` in aai-server narrowing a
      // per-app role to `select, insert` on the event table. That role went with
      // per-app databases and the function no longer exists; what
      // `provisionAppDatabase` issues today is
      // `grant select, insert, update, delete` on BOTH tables (spelled out in
      // `aai-server/session-state.scenario.test.ts`, which fails when the real
      // grants change), so the mechanism the asymmetry was justified by has been
      // gone for a while and only the asymmetry was left.
      //
      // What it cost is a word meaning two things: the same agent's ended
      // session kept a readable event log for up to `SESSION_STATE_RETENTION` on
      // a self-hosted database and lost it immediately on the platform, so a
      // caller could not act on "discarded" without knowing where the session
      // ran. Both other backends reclaimed both all along. The log is a
      // debugging convenience rather than a record anything reads back, so the
      // platform's answer is the contract now and the shared conformance table
      // asserts it on every arm.
      //
      // The retention sweep STAYS, as the backstop it always was for the case
      // this call cannot reach: a session whose guest died before it discarded.
      await db.query(DISCARD_SQL, [sessionId]);
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
