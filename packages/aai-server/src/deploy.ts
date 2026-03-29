// Copyright 2025 the AAI authors. MIT license.
import type { DeployBody } from "./_schemas.ts";
import { EnvSchema } from "./_schemas.ts";
import type { AppContext } from "./context.ts";
import { terminateSlot } from "./sandbox-slots.ts";
import { withSlugLock } from "./slug-lock.ts";

export function handleDeploy(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, () => handleDeployInner(c));
}

async function handleDeployInner(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const keyHash = c.var.keyHash;

  // Pre-validated by zValidator("json", DeployBodySchema) in orchestrator
  // biome-ignore lint/suspicious/noExplicitAny: validated upstream by zValidator middleware
  const body = (c.req as any).valid("json") as DeployBody;

  const storedEnv = (await c.env.store.getEnv(slug)) ?? {};
  const env = body.env ? { ...storedEnv, ...body.env } : storedEnv;

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return c.json({ error: `Invalid platform config: ${envParsed.error.message}` }, 400);
  }

  const existing = c.env.slots.get(slug);
  if (existing?.sandbox || existing?.initializing) {
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
