// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP handlers for managing agent secrets (environment variables).
 *
 * Secrets are per-agent key/value pairs stored encrypted in the BundleStore.
 * They are forwarded to the guest sandbox as `AAI_ENV_*` environment variables.
 *
 * Related but distinct: `credential-store.ts` handles API key hashing and
 * ownership verification for platform auth — not agent secrets.
 */

import { HTTPException } from "hono/http-exception";
import { debug } from "./_debug-log.ts";
import type { AppContext, ValidatedAppContext } from "./context.ts";
import { terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import { SecretKeySchema } from "./schemas.ts";

async function restartSandbox(c: AppContext, slug: string, reason: string): Promise<void> {
  const slot = c.env.slots.get(slug);
  if (slot?.sandbox) {
    debug(`Restarting sandbox for ${reason}`, { slug });
    await terminateSlot(slot);
  }
}

async function getEnvOr404(c: AppContext, slug: string): Promise<Record<string, string>> {
  const env = await c.env.store.getEnv(slug);
  if (!env) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }
  return env;
}

export async function handleSecretList(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const env = await getEnvOr404(c, slug);
  return c.json({ vars: Object.keys(env) });
}

export function handleSecretSet(c: ValidatedAppContext<Record<string, string>>): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, async () => {
    const updates = c.req.valid("json");

    const existing = (await c.env.store.getEnv(slug)) ?? {};
    const merged = { ...existing, ...updates };
    await c.env.store.putEnv(slug, merged);

    await restartSandbox(c, slug, "secret update");
    debug("Secret updated", { slug, keyCount: Object.keys(updates).length });
    return c.json({ ok: true, keys: Object.keys(merged) });
  });
}

export function handleSecretDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, async () => {
    // biome-ignore lint/style/noNonNullAssertion: key param guaranteed by route
    const key = c.req.param("key")!;
    if (!SecretKeySchema.safeParse(key).success) {
      throw new HTTPException(400, { message: "Invalid secret key name" });
    }
    const existing = await getEnvOr404(c, slug);
    delete existing[key];
    await c.env.store.putEnv(slug, existing);
    await restartSandbox(c, slug, "secret delete");
    debug("Secret deleted", { slug });
    return c.json({ ok: true });
  });
}
