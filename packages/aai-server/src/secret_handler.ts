// Copyright 2025 the AAI authors. MIT license.

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { SecretUpdatesSchema } from "./_schemas.ts";
import type { Env } from "./context.ts";

function restartSandbox(c: Context<Env>, slug: string, reason: string): void {
  const slot = c.env.slots.get(slug);
  if (slot?.sandbox) {
    console.info(`Restarting sandbox for ${reason}`, { slug });
    slot.sandbox.terminate();
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
  const parsed = SecretUpdatesSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: "Body must be a JSON object of string key-value pairs",
    });
  }
  const updates = parsed.data;

  const existing = (await c.env.store.getEnv(slug)) ?? {};
  const merged = { ...existing, ...updates };
  await c.env.store.putEnv(slug, merged);

  restartSandbox(c, slug, "secret update");
  console.info("Secret updated", { slug, keys: Object.keys(updates) });
  return c.json({ ok: true, keys: Object.keys(merged) });
}

export async function handleSecretDelete(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  // biome-ignore lint/style/noNonNullAssertion: key param guaranteed by route
  const key = c.req.param("key")!;
  const existing = await c.env.store.getEnv(slug);
  if (!existing) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }
  delete existing[key];
  await c.env.store.putEnv(slug, existing);
  restartSandbox(c, slug, "secret delete");
  console.info("Secret deleted", { slug, key });
  return c.json({ ok: true });
}
