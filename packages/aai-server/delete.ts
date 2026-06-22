// Copyright 2025 the AAI authors. MIT license.
import { debug } from "./_debug-log.ts";
import type { AppContext } from "./context.ts";
import { deleteSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";

export function handleDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, () => handleDeleteInner(c, slug));
}

async function handleDeleteInner(c: AppContext, slug: string): Promise<Response> {
  const existing = c.env.slots.get(slug);
  if (existing) await terminateSlot(existing);
  deleteSlot(c.env.slots, slug);

  await c.env.store.deleteAgent(slug);

  debug("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
