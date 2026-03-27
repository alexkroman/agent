// Copyright 2025 the AAI authors. MIT license.

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { SecretUpdatesSchema } from "./_schemas.ts";
import type { Env } from "./context.ts";

/** Keys managed by the platform that agents must not override or delete. */
const RESERVED_KEYS = new Set(["ASSEMBLYAI_API_KEY"]);

async function restartSandbox(c: Context<Env>, slug: string, reason: string): Promise<void> {
  const slot = c.env.slots.get(slug);
  if (slot?.sandbox) {
    console.info(`Restarting sandbox for ${reason}`, { slug });
    await slot.sandbox.terminate();
    delete slot.sandbox;
    delete slot.initializing;
  }
}

export async function handleSecretList(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const env = await c.env.store.getEnv(slug);
  if (!env) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }
  return c.json({ vars: Object.keys(env) });
}

export async function handleSecretSet(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const updates = SecretUpdatesSchema.parse(await c.req.json());

  const reserved = Object.keys(updates).filter((k) => RESERVED_KEYS.has(k));
  if (reserved.length > 0) {
    throw new HTTPException(400, {
      message: `Cannot modify reserved platform keys: ${reserved.join(", ")}`,
    });
  }

  const existing = (await c.env.store.getEnv(slug)) ?? {};
  const merged = { ...existing, ...updates };
  await c.env.store.putEnv(slug, merged);

  await restartSandbox(c, slug, "secret update");
  console.info("Secret updated", { slug, keyCount: Object.keys(updates).length });
  return c.json({ ok: true, keys: Object.keys(merged) });
}

export async function handleSecretDelete(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  // biome-ignore lint/style/noNonNullAssertion: key param guaranteed by route
  const key = c.req.param("key")!;
  if (!/^[a-zA-Z_]\w*$/.test(key)) {
    throw new HTTPException(400, { message: "Invalid secret key name" });
  }
  if (RESERVED_KEYS.has(key)) {
    throw new HTTPException(400, {
      message: `Cannot delete reserved platform key: ${key}`,
    });
  }
  const existing = await c.env.store.getEnv(slug);
  if (!existing) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }
  delete existing[key];
  await c.env.store.putEnv(slug, existing);
  await restartSandbox(c, slug, "secret delete");
  console.info("Secret deleted", { slug });
  return c.json({ ok: true });
}
