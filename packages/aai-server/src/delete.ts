// Copyright 2025 the AAI authors. MIT license.
import type { Context } from "hono";
import type { Env } from "./context.ts";
import { terminateSlot } from "./sandbox-slots.ts";
import { withSlugLock } from "./slug-lock.ts";

export function handleDelete(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  return withSlugLock(slug, () => handleDeleteInner(c));
}

async function handleDeleteInner(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");

  const existing = c.env.slots.get(slug);
  if (existing) await terminateSlot(existing);
  c.env.slots.delete(slug);

  await c.env.store.deleteAgent(slug);

  console.info("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
