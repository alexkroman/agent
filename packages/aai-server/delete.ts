// Copyright 2025 the AAI authors. MIT license.
import { debug } from "./_debug-log.ts";
import type { AppContext } from "./context.ts";
import { deleteSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";

export function handleDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, () => handleDeleteInner(c));
}

async function handleDeleteInner(c: AppContext): Promise<Response> {
  const slug = c.var.slug;

  const existing = c.env.slots.get(slug);
  if (existing) await terminateSlot(existing, c.env.slots);
  deleteSlot(c.env.slots, slug);

  await c.env.store.deleteAgent(slug);

  debug("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
