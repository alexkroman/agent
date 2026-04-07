// Copyright 2025 the AAI authors. MIT license.

import { runInNewContext } from "node:vm";
import { humanId } from "human-id";
import { timingSafeCompare } from "./auth.ts";
import { z } from "zod";
import type { ValidatedAppContext } from "./context.ts";
import { terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import type { DeployBody } from "./schemas.ts";
import { EnvSchema } from "./schemas.ts";

/** Minimal schema for a valid agent bundle default export.
 *  Accepts both raw AgentDef (has `tools`) and toAgentConfig output (has `toolSchemas`). */
const AgentBundleSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string(),
});

/**
 * Validate that a worker bundle exports a valid agent definition.
 * Evaluates the bundle in an isolated vm context with a 2s timeout.
 * Returns null if valid, or an error message string.
 */
function validateWorkerBundle(code: string): string | null {
  try {
    // Wrap ESM default export into a CJS-compatible evaluation
    const wrapped = code.replace(/^export default/, "module.exports =");
    const mod = { exports: {} as Record<string, unknown> };
    runInNewContext(wrapped, { module: mod }, { timeout: 2000 });
    const result = AgentBundleSchema.safeParse(mod.exports);
    if (!result.success) {
      return `Invalid agent bundle: ${result.error.issues.map((i) => i.message).join(", ")}`;
    }
    return null;
  } catch (err) {
    return `Agent bundle evaluation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

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
      if (
        existing &&
        !existing.credential_hashes.some((h) => timingSafeCompare(h, c.var.keyHash))
      ) {
        return c.json({ error: "Forbidden: slug already owned by another user" }, 403);
      }
    }
    return handleDeployInner(c, slug);
  });
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

  // Validate agent bundle before storing — catches missing name/systemPrompt/tools
  const bundleError = validateWorkerBundle(body.worker);
  if (bundleError) {
    return c.json({ error: bundleError }, 400);
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
  const mergedHashes = existingHashes.some((h) => timingSafeCompare(h, keyHash))
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

  return c.json({ ok: true, slug, message: `Deployed ${slug}` });
}
