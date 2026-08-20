// Copyright 2026 the AAI authors. MIT license.
/**
 * HTTP handlers for per-app database storage ("storage").
 *
 * Enabling storage provisions a dedicated Postgres schema + role in the
 * platform's Supabase database (see app-database.ts) and stores the
 * credentials in the SecretStore under `app-db:<slug>`. Disabling drops the
 * schema (with all its data) and the role. Like secret changes, the toggle
 * takes effect on the next deploy (or sandbox rebuild) — nothing here
 * restarts resident sandboxes.
 *
 * Owner-authenticated exactly like the secret routes, which serve
 * `aai storage enable`. The studio's Settings pane switches a database on per
 * PROJECT rather than per slug — a project is two deployed agents (production
 * and preview) — so it calls the CORE functions below directly through
 * aai-studio-server/studio-database.ts; the Hono handlers stay the CLI's
 * per-slug surface.
 */

import { HTTPException } from "hono/http-exception";
import { type AppDatabases, type AppDbUsage, parseAppDbMeta } from "./app-database.ts";
import {
  type AppTable,
  type AppTablePage,
  listAppTables,
  type ReadAppTableParams,
  readAppTable,
} from "./app-db-browse.ts";
import type { AppContext } from "./context.ts";
import type { SlugMutationLock } from "./platform-lock.ts";
import { appDbSecretName, type SecretStore, type SqlExec } from "./secret-store.ts";

/** What the storage core needs from the server bindings. */
export type StorageEnv = {
  secrets: SecretStore;
  appDb?: AppDatabases | undefined;
  slugLock: SlugMutationLock;
};

const UNCONFIGURED_MESSAGE =
  "Storage is not configured on this server (SUPABASE_DB_URL is not set)";

/** Is storage enabled (credentials provisioned) for this app? */
export async function storageStatus(env: StorageEnv, slug: string): Promise<{ enabled: boolean }> {
  const meta = await env.secrets.get(appDbSecretName(slug));
  return { enabled: meta !== null };
}

/**
 * What the app's database holds — tables, rows, bytes — or null when it has
 * none, when this server cannot provision at all, or when the read failed.
 *
 * **A failed read is `null`, never a thrown request.** This is an observation
 * about a tenant schema on a shared cluster, offered beside a switch whose
 * own state is already known; a cluster hiccup must degrade the number, not
 * the pane that reports whether the database is on.
 */
export async function storageUsage(env: StorageEnv, slug: string): Promise<AppDbUsage | null> {
  const appDb = env.appDb;
  if (!appDb) return null;
  const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
  if (!meta) return null;
  // `usage` rather than `withAppDatabase` below: it opens the connection on the
  // cluster the META locates, which is the same rule `deprovision` states — a
  // recomputed placement points at a cluster that never hosted this app.
  return appDb.usage(slug, meta).catch((err: unknown) => {
    console.warn("App database usage read failed", { slug, error: String(err) });
    return null;
  });
}

/**
 * Run `fn` on a connection into one app's database, or answer `null` when
 * there is no database to open (storage off, or this server cannot provision).
 *
 * The one place the `app-db:<slug>` secret is turned into a live executor for
 * an arbitrary READ: is there an `appDb`, is there a stored meta, open, close —
 * and the last is the one a caller forgets. `withAppDb` locates the cluster
 * from the meta, which is the placement rule `deprovision` documents.
 */
async function withAppDatabase<T>(
  env: StorageEnv,
  slug: string,
  fn: (sql: SqlExec) => Promise<T>,
): Promise<T | null> {
  const appDb = env.appDb;
  if (!appDb) return null;
  const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
  if (!meta) return null;
  return appDb.withAppDb(meta, fn);
}

/**
 * The app's tables, or `null` when it has no database.
 *
 * A failed read THROWS here, unlike {@link storageUsage}, and the difference is
 * what the caller is showing. Usage is a number offered beside a switch whose
 * own state is already known, so a cluster hiccup must degrade the number
 * rather than the pane. This IS the pane: an empty table list that really means
 * "the read failed" tells the author their agent has stored nothing, which is
 * the one answer a viewer must never invent.
 */
export function storageTables(env: StorageEnv, slug: string): Promise<AppTable[] | null> {
  return withAppDatabase(env, slug, listAppTables);
}

/** One page of one of the app's tables, or `null` with no database to read. */
export function storageTableRows(
  env: StorageEnv,
  slug: string,
  params: ReadAppTableParams,
): Promise<AppTablePage | null> {
  return withAppDatabase(env, slug, (sql) => readAppTable(sql, params));
}

/**
 * Provision + persist credentials. Idempotent, and idempotent is the POINT
 * rather than a nicety.
 *
 * **An already-enabled app is left alone.** `provision` mints a fresh password
 * on every call and the caller persists it, so re-provisioning ROTATES the
 * role's credentials — while the resident guest is still holding the
 * `DATABASE_URL` baked into it at spawn. `aai storage enable` run twice was
 * enough: the second call stopped the running agent's `ctx.db` from
 * authenticating, mid-session, with nothing on this side reporting anything.
 * (Secret and storage changes deliberately do not move sandboxes — see "Deploy
 * and delete are the ONLY mutations that move sandboxes" in this package's
 * guide — so there is no rebuild behind this to paper over it.)
 *
 * The check is INSIDE the slug lock, so two concurrent enables cannot both see
 * "absent" and both provision. The studio's own per-project path reads
 * `storageStatus` first for the same reason; this is the guard the per-slug
 * route was missing, and having it here means neither caller can forget it.
 */
export function enableStorage(env: StorageEnv, slug: string): Promise<{ enabled: true }> {
  const appDb = env.appDb;
  if (!appDb) throw new HTTPException(503, { message: UNCONFIGURED_MESSAGE });
  return env.slugLock(slug, async () => {
    if ((await env.secrets.get(appDbSecretName(slug))) !== null) {
      return { enabled: true as const };
    }
    const meta = await appDb.provision(slug);
    await env.secrets.put(appDbSecretName(slug), JSON.stringify(meta));
    console.info("Storage enabled", { slug, role: meta.role });
    return { enabled: true as const };
  });
}

/** Deprovision (drops the schema and its data) + delete credentials. */
export function disableStorage(env: StorageEnv, slug: string): Promise<{ enabled: false }> {
  const appDb = env.appDb;
  if (!appDb) throw new HTTPException(503, { message: UNCONFIGURED_MESSAGE });
  return env.slugLock(slug, async () => {
    // Read the locator BEFORE deleting the secret that holds it: the stored
    // `url` names the cluster this app lives on, and recomputing that
    // placement drops on the wrong one after any change to APP_DB_URLS (see
    // AppDatabases.deprovision).
    const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
    await appDb.deprovision(slug, meta);
    await env.secrets.delete(appDbSecretName(slug));
    console.info("Storage disabled", { slug });
    return { enabled: false as const };
  });
}

// ── Hono handlers (owner routes: GET/POST/DELETE /:slug/storage) ─────────────

export async function handleStorageStatus(c: AppContext): Promise<Response> {
  return c.json(await storageStatus(c.env, c.var.slug));
}

export async function handleStorageEnable(c: AppContext): Promise<Response> {
  const { enabled } = await enableStorage(c.env, c.var.slug);
  return c.json({ ok: true, enabled });
}

export async function handleStorageDisable(c: AppContext): Promise<Response> {
  const { enabled } = await disableStorage(c.env, c.var.slug);
  return c.json({ ok: true, enabled });
}
