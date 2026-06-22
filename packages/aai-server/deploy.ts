// Copyright 2025 the AAI authors. MIT license.

import { humanId } from "human-id";
import { debug } from "./_debug-log.ts";
import type { ValidatedAppContext } from "./context.ts";
import { setSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import type { DeployBody } from "./schemas.ts";
import { EnvSchema } from "./schemas.ts";
import { verifyApiKeyHash } from "./secrets.ts";

export function handleDeploy(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, () => handleDeployInner(c, slug));
}

export function handleDeployNew(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const body = c.req.valid("json");
  const slug = body.slug ?? humanId({ separator: "-", capitalize: false });
  return withSlugLock(slug, async () => {
    if (body.slug) {
      const existing = await c.env.store.getManifest(slug);
      if (existing && !(await matchesAnyHash(c.var.apiKey, existing.credential_hashes))) {
        return c.json({ error: "Forbidden: slug already owned by another user" }, 403);
      }
    }
    return handleDeployInner(c, slug);
  });
}

async function matchesAnyHash(apiKey: string, hashes: string[]): Promise<boolean> {
  for (const h of hashes) {
    if (await verifyApiKeyHash(apiKey, h)) return true;
  }
  return false;
}

async function handleDeployInner(
  c: ValidatedAppContext<DeployBody>,
  slug: string,
): Promise<Response> {
  const { apiKey, keyHash } = c.var;
  const body = c.req.valid("json");

  const [storedEnv, existingManifest] = await Promise.all([
    c.env.store.getEnv(slug),
    c.env.store.getManifest(slug),
  ]);
  const env = body.env ? { ...(storedEnv ?? {}), ...body.env } : (storedEnv ?? {});

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return c.json({ error: `Invalid platform config: ${envParsed.error.message}` }, 400);
  }

  const existingSlot = c.env.slots.get(slug);
  if (existingSlot?.sandbox) {
    debug("Replacing existing deploy", { slug });
    await terminateSlot(existingSlot);
  }

  // Preserve multi-user ownership: append the deployer's hash only when no
  // stored hash already matches their key.
  const existingHashes = existingManifest?.credential_hashes ?? [];
  const alreadyStored =
    existingHashes.includes(keyHash) || (await matchesAnyHash(apiKey, existingHashes));
  const mergedHashes = alreadyStored ? existingHashes : [...existingHashes, keyHash];

  await c.env.store.putAgent({
    slug,
    env,
    worker: body.worker,
    clientFiles: body.clientFiles,
    credential_hashes: mergedHashes,
    agentConfig: body.agentConfig,
  });

  setSlot(c.env.slots, { slug, keyHash });

  debug("Deploy received", { slug });

  return c.json({ ok: true, slug, message: `Deployed ${slug}` });
}
