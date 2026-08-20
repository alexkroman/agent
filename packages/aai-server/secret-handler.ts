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
import { createLogger } from "./logger.ts";
import type { SlugMutationLock } from "./platform-lock.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("secrets");

/**
 * What a secret mutation needs, independent of HTTP.
 *
 * The three cores below take this rather than a request Context so the
 * studio's PROJECT-level routes can drive the same operations across a
 * project's two agents (production and preview) — see `studio-secrets.ts`.
 * Two implementations of "merge these updates into the stored env" is how
 * the two paths came to disagree about which agents a secret reaches.
 */
export type SecretEnv = {
  store: BundleStore;
  slugLock: SlugMutationLock;
};

/** The names of a slug's stored secrets (values never leave the platform). */
export async function listSlugSecrets(env: SecretEnv, slug: string): Promise<string[]> {
  return Object.keys((await env.store.getEnv(slug)) ?? {});
}

/** Merge `updates` into a slug's stored env. Returns every name it then holds. */
export function setSlugSecrets(
  env: SecretEnv,
  slug: string,
  updates: Record<string, string>,
): Promise<string[]> {
  return env.slugLock(slug, async () => {
    const existing = (await env.store.getEnv(slug)) ?? {};
    const merged = { ...existing, ...updates };
    await env.store.putEnv(slug, merged);
    log.info("updated", { slug, keyCount: Object.keys(updates).length });
    return Object.keys(merged);
  });
}

/** Drop one name from a slug's stored env. Absent is a no-op, not an error. */
export function deleteSlugSecret(env: SecretEnv, slug: string, key: string): Promise<void> {
  return env.slugLock(slug, async () => {
    const existing = (await env.store.getEnv(slug)) ?? {};
    delete existing[key];
    await env.store.putEnv(slug, existing);
    log.info("deleted", { slug });
  });
}

// Agent existence is existingOwnerMw's decision (it rejects unclaimed slugs
// before any handler runs), so a null env row here just means "no secrets
// stored yet" and every handler treats it as an empty record — three routes
// used to disagree on what a missing row meant.

export async function handleSecretList(c: AppContext): Promise<Response> {
  return c.json({ vars: await listSlugSecrets(c.env, c.var.slug) });
}

export async function handleSecretSet(
  c: ValidatedAppContext<Record<string, string>>,
): Promise<Response> {
  const keys = await setSlugSecrets(c.env, c.var.slug, c.req.valid("json"));
  return c.json({ ok: true, keys });
}

// The `:key` param is validated at the route layer (zValidator("param") in
// orchestrator.ts), the same altitude as the sibling routes' body schemas.
export async function handleSecretDelete(
  c: ValidatedParamContext<{ key: string }>,
): Promise<Response> {
  await deleteSlugSecret(c.env, c.var.slug, c.req.valid("param").key);
  return c.json({ ok: true });
}
