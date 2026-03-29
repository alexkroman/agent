// Copyright 2025 the AAI authors. MIT license.

import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";
import { terminateSlot } from "./sandbox-slots.ts";

/** Keys managed by the platform that agents must not override or delete. */
const RESERVED_KEYS = new Set(["ASSEMBLYAI_API_KEY"]);

async function restartSandbox(c: AppContext, slug: string, reason: string): Promise<void> {
  const slot = c.env.slots.get(slug);
  if (slot?.sandbox || slot?.initializing) {
    console.info(`Restarting sandbox for ${reason}`, { slug });
    await terminateSlot(slot);
  }
}

export async function handleSecretList(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const env = await c.env.store.getEnv(slug);
  if (!env) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }
  return c.json({ vars: Object.keys(env) });
}

export async function handleSecretSet(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  // Pre-validated by zValidator("json", SecretUpdatesSchema) in orchestrator
  // biome-ignore lint/suspicious/noExplicitAny: validated upstream by zValidator middleware
  const updates = (c.req as any).valid("json") as Record<string, string>;

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

export async function handleSecretDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
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
