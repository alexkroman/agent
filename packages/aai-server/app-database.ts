// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-app databases ("storage"): each app that enables storage gets its own
 * Postgres DATABASE plus a matching LOGIN role, inside the platform's Supabase
 * instance (`SUPABASE_DB_URL`). Tool code reaches it as `ctx.db`: the app's OWN
 * scoped credentials are handed to the guest as `DATABASE_URL` in its boot env,
 * and the bundle's runtime connects directly — exactly as `aai dev` does with a
 * project `.env`. Platform ADMIN credentials never enter the guest.
 *
 * **A real database, not a schema, and the reason is the Workflow DevKit.**
 * This was one schema per app inside the platform database, with the app role's
 * `search_path` pinned to it. That model cannot host a durable workflow at all:
 * `@workflow/world-postgres` puts its run journal in a `workflow` schema and its
 * queue in `graphile_worker`, both of which are DATABASE-level names that cannot
 * nest inside `app_<hex>`. Creating them needs `CREATE ON DATABASE`, which is
 * exactly the privilege a shared database cannot hand a tenant — so the DevKit's
 * migration failed with `42501 permission denied for database postgres` and every
 * workflow silently had nowhere to live. Verified against a real Postgres 17:
 * under the old grants both `create schema` statements are denied; inside the
 * app's own database both succeed. Per-database also closes a catalog leak for
 * free (an app role could enumerate every other tenant's schema and role name
 * out of `pg_namespace`/`pg_roles`; in its own database it sees none).
 *
 * **The database is owned by the ADMIN role, never by the app role.** Ownership
 * looks like the tidier model and makes the app undeletable: Supabase's
 * `postgres` is not a superuser, and a non-superuser cannot drop a database it
 * does not own — `42501 must be owner of database` — even one it created itself.
 * Recovering such a database takes `set role` to the owner first. So the admin
 * keeps ownership and the tenant is granted `create` INSIDE the database, which
 * is all `create schema` needs; `drop database … with (force)` then works
 * directly, even with a tenant connection open.
 *
 * **`revoke connect … from public` is THE tenant boundary.** Postgres grants
 * `CONNECT` on a new database to `PUBLIC`, so without the revoke every app role
 * can open every other app's database. Under the old model the boundary was a
 * schema grant; here it is this one statement, which is why it is not optional
 * and is asserted by the tests.
 *
 * Identifiers are `app_` + the first 16 hex chars of sha256(slug), naming the
 * database AND the role, so they are always `[a-z0-9_]` and safe to interpolate
 * into DDL after the shape assertion below. The role's password is crypto-random
 * 32-hex, likewise shape-asserted before it is quoted into `create/alter role`.
 */

import { hash, randomBytes } from "node:crypto";
import { safeJsonParse } from "@alexkroman1/aai";
import {
  SESSION_EVENT_TABLE,
  SESSION_STATE_TABLE,
  sessionStateDdl,
} from "@alexkroman1/aai/runtime";
import { isRecord } from "@alexkroman1/aai/utils";
import { scheduleAppSweeps, unscheduleAppSweeps } from "./_session-state-sweep.ts";
import { appDbAdminUrl, appDbUrlFor, withDatabase } from "./app-db-url.ts";
import { type AppDbUsage, appDatabaseUsage } from "./app-db-usage.ts";
import { APP_DB_CONNECTION_LIMIT } from "./constants.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * Provisioned credentials for one app's database, stored as `app-db:<slug>`.
 * The role name doubles as the DATABASE name (one `app_<hex>` identifier).
 */
export type AppDbMeta = {
  role: string;
  password: string;
  /**
   * Admin connection URL of the cluster this app lives on — the database
   * locator. Provisioning picks a target from the configured cluster list
   * (APP_DB_URLS, defaulting to the platform database), so apps can be
   * placed on any of N Supabase projects; `open` follows the stored URL.
   * Absent only in rows from before the locator existed → primary cluster.
   */
  url?: string;
};

// `appDbAdminUrl` is deliberately absent: this module is its only caller (the
// wake sweep's way in), so re-exporting it would widen the surface to nothing.
export { appDbConnectionUrl, appDbUrlFor } from "./app-db-url.ts";
export { type AppDbUsage, appDatabaseUsage } from "./app-db-usage.ts";

const IDENTIFIER_RE = /^app_[a-f0-9]{16}$/;

/**
 * The schema an app's own tables live in. Its own database, so `public` is
 * simply its default — which is what makes an unqualified `create table t (…)`
 * through `ctx.db` work with no `search_path` pin. The old model needed that
 * pin precisely because `public` belonged to the platform.
 */
export const APP_DB_SCHEMA = "public";

/**
 * A bound on scratch disk from one tenant's pathological sorts and hash joins.
 *
 * The other half of the per-tenant caps; its companion, the role's connection
 * ceiling, moved to `constants.ts` because it is a term in the fleet-wide
 * connection budget and this is not — disk is per-instance and reclaimed when
 * the query ends, where a connection is a slot nobody else can have meanwhile.
 * Best-effort: `temp_file_limit` is a superuser GUC on vanilla Postgres, so
 * provisioning swallows `insufficient_privilege` rather than failing over a
 * tenant nicety (see the DDL below).
 */
const APP_DB_TEMP_FILE_LIMIT = "64MB";

/** Deterministic database/role identifier for one app slug. */
export function appDbIdentifier(slug: string): string {
  return `app_${hash("sha256", slug).slice(0, 16)}`;
}

/**
 * Assert the derived-identifier shape before any DDL interpolation. The
 * identifier comes from a hex digest so this can only fail on a programming
 * error — but DDL cannot take bind parameters, so the assertion is the guard.
 */
function assertIdentifier(id: string): string {
  if (!IDENTIFIER_RE.test(id)) throw new Error(`Invalid app db identifier: ${id}`);
  return id;
}

/**
 * Open a connection to one database and hand back an executor plus its close.
 *
 * Provisioning needs this because two of its steps CANNOT run on the admin
 * connection: the `public` grant and the session-state DDL apply inside the new
 * database, and `information_schema` is per-database, so the usage read is the
 * same. The old per-schema model needed no such thing — every statement was a
 * qualified one on the one shared connection.
 */
export type AppDbOpener = (url: string) => { query: SqlExec; close(): Promise<void> };

/**
 * Provision (idempotently) the database + role for one app. Every call issues a
 * fresh random password — the caller persists the returned meta (in the
 * SecretStore under `app-db:<slug>`), so re-provisioning simply rotates it.
 *
 * Four steps rather than the old single batch, and the split is forced:
 * `create database` cannot run inside a transaction block, and a multi-statement
 * simple query IS one — `25001 DROP DATABASE cannot run inside a transaction
 * block` is the same rule from the other side. So the role DDL is one batch, the
 * database is its own statement, its grants are another, and the in-database
 * work needs a second connection.
 */
export async function provisionAppDatabase(
  sql: SqlExec,
  slug: string,
  targetUrl: string,
  open: AppDbOpener,
): Promise<AppDbMeta> {
  const id = assertIdentifier(appDbIdentifier(slug));
  const password = randomBytes(16).toString("hex");

  // Step 1 — the role, create-or-alter. One batch (no bind params: DDL cannot
  // take placeholders, the identifier is shape-asserted above and the password
  // is locally generated hex).
  //
  // Scrubbed on failure because the password is INLINED here: postgres drivers
  // attach the failing query text as an own property on the thrown error, and
  // the process safety nets (service-config.ts) console.error whole error
  // objects — so an unscrubbed provisioning failure would put a live per-app
  // password into platform logs.
  const failure = await sql(
    `do $$
begin
  if exists (select 1 from pg_roles where rolname = '${id}') then
    alter role "${id}" with login password '${password}' connection limit ${APP_DB_CONNECTION_LIMIT};
  else
    create role "${id}" with login password '${password}' connection limit ${APP_DB_CONNECTION_LIMIT};
  end if;
end
$$;
alter role "${id}" set statement_timeout = '10s';
do $$
begin
  -- Best-effort: temp_file_limit is a superuser GUC on vanilla Postgres;
  -- Supabase's postgres role can set it, but a stricter host must not fail
  -- provisioning over a tenant nicety.
  alter role "${id}" set temp_file_limit = '${APP_DB_TEMP_FILE_LIMIT}';
exception when insufficient_privilege then null;
end
$$`,
  ).then(
    () => null,
    (err: unknown) => err ?? new Error("App database provisioning failed"),
  );
  if (failure !== null) throw scrubSecret(failure, password);

  // Step 2 — the database itself. `create database` has no `if not exists`, so
  // existence is checked first and the duplicate SQLSTATE is absorbed: two
  // provisions racing (the slug lock makes this unlikely, not impossible) must
  // both succeed, since the second one's real work is the password rotation
  // above. Read the SQLSTATE, never the message.
  const existing = await sql("select 1 from pg_database where datname = $1", [id]);
  if (existing.length === 0) {
    try {
      await sql(`create database "${id}"`);
    } catch (err) {
      if (sqlState(err) !== DUPLICATE_DATABASE) throw err;
    }
  }

  // Step 3 — the tenant boundary, then the tenant's privileges inside it.
  // The revoke is what stops every app role connecting to every app database;
  // `create` is what lets the Workflow DevKit make its `workflow` and
  // `graphile_worker` schemas.
  await sql(`revoke connect on database "${id}" from public`);
  await sql(`grant connect, temporary, create on database "${id}" to "${id}"`);

  // Step 4 — inside the new database, on the ADMIN role (it owns it).
  const appDb = open(withDatabase(targetUrl, id));
  try {
    // Postgres 15+ made `public` owned by `pg_database_owner` and writable by
    // nobody else, so without this an app cannot create its own tables at all.
    await appDb.query(`grant usage, create on schema ${APP_DB_SCHEMA} to "${id}"`);
    await ensureSessionTables(appDb.query);
    await grantSessionTables(appDb.query, id);
  } finally {
    await appDb.close();
  }

  // Step 5 — the app's own janitorial job, scheduled INTO its database.
  //
  // Best-effort, and the only step that is: without pg_cron the app works
  // completely and merely accumulates expired session-state rows in its own
  // database, where a later provision re-schedules the job (`cron.schedule*`
  // upserts by name). Failing provisioning over it would refuse a database for
  // the sake of a sweep.
  await scheduleAppSweeps(sql, id).catch((err: unknown) => {
    console.warn(`App database ${id} provisioned without its session-state sweep:`, err);
  });

  return { role: id, password, url: targetUrl };
}

const DUPLICATE_DATABASE = "42P04";

/** The driver attaches SQLSTATE as `code`; read it rather than the message. */
function sqlState(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

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
async function ensureSessionTables(sql: SqlExec): Promise<void> {
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
 */
async function grantSessionTables(sql: SqlExec, id: string): Promise<void> {
  await sql(
    `grant select, insert, update, delete on ${APP_DB_SCHEMA}.${SESSION_STATE_TABLE},` +
      ` ${APP_DB_SCHEMA}.${SESSION_EVENT_TABLE} to "${id}"`,
  );
}

/**
 * Remove every occurrence of `secret` from an error before it can reach a
 * log: the message and every string own property (postgres drivers attach
 * the failing `query`/`parameters` there). Mutate-and-rethrow rather than
 * wrap, so the stack and type survive; a non-Error value is rendered to a
 * scrubbed message instead.
 */
function scrubSecret(failure: unknown, secret: string): unknown {
  if (!(failure instanceof Error)) {
    return typeof failure === "string" ? failure.replaceAll(secret, "[redacted]") : failure;
  }
  failure.message = failure.message.replaceAll(secret, "[redacted]");
  for (const key of Object.keys(failure)) {
    const value = (failure as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" && value.includes(secret)) {
      (failure as unknown as Record<string, unknown>)[key] = "[redacted]";
    }
  }
  return failure;
}

/**
 * Drop one app's database (with all its data) and its role. Idempotent.
 *
 * `with (force)` terminates whatever backends are still connected, which is the
 * normal case rather than an edge one: the app's guest holds a `ctx.db` pool and
 * a delete does not wait for a sandbox to retire. Without it the drop fails
 * `55006 database is being accessed by other users`.
 *
 * **Neither statement may run inside a transaction** (`25001`), which also means
 * this cannot be a pg_cron job body — see the orphan sweep's caller. The role
 * drop comes second because a role owning objects in a live database cannot be
 * dropped (`2BP01`); once the database is gone there is nothing left to depend
 * on it.
 */
export async function deprovisionAppDatabase(sql: SqlExec, slug: string): Promise<void> {
  const id = assertIdentifier(appDbIdentifier(slug));
  // Before the drop — a cron job naming a dropped database fails forever.
  await unscheduleAppSweeps(sql, id);
  await sql(`drop database if exists "${id}" with (force)`);
  // A SCHEMA of the same name, from an app provisioned before per-app databases.
  //
  // Not backward compatibility — there is nothing to keep working — but the drop
  // ORDER makes it necessary anyway: `drop role` fails `2BP01 role cannot be
  // dropped because some objects depend on it` while the role still owns a schema,
  // so an older app's delete was blocked by it. The database drop above no-ops for
  // such an app, the role drop then threw, and `delete.ts` turns a failed
  // deprovision into a 503 — so the agent could not be deleted at all.
  //
  // `if exists`, so it is a real no-op for every app provisioned since.
  await sql(`drop schema if exists "${id}" cascade`);
  await sql(`drop role if exists "${id}"`);
}

// ── Bound manager ────────────────────────────────────────────────────────────

/**
 * The app-database surface handlers and the sandbox resolver consume,
 * pre-bound to the platform's admin connection. Absent from the server
 * bindings when `SUPABASE_DB_URL` is unconfigured (storage routes 503).
 */
export type AppDatabases = {
  provision(slug: string): Promise<AppDbMeta>;
  /**
   * Drop one app's database and role.
   *
   * **Pass the stored `app-db:<slug>` meta whenever the caller has it.** Its
   * `url` is the app's LOCATOR, and it is the only thing that survives a
   * change to the cluster list: placement is `hash(slug) % targets.length`,
   * so adding or removing an `APP_DB_URLS` entry re-shuffles every existing
   * app. Recomputing the placement here — which this used to do, reasoned as
   * "same deterministic placement, so no locator lookup is needed" — then
   * issues both drops against a cluster that never hosted the app, where
   * `if exists` makes them silent no-ops. The caller deletes the secret
   * immediately afterwards, so the real database survives with its only
   * credential gone: tenant data, unreachable, and nothing errored.
   *
   * With no meta the app's cluster is genuinely unknown (a secret already
   * swept, a partial earlier failure), so every configured cluster is
   * swept. The identifier is slug-derived and unique, so a drop on a
   * cluster that never hosted this app is a real no-op — strictly safer
   * than guessing one.
   */
  deprovision(slug: string, meta?: AppDbMeta | null): Promise<void>;
  /**
   * The app's own connection URL (its scoped role's credentials against its own
   * database on the cluster it lives on) — delivered to the guest as
   * `DATABASE_URL`.
   */
  connectionUrl(meta: AppDbMeta): string;
  /**
   * Tables / rows / bytes in the app's database, on the cluster its own meta
   * locates (never a recomputed placement — same rule as `deprovision`).
   *
   * Opens a connection INTO that database, because `information_schema` is
   * per-database. Closed before returning.
   */
  usage(slug: string, meta: AppDbMeta): Promise<AppDbUsage>;
  /**
   * Run `fn` on a connection into one app's database, as the ADMIN role.
   *
   * The platform's only way to read a tenant's own tables now that they are not
   * reachable from the admin connection — the wake sweep's hint read and the
   * session-state sweep both go through it. The connection is closed when `fn`
   * settles, so a caller must not retain the executor.
   */
  withAppDb<T>(meta: AppDbMeta, fn: (sql: SqlExec) => Promise<T>): Promise<T>;
};

/** One placement target: a cluster's admin URL plus an executor over it. */
export type AppDbTarget = { url: string; sql: SqlExec };

/** Deterministic placement: hash the slug across the configured clusters. */
export function pickAppDbTarget(targets: AppDbTarget[], slug: string): AppDbTarget {
  const index = Number.parseInt(hash("sha256", slug).slice(16, 24), 16) % targets.length;
  return targets[index] as AppDbTarget;
}

export function createAppDatabases(opts: {
  url: string;
  sql: SqlExec;
  /** Opens a short-lived connection to an arbitrary database on any cluster. */
  open: AppDbOpener;
  /**
   * Supavisor's host, in SESSION mode — every app-database connection is routed
   * through it. See {@link withPoolerHost} for why that is what keeps per-app
   * databases out of `MAX_PLATFORM_DB_CONNECTIONS`, and why 6543 is not an option.
   */
  poolerUrl?: string | undefined;
  /** Additional placement clusters (cellular sharding); primary is always a target. */
  extraTargets?: AppDbTarget[];
}): AppDatabases {
  const targets: AppDbTarget[] = [{ url: opts.url, sql: opts.sql }, ...(opts.extraTargets ?? [])];
  const targetFor = (url: string | undefined): AppDbTarget =>
    targets.find((t) => t.url === url) ?? (targets[0] as AppDbTarget);
  const withAppDb = async <T>(meta: AppDbMeta, fn: (sql: SqlExec) => Promise<T>): Promise<T> => {
    const db = opts.open(appDbAdminUrl(meta, targetFor(meta.url).url, opts.poolerUrl));
    try {
      return await fn(db.query);
    } finally {
      await db.close();
    }
  };
  return {
    provision: (slug) => {
      const target = pickAppDbTarget(targets, slug);
      return provisionAppDatabase(target.sql, slug, target.url, opts.open);
    },
    // Deprovision on the cluster the app's own locator names — never on a
    // recomputed placement (see the doc on AppDatabases.deprovision).
    deprovision: async (slug, meta) => {
      if (meta?.url) {
        await deprovisionAppDatabase(targetFor(meta.url).sql, slug);
        return;
      }
      // Unknown locator: sweep every cluster rather than guess one. Each drop
      // is attempted even after an earlier one fails — one unreachable
      // cluster must not leave the others provisioned — and the first failure
      // is reported once they all have been.
      let failure: unknown;
      for (const target of targets) {
        try {
          await deprovisionAppDatabase(target.sql, slug);
        } catch (err) {
          failure ??= err;
        }
      }
      if (failure !== undefined) throw failure;
    },
    connectionUrl: (meta) => appDbUrlFor(meta, targetFor(meta.url).url, opts.poolerUrl),
    usage: (_slug, meta) => withAppDb(meta, appDatabaseUsage),
    withAppDb,
  };
}

/** Parse a stored `app-db:<slug>` secret value. Returns null on any mismatch. */
export function parseAppDbMeta(raw: string | null): AppDbMeta | null {
  if (raw === null) return null;
  const value = safeJsonParse(raw) as Partial<AppDbMeta> | null | undefined;
  if (value && typeof value.role === "string" && typeof value.password === "string") {
    return {
      role: value.role,
      password: value.password,
      ...(typeof value.url === "string" && { url: value.url }),
    };
  }
  return null;
}
