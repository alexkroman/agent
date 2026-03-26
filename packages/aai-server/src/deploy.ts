// Copyright 2025 the AAI authors. MIT license.
import type { Context } from "hono";
import { z } from "zod";
import { type DeployBody, DeployBodySchema, EnvSchema } from "./_schemas.ts";
import type { Env } from "./context.ts";

export async function handleDeploy(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const keyHash = c.get("keyHash");

  let body: DeployBody;
  try {
    body = DeployBodySchema.parse(await c.req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : "Invalid deploy body";
    return c.json({ error: msg }, 400);
  }

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
      await existing.sandbox.terminate().catch(() => {
        // Intentionally swallowed — best-effort cleanup of existing sandbox
      });
    } else if (existing.initializing) {
      await existing.initializing
        .then((sb) => sb.terminate())
        .catch(() => {
          // Intentionally swallowed — best-effort cleanup of initializing sandbox
        });
    }
    delete existing.sandbox;
    delete existing.initializing;
  }

  await c.env.store.putAgent({
    slug,
    env,
    worker: body.worker,
    clientFiles: body.clientFiles,
    credential_hashes: [keyHash],
  });

  c.env.slots.set(slug, { slug, keyHash });

  console.info("Deploy received", { slug });

  return c.json({ ok: true, message: `Deployed ${slug}` });
}
