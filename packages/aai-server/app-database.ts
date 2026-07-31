// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-app databases ("storage"): each app that enables storage gets its own
 * Postgres schema plus a matching LOGIN role inside the platform's Supabase
 * database (`SUPABASE_DB_URL`). Tool code reaches it as `ctx.db`, proxied
 * through the sandbox's `db/query` RPC — the guest never holds credentials.
 *
 * Identifiers are `app_` + the first 16 hex chars of sha256(slug), so they
 * are always `[a-z0-9_]` and safe to interpolate into DDL after the shape
 * assertion below. The role's password is crypto-random 32-hex, likewise
 * shape-asserted before it is quoted into `create/alter role`.
 */

import { hash, randomBytes } from "node:crypto";
import { type CloseableDb, createPostgresDb } from "@alexkroman1/aai/runtime";
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

/** Max pooled connections per app db handle — one sandbox, light duty. */
const APP_DB_POOL_MAX = 2;

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

  // One multi-statement batch (no bind params — identifiers/password are
  // shape-asserted above): DDL cannot take placeholders, and a single round
  // trip replaces what used to be ~6 sequential ones. The `do $$` block is
  // the create-or-alter branch for the role.
  await sql(
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
  );

  return { role: id, password, url: targetUrl };
}

/** Drop one app's schema (with all its data) and its role. Idempotent. */
export async function deprovisionAppDatabase(sql: SqlExec, slug: string): Promise<void> {
  const id = assertIdentifier(appDbIdentifier(slug));
  await sql(`drop schema if exists "${id}" cascade`);
  await sql(`drop role if exists "${id}"`);
}

/**
 * Open a `Db` handle for one provisioned app: the admin URL's host/port/
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

export function openAppDb(meta: AppDbMeta, fallbackAdminUrl: string): CloseableDb {
  // The stored locator wins; rows predating it live on the primary cluster.
  const adminUrl = meta.url ?? fallbackAdminUrl;
  return createPostgresDb({ url: appDbConnectionUrl(meta, adminUrl), max: APP_DB_POOL_MAX });
}

// ── Bound manager ────────────────────────────────────────────────────────────

/**
 * The app-database surface handlers and the sandbox resolver consume,
 * pre-bound to the platform's admin connection. Absent from the server
 * bindings when `SUPABASE_DB_URL` is unconfigured (storage routes 503).
 */
export type AppDatabases = {
  provision(slug: string): Promise<AppDbMeta>;
  deprovision(slug: string): Promise<void>;
  open(meta: AppDbMeta): CloseableDb;
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
    // Deprovision on the cluster that hosts the app: same deterministic
    // placement, so no locator lookup is needed for the DDL executor.
    deprovision: (slug) => deprovisionAppDatabase(pickAppDbTarget(targets, slug).sql, slug),
    open: (meta) => openAppDb(meta, targetFor(meta.url).url),
  };
}

/** Parse a stored `app-db:<slug>` secret value. Returns null on any mismatch. */
export function parseAppDbMeta(raw: string | null): AppDbMeta | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<AppDbMeta> | null;
    if (value && typeof value.role === "string" && typeof value.password === "string") {
      return {
        role: value.role,
        password: value.password,
        ...(typeof value.url === "string" && { url: value.url }),
      };
    }
  } catch {
    // fall through
  }
  return null;
}
