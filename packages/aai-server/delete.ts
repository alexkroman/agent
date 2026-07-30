// Copyright 2025 the AAI authors. MIT license.
import { debug } from "./_debug-log.ts";
import type { AppContext } from "./context.ts";
import { wipeAgentKv } from "./kv-storage.ts";
import { deleteSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";

export function handleDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return withSlugLock(slug, () => handleDeleteInner(c));
}

async function handleDeleteInner(c: AppContext): Promise<Response> {
  const slug = c.var.slug;

  const existing = c.env.slots.get(slug);
  if (existing) await terminateSlot(existing);
  deleteSlot(c.env.slots, slug);

  await c.env.store.deleteAgent(slug);
  // Platform-default KV may live in a separate store (Upstash Redis) that
  // deleteAgent's bucket prefix sweep never touches. No-op when kvStorage
  // is the bundle bucket (the sweep already removed the keys).
  await wipeAgentKv(c.env.kvStorage, slug);

  debug("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
