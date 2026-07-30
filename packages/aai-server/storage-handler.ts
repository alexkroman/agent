// Copyright 2026 the AAI authors. MIT license.
/**
 * HTTP handlers for per-app database storage ("storage").
 *
 * Enabling storage provisions a dedicated Postgres schema + role in the
 * platform's Supabase database (see app-database.ts), stores the credentials
 * in the SecretStore under `app-db:<slug>`, and restarts the agent's sandbox
 * so the next session picks up `ctx.db`. Disabling drops the schema (with
 * all its data) and the role.
 *
 * Owner-authenticated exactly like the secret routes. The studio's
 * `/studio/projects/:project/storage` routes delegate to the same core
 * functions against the project's published slug.
 */

import { HTTPException } from "hono/http-exception";
import type { AppDatabases } from "./app-database.ts";
import { appDbSecretName } from "./bundle-store.ts";
import type { AppContext } from "./context.ts";
import { type SlotCache, terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import type { SecretStore } from "./secret-store.ts";

/** What the storage core needs from the server bindings. */
export type StorageEnv = {
  slots: SlotCache;
  secrets: SecretStore;
  appDb?: AppDatabases | undefined;
};

const UNCONFIGURED_MESSAGE =
  "Storage is not configured on this server (SUPABASE_DB_URL is not set)";

async function restartSandbox(env: StorageEnv, slug: string, reason: string): Promise<void> {
  const slot = env.slots.get(slug);
  if (slot?.sandbox) {
    console.info(`Restarting sandbox for ${reason}`, { slug });
    await terminateSlot(slot);
  }
}

/** Is storage enabled (credentials provisioned) for this app? */
export async function storageStatus(env: StorageEnv, slug: string): Promise<{ enabled: boolean }> {
  const meta = await env.secrets.get(appDbSecretName(slug));
  return { enabled: meta !== null };
}

/** Provision + persist credentials + restart the sandbox. Idempotent. */
export function enableStorage(env: StorageEnv, slug: string): Promise<{ enabled: true }> {
  const appDb = env.appDb;
  if (!appDb) throw new HTTPException(503, { message: UNCONFIGURED_MESSAGE });
  return withSlugLock(slug, async () => {
    const meta = await appDb.provision(slug);
    await env.secrets.put(appDbSecretName(slug), JSON.stringify(meta));
    await restartSandbox(env, slug, "storage enable");
    console.info("Storage enabled", { slug, schema: meta.schema });
    return { enabled: true as const };
  });
}

/** Deprovision (drops the schema and its data) + delete credentials + restart. */
export function disableStorage(env: StorageEnv, slug: string): Promise<{ enabled: false }> {
  const appDb = env.appDb;
  if (!appDb) throw new HTTPException(503, { message: UNCONFIGURED_MESSAGE });
  return withSlugLock(slug, async () => {
    await appDb.deprovision(slug);
    await env.secrets.delete(appDbSecretName(slug));
    await restartSandbox(env, slug, "storage disable");
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
