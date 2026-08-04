// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP handlers for managing agent secrets (environment variables).
 *
 * Secrets are per-agent key/value pairs held in the injected SecretStore
 * (Supabase Vault in production, which encrypts at rest — no app-layer
 * encryption). They are delivered to the guest sandbox via the
 * agent boot env
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

import type { AppContext, ValidatedAppContext, ValidatedParamContext } from "./context.ts";

// Agent existence is existingOwnerMw's decision (it rejects unclaimed slugs
// before any handler runs), so a null env row here just means "no secrets
// stored yet" and every handler treats it as an empty record — three routes
// used to disagree on what a missing row meant.

export async function handleSecretList(c: AppContext): Promise<Response> {
  const env = (await c.env.store.getEnv(c.var.slug)) ?? {};
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
    const existing = (await c.env.store.getEnv(slug)) ?? {};
    delete existing[key];
    await c.env.store.putEnv(slug, existing);
    console.info("Secret deleted", { slug });
    return c.json({ ok: true });
  });
}
