// Copyright 2025 the AAI authors. MIT license.
import type { Context } from "hono";
import { type DeployBody, DeployBodySchema, EnvSchema } from "./_schemas.ts";
import type { Env } from "./context.ts";
import { withSlugLock } from "./slug-lock.ts";

export function handleDeploy(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  return withSlugLock(slug, () => handleDeployInner(c));
}

async function handleDeployInner(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const keyHash = c.get("keyHash");

  const body: DeployBody = DeployBodySchema.parse(await c.req.json());

  const storedEnv = (await c.env.store.getEnv(slug)) ?? {};
  const env = body.env ? { ...storedEnv, ...body.env } : storedEnv;

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return c.json({ error: `Invalid platform config: ${envParsed.error.message}` }, 400);
  }

  const existing = c.env.slots.get(slug);
  if (existing?.sandbox || existing?.initializing) {
    console.info("Replacing existing deploy", { slug });
    if (existing.sandbox) {
      await existing.sandbox.terminate().catch((err: unknown) => {
        console.warn("Failed to terminate existing sandbox", { slug, error: String(err) });
      });
    } else if (existing.initializing) {
      await existing.initializing
        .then((sb) => sb.terminate())
        .catch((err: unknown) => {
          console.warn("Failed to terminate initializing sandbox", { slug, error: String(err) });
        });
    }
    delete existing.sandbox;
    delete existing.initializing;
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
