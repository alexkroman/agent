// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-app databases ("storage"): each app that enables storage gets its own
 * Postgres schema plus a matching LOGIN role inside the platform's Supabase
 * database (`SUPABASE_DB_URL`). Tool code reaches it as `ctx.db`: the app's
 * OWN scoped credentials (role/search_path pinned at provisioning) are
 * handed to the guest as `DATABASE_URL` in its boot env, and the bundle's
 * runtime connects directly — exactly as `aai dev` does with a project
 * `.env`. Platform ADMIN credentials never enter the guest; the app role
 * reaches only its own schema, which the tenant's code could read anyway.
 *
 * Identifiers are `app_` + the first 16 hex chars of sha256(slug), so they
 * are always `[a-z0-9_]` and safe to interpolate into DDL after the shape
 * assertion below. The role's password is crypto-random 32-hex, likewise
 * shape-asserted before it is quoted into `create/alter role`.
 */

import { hash, randomBytes } from "node:crypto";
import { safeJsonParse } from "@alexkroman1/aai";
import { sessionStateDdl } from "@alexkroman1/aai/runtime";
import type { SqlExec } from "./secret-store.ts";

/**
 * Provisioned credentials for one app's database, stored as `app-db:<slug>`.
 * The role name doubles as the schema name (one `app_<hex>` identifier).
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

const IDENTIFIER_RE = /^app_[a-f0-9]{16}$/;

/**
 * Per-tenant caps so one hot app cannot starve the shared cluster: a role
 * connection ceiling (each sandbox pools APP_DB_POOL_MAX, so this allows a
 * couple of concurrent sandboxes plus a migration connection) and a bound on
 * scratch disk from pathological sorts/hash joins.
 */
const APP_DB_CONNECTION_LIMIT = 4;
const APP_DB_TEMP_FILE_LIMIT = "64MB";

/** Deterministic schema/role identifier for one app slug. */
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
 * Provision (idempotently) the schema + role for one app. Every call issues
 * a fresh random password — the caller persists the returned meta (in the
 * SecretStore under `app-db:<slug>`), so re-provisioning simply rotates it.
 */
export async function provisionAppDatabase(
  sql: SqlExec,
  slug: string,
  targetUrl: string,
): Promise<AppDbMeta> {
  const id = assertIdentifier(appDbIdentifier(slug));
  const password = randomBytes(16).toString("hex");

  // One multi-statement batch (no bind params — the identifier is
  // shape-asserted above and the password is locally generated hex): DDL
  // cannot take placeholders, and a single round trip replaces what used to
  // be ~6 sequential ones. The `do $$` block is the create-or-alter branch
  // for the role.
  //
  // Scrubbed on failure because the password is INLINED in this SQL:
  // postgres drivers attach the failing query text as an own property on
  // the thrown error, and the process safety nets (service-config.ts)
  // console.error whole error objects — so an unscrubbed provisioning
  // failure would put a live per-app password into platform logs.
  const failure = await sql(
    `create schema if not exists "${id}";
do $$
begin
  if exists (select 1 from pg_roles where rolname = '${id}') then
    alter role "${id}" with login password '${password}' connection limit ${APP_DB_CONNECTION_LIMIT};
  else
    create role "${id}" with login password '${password}' connection limit ${APP_DB_CONNECTION_LIMIT};
  end if;
end
$$;
grant usage, create on schema "${id}" to "${id}";
alter role "${id}" set search_path = "${id}";
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

  await ensureSessionTables(sql, id);
  return { role: id, password, url: targetUrl };
}

/**
 * Create the session-state tables in an app's schema.
 *
 * **Part of what "this app has a database" MEANS**, alongside its role and its
 * grants — so it belongs where the schema is created rather than in the guest
 * that later queries it. The DDL itself is the SDK's (`sessionStateDdl`), applied
 * here rather than known here: one source of truth for a shape both ends derive
 * from, which is the same rule `SESSION_STATE_TABLE` already follows.
 *
 * SEPARATE from the provisioning batch above rather than folded into it: that
 * batch is one multi-statement string built around an interpolated password, and
 * `scrubSecret` exists because a failure in it must never reach a log with the
 * credential attached. These statements carry no secret and no interpolation
 * beyond the schema identifier, so keeping them out of that blast radius costs
 * two round trips on a route called once per app.
 *
 * The invariant it buys: **a provisioned app schema has its tables.** There is no
 * second path, because there is nothing to be backward compatible with — an app
 * enabled before this moved out of the guest already HAS its tables, created by
 * the guest that used to do it.
 *
 * Qualified with the app's own schema: this runs on the platform ADMIN
 * connection, whose `search_path` is pinned nowhere (the app's own role is, which
 * is why the guest never needed to qualify).
 */
async function ensureSessionTables(sql: SqlExec, schema: string): Promise<void> {
  for (const statement of sessionStateDdl(assertIdentifier(schema))) {
    await sql(statement);
  }
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

/** What one app's schema holds right now. */
export type AppDbUsage = {
  tables: number;
  /** Summed across every table in the schema. */
  rows: number;
  /** Bytes, including indexes and TOAST (`pg_total_relation_size`). */
  bytes: number;
};

/**
 * How much is actually in one app's database.
 *
 * **Row counts are EXACT, not `reltuples`.** The planner's estimate is the
 * usual answer to "how big is this table", and it is the wrong one here: it
 * is `-1` until the first `ANALYZE` and stale after every write until
 * autovacuum catches up — so a freshly written row reads as zero, which is
 * precisely the question this exists to answer ("is my agent saving
 * anything?"). Counting is affordable because these are per-agent schemas
 * holding a tool's state, and the count is bounded regardless: it runs on the
 * platform's admin connection with a statement timeout, and a schema is
 * skipped rather than failing the read (see the caller).
 *
 * One statement rather than one per table: `query_to_xml` runs the count for
 * each table inside the same round trip, which is the standard trick for
 * exact counts across a schema and keeps this off the N+1 path.
 */
export async function appDatabaseUsage(sql: SqlExec, slug: string): Promise<AppDbUsage> {
  const id = assertIdentifier(appDbIdentifier(slug));
  const rows = await sql(
    `select
       count(*)::int8 as tables,
       coalesce(sum((xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                      false, true, '')))[1]::text::int8), 0) as rows,
       coalesce(sum(pg_total_relation_size(format('%I.%I', table_schema, table_name)::regclass)), 0)
         as bytes
     from information_schema.tables
     where table_schema = $1 and table_type = 'BASE TABLE'`,
    [id],
  );
  const row = rows[0] ?? {};
  // Postgres returns int8 as a string in most drivers; Number is safe at
  // these magnitudes and a NaN would be a lie, so it degrades to 0.
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return { tables: num(row.tables), rows: num(row.rows), bytes: num(row.bytes) };
}

/** Drop one app's schema (with all its data) and its role. Idempotent. */
export async function deprovisionAppDatabase(sql: SqlExec, slug: string): Promise<void> {
  const id = assertIdentifier(appDbIdentifier(slug));
  await sql(`drop schema if exists "${id}" cascade`);
  await sql(`drop role if exists "${id}"`);
}

/**
 * The connection URL for one provisioned app: the admin URL's host/port/
 * database with the app role's own credentials. The role's `search_path`
 * pins queries to the app schema; `statement_timeout` bounds runaway SQL.
 *
 * When the admin URL goes through Supabase's pooler (Supavisor), its
 * username carries the tenant as a suffix — `postgres.<project-ref>` — and
 * every connection MUST repeat that suffix or the pooler rejects it with
 * "(ENOIDENTIFIER) no tenant identifier provided". The pooler hostname is
 * shared across projects, so SNI cannot identify the tenant; the username
 * is the only channel. Carry the admin suffix onto the app role.
 */
export function appDbConnectionUrl(meta: AppDbMeta, adminUrl: string): string {
  const url = new URL(adminUrl);
  const adminUser = decodeURIComponent(url.username);
  const tenantSuffix = adminUser.includes(".") ? adminUser.slice(adminUser.indexOf(".")) : "";
  url.username = encodeURIComponent(meta.role + tenantSuffix);
  url.password = encodeURIComponent(meta.password);
  return url.toString();
}

export function appDbUrlFor(meta: AppDbMeta, fallbackAdminUrl: string): string {
  // The stored locator wins; rows predating it live on the primary cluster.
  return appDbConnectionUrl(meta, meta.url ?? fallbackAdminUrl);
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
   * Drop one app's schema and role.
   *
   * **Pass the stored `app-db:<slug>` meta whenever the caller has it.** Its
   * `url` is the app's LOCATOR, and it is the only thing that survives a
   * change to the cluster list: placement is `hash(slug) % targets.length`,
   * so adding or removing an `APP_DB_URLS` entry re-shuffles every existing
   * app. Recomputing the placement here — which this used to do, reasoned as
   * "same deterministic placement, so no locator lookup is needed" — then
   * issues both drops against a cluster that never hosted the app, where
   * `if exists` makes them silent no-ops. The caller deletes the secret
   * immediately afterwards, so the real schema survives with its only
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
   * The app's own connection URL (its scoped role's credentials against the
   * cluster the app lives on) — delivered to the guest as `DATABASE_URL`.
   */
  connectionUrl(meta: AppDbMeta): string;
  /**
   * Tables / rows / bytes in the app's schema, on the cluster its own meta
   * locates (never a recomputed placement — same rule as `deprovision`).
   */
  usage(slug: string, meta: AppDbMeta): Promise<AppDbUsage>;
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
  /** Additional placement clusters (cellular sharding); primary is always a target. */
  extraTargets?: AppDbTarget[];
}): AppDatabases {
  const targets: AppDbTarget[] = [{ url: opts.url, sql: opts.sql }, ...(opts.extraTargets ?? [])];
  const targetFor = (url: string | undefined): AppDbTarget =>
    targets.find((t) => t.url === url) ?? (targets[0] as AppDbTarget);
  return {
    provision: (slug) => {
      const target = pickAppDbTarget(targets, slug);
      return provisionAppDatabase(target.sql, slug, target.url);
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
    connectionUrl: (meta) => appDbUrlFor(meta, targetFor(meta.url).url),
    usage: (slug, meta) => appDatabaseUsage(targetFor(meta.url).sql, slug),
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
