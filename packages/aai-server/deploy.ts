// Copyright 2025 the AAI authors. MIT license.

import { humanId } from "human-id";
import type { ValidatedAppContext } from "./context.ts";
import { terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import type { DeployBody } from "./schemas.ts";
import { EnvSchema } from "./schemas.ts";
import { verifyApiKeyHash } from "./secrets.ts";

function generateSlug(): string {
  return humanId({ separator: "-", capitalize: false });
}

export function handleDeploy(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, () => handleDeployInner(c, slug));
}

export function handleDeployNew(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const body = c.req.valid("json");
  const slug = body.slug ?? generateSlug();
  return withSlugLock(slug, async () => {
    if (body.slug) {
      const existing = await c.env.store.getManifest(slug);
      if (existing) {
        const isOwner = await matchesAnyHash(c.var.apiKey, existing.credential_hashes);
        if (!isOwner) {
          return c.json({ error: "Forbidden: slug already owned by another user" }, 403);
        }
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
  const alreadyStored = await matchesAnyHash(c.var.apiKey, existingHashes);
  const mergedHashes = alreadyStored ? existingHashes : [...existingHashes, keyHash];

  await c.env.store.putAgent({
    slug,
    env,
    worker: body.worker,
    clientFiles: body.clientFiles,
    credential_hashes: mergedHashes,
    agentConfig: body.agentConfig,
  });

  c.env.slots.set(slug, { slug, keyHash });

  console.info("Deploy received", { slug });

  return c.json({ ok: true, slug, message: `Deployed ${slug}` });
}
