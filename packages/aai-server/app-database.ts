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

import { createHash, randomBytes } from "node:crypto";
import { type CloseableDb, createPostgresDb } from "@alexkroman1/aai/runtime";
import type { SqlExec } from "./secret-store.ts";

/** Provisioned credentials for one app's database, stored as `app-db:<slug>`. */
export type AppDbMeta = {
  schema: string;
  role: string;
  password: string;
};

/** Max pooled connections per app db handle — one sandbox, light duty. */
const APP_DB_POOL_MAX = 2;

const IDENTIFIER_RE = /^app_[a-f0-9]{16}$/;
const PASSWORD_RE = /^[a-f0-9]{32}$/;

/** Deterministic schema/role identifier for one app slug. */
export function appDbIdentifier(slug: string): string {
  return `app_${createHash("sha256").update(slug).digest("hex").slice(0, 16)}`;
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
export async function provisionAppDatabase(sql: SqlExec, slug: string): Promise<AppDbMeta> {
  const id = assertIdentifier(appDbIdentifier(slug));
  const password = randomBytes(16).toString("hex");
  if (!PASSWORD_RE.test(password)) throw new Error("Invalid generated password");

  // One multi-statement batch (no bind params — identifiers/password are
  // shape-asserted above): DDL cannot take placeholders, and a single round
  // trip replaces what used to be ~6 sequential ones. The `do $$` block is
  // the create-or-alter branch for the role.
  await sql(
    `create schema if not exists "${id}";
do $$
begin
  if exists (select 1 from pg_roles where rolname = '${id}') then
    alter role "${id}" with login password '${password}';
  else
    create role "${id}" with login password '${password}';
  end if;
end
$$;
grant usage, create on schema "${id}" to "${id}";
alter role "${id}" set search_path = "${id}";
alter role "${id}" set statement_timeout = '10s'`,
  );

  return { schema: id, role: id, password };
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
 */
export function openAppDb(meta: AppDbMeta, adminUrl: string): CloseableDb {
  const url = new URL(adminUrl);
  url.username = encodeURIComponent(meta.role);
  url.password = encodeURIComponent(meta.password);
  return createPostgresDb({ url: url.toString(), max: APP_DB_POOL_MAX });
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

export function createAppDatabases(opts: { url: string; sql: SqlExec }): AppDatabases {
  return {
    provision: (slug) => provisionAppDatabase(opts.sql, slug),
    deprovision: (slug) => deprovisionAppDatabase(opts.sql, slug),
    open: (meta) => openAppDb(meta, opts.url),
  };
}

/** Parse a stored `app-db:<slug>` secret value. Returns null on any mismatch. */
export function parseAppDbMeta(raw: string | null): AppDbMeta | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<AppDbMeta> | null;
    if (
      value &&
      typeof value.schema === "string" &&
      typeof value.role === "string" &&
      typeof value.password === "string"
    ) {
      return { schema: value.schema, role: value.role, password: value.password };
    }
  } catch {
    // fall through
  }
  return null;
}
