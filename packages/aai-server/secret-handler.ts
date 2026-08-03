// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP handlers for managing agent secrets (environment variables).
 *
 * Secrets are per-agent key/value pairs held in the injected SecretStore
 * (Supabase Vault in production, which encrypts at rest — no app-layer
 * encryption). They are delivered to the guest sandbox via the
 * `bundle/load` RPC params
 * (see sandbox-vm.ts), never as host process environment variables.
 *
 * A secret change takes effect on the NEXT DEPLOY (or sandbox rebuild) by
 * design: nothing here restarts resident sandboxes or signals other
 * replicas. That trade removed the whole cross-replica secret-invalidation
 * mechanism; redeploying is the documented way to apply a change now.
 *
 * Related but distinct: `secrets.ts` handles API key hashing and
 * ownership verification for platform auth — not agent secrets.
 */

import { HTTPException } from "hono/http-exception";
import type { AppContext, ValidatedAppContext, ValidatedParamContext } from "./context.ts";

export async function handleSecretList(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const env = await c.env.store.getEnv(slug);
  if (!env) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }
  return c.json({ vars: Object.keys(env) });
}

export function handleSecretSet(c: ValidatedAppContext<Record<string, string>>): Promise<Response> {
  const slug = c.var.slug;
  return c.env.slugLock(slug, async () => {
    const updates = c.req.valid("json");

    const existing = (await c.env.store.getEnv(slug)) ?? {};
    const merged = { ...existing, ...updates };
    await c.env.store.putEnv(slug, merged);

    console.info("Secret updated", { slug, keyCount: Object.keys(updates).length });
    return c.json({ ok: true, keys: Object.keys(merged) });
  });
}

// The `:key` param is validated at the route layer (zValidator("param") in
// orchestrator.ts), the same altitude as the sibling routes' body schemas.
export function handleSecretDelete(c: ValidatedParamContext<{ key: string }>): Promise<Response> {
  const slug = c.var.slug;
  return c.env.slugLock(slug, async () => {
    const { key } = c.req.valid("param");
    const existing = await c.env.store.getEnv(slug);
    if (!existing) {
      throw new HTTPException(404, { message: `Agent ${slug} not found` });
    }
    delete existing[key];
    await c.env.store.putEnv(slug, existing);
    console.info("Secret deleted", { slug });
    return c.json({ ok: true });
  });
}
