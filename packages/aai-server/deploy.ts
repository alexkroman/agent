// Copyright 2025 the AAI authors. MIT license.

import type { ValidatedAppContext } from "./context.ts";
import { terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import type { DeployBody } from "./schemas.ts";
import { EnvSchema } from "./schemas.ts";

export function handleDeploy(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, () => handleDeployInner(c));
}

async function handleDeployInner(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const slug = c.var.slug;
  const keyHash = c.var.keyHash;

  const body = c.req.valid("json");

  const storedEnv = (await c.env.store.getEnv(slug)) ?? {};
  const env = body.env ? { ...storedEnv, ...body.env } : storedEnv;

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return c.json({ error: `Invalid platform config: ${envParsed.error.message}` }, 400);
  }

  const existing = c.env.slots.get(slug);
  if (existing?.sandbox) {
    console.info("Replacing existing deploy", { slug });
    await terminateSlot(existing);
  }

  // Merge the deployer's key hash into existing credential hashes rather
  // than replacing them, so multi-user ownership is preserved across deploys.
  const existingManifest = await c.env.store.getManifest(slug);
  const existingHashes = existingManifest?.credential_hashes ?? [];
  const mergedHashes = existingHashes.includes(keyHash)
    ? existingHashes
    : [...existingHashes, keyHash];

  await c.env.store.putAgent({
    slug,
    env,
    worker: body.worker,
    clientFiles: body.clientFiles,
    credential_hashes: mergedHashes,
  });

  c.env.slots.set(slug, { slug, keyHash });

  console.info("Deploy received", { slug });

  return c.json({ ok: true, message: `Deployed ${slug}` });
}
