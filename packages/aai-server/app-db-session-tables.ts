// Copyright 2026 the AAI authors. MIT license.
/**
 * The session-state tables inside an app's own database, and who may touch
 * them.
 *
 * Split out of `app-database.ts` at its length cap, on the seam that was
 * already there: everything else in that module is about the DATABASE and the
 * ROLE — creating them, placing them, dropping them — while these three are
 * about two tables the PLATFORM owns inside one.
 *
 * @module
 */

import {
  SESSION_EVENT_TABLE,
  SESSION_STATE_TABLE,
  sessionStateDdl,
} from "@alexkroman1/aai-runtime/internal";
import { appDbIdentifier, assertIdentifier } from "./app-db-identifier.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * The schema an app's own tables live in. Its own database, so `public` is
 * simply its default — which is what makes an unqualified `create table t (…)`
 * through `ctx.db` work with no `search_path` pin.
 */
export const APP_DB_SCHEMA = "public";

/**
 * Create the session-state tables in an app's database.
 *
 * **Part of what "this app has a database" MEANS**, alongside its role and its
 * grants — so it belongs where the database is created rather than in the guest
 * that later queries it. The DDL itself is the SDK's (`sessionStateDdl`), applied
 * here rather than known here: one source of truth for a shape both ends derive
 * from, which is the same rule `SESSION_STATE_TABLE` already follows.
 *
 * Runs on a connection INTO the app's database, so it needs no schema
 * qualification beyond `public` — unlike the old model, where this ran on the
 * platform admin connection whose `search_path` was pinned nowhere.
 */
export async function ensureSessionTables(sql: SqlExec): Promise<void> {
  for (const statement of sessionStateDdl(APP_DB_SCHEMA)) {
    await sql(statement);
  }
}

/**
 * Let the app's role USE the session-state tables the admin just created.
 *
 * **A grant is needed at all because the ADMIN creates them.** `create table`
 * makes the creator the owner, and a role holding `usage, create` on a schema has
 * no privileges on tables it did not create — so a session's first read failed
 * `permission denied for table aai_session_events`, and with it every session on
 * an app with storage enabled. The tenant's OWN tables are unaffected: it creates
 * those, so it owns them.
 *
 * **DML only, and ownership stays with the admin.** Transferring the tables to the
 * app role would also work and is worse in two ways: the tenant could then `drop`
 * or `alter` the framework's own tables (a session store that a tool can delete is
 * not a store), and the per-app sweep — which runs as the ADMIN through
 * `cron.schedule_in_database` — would need grants of its own to delete expired
 * rows. This direction needs neither.
 *
 * Named explicitly rather than `all tables in schema public`, because that would
 * also hand the role privileges on anything else the admin ever creates here; the
 * two tables this platform owns are the two it should grant.
 *
 * **The two tables get DIFFERENT grants, and that is the point.** A slot value is
 * a read-modify-write cell, so the state table needs all four verbs. The event
 * table is an append-only LOG, and `ctx.db` hands tool code arbitrary SQL on this
 * very role — so `delete` there meant a tool could remove its own audit trail in
 * one statement, and `update` meant it could rewrite one. The SDK's own doc says
 * a session-event handler is observe-only because "anything a reader can change
 * it can no longer describe"; the grant is where that stops being true.
 *
 * What `select, insert` still permits is APPENDING a forged line, which no grant
 * short of a second role can prevent while one credential serves both the runtime
 * and tool code — and a second role costs a second pool against
 * `APP_DB_CONNECTION_LIMIT`, which is the platform's scarcest resource
 * (`MAX_ACTIVE_APP_DATABASES` is 2). Append-only is the property that was
 * available; it is the one an audit log is usually asked for.
 *
 * Reclaiming a discarded session's events is therefore the SWEEP's job alone
 * (`_session-state-sweep.ts`, running as the admin), which is why
 * `createPostgresStateBackend.discard` no longer deletes them.
 */
export async function grantSessionTables(sql: SqlExec, id: string): Promise<void> {
  await sql(
    `grant select, insert, update, delete on ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE} to "${id}"`,
  );
  await sql(`grant select, insert on ${APP_DB_SCHEMA}.${SESSION_EVENT_TABLE} to "${id}"`);
  // Idempotent, and the reason it is here rather than only in a fresh
  // provision: an app database created before this split still carries the old
  // blanket grant, and nothing re-provisions one (that would rotate the role's
  // password under a live guest — see `enableStorage`). Revoking on every
  // reconcile is what heals them.
  await sql(`revoke update, delete on ${APP_DB_SCHEMA}.${SESSION_EVENT_TABLE} from "${id}"`);
}

/**
 * Re-apply the session-table grants for an app that already has a database.
 *
 * The one path that heals an app provisioned before the append-only split above.
 * It is deliberately NOT a re-provision: that mints a new password and would
 * break `ctx.db` under any resident guest holding the old one. Grants alone are
 * idempotent and touch no credential.
 *
 * Best-effort by contract — the caller is a status read or an already-enabled
 * `enableStorage`, and neither should fail because a grant could not be
 * reconciled.
 */
export async function reconcileSessionGrants(sql: SqlExec, slug: string): Promise<void> {
  // Shape-asserted for the same reason `provisionAppDatabase` does it: the id is
  // interpolated into DDL, which cannot take bind parameters.
  await grantSessionTables(sql, assertIdentifier(appDbIdentifier(slug)));
}
