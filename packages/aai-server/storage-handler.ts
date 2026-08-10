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
import type { AppContext } from "./context.ts";
import type { SlugMutationLock } from "./platform-lock.ts";
import { appDbSecretName, type SecretStore } from "./secret-store.ts";

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
  return appDb.usage(slug, meta).catch((err: unknown) => {
    console.warn("App database usage read failed", { slug, error: String(err) });
    return null;
  });
}

/** Provision + persist credentials. Idempotent. */
export function enableStorage(env: StorageEnv, slug: string): Promise<{ enabled: true }> {
  const appDb = env.appDb;
  if (!appDb) throw new HTTPException(503, { message: UNCONFIGURED_MESSAGE });
  return env.slugLock(slug, async () => {
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
