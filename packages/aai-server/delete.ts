// Copyright 2025 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import type { AppContext } from "./context.ts";
import { deleteSlot, invalidateSlug, terminateSlot } from "./sandbox-slots.ts";

export function handleDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return c.env.slugLock(slug, () => handleDeleteInner(c));
}

async function handleDeleteInner(c: AppContext): Promise<Response> {
  const slug = c.var.slug;

  const existing = c.env.slots.get(slug);
  if (existing) await terminateSlot(existing);
  deleteSlot(c.env.slots, slug);

  // Deprovision the app's database (schema + role) before deleteAgent wipes
  // the stored credentials. Idempotent (a no-op when nothing was provisioned)
  // and best-effort: a failed drop must not leave the agent half-deleted, and
  // a later retry can finish the job. deleteAgent owns the secret sweep.
  if (c.env.appDb) {
    try {
      await c.env.appDb.deprovision(slug);
    } catch (err) {
      console.warn(`Failed to deprovision app database for ${slug}: ${errorMessage(err)}`);
    }
  }

  await c.env.store.deleteAgent(slug);

  // Other replicas' resident sandboxes for this slug must go too — their
  // next session start sees the epoch mismatch, rebuilds, finds no
  // manifest, and 404s instead of serving the deleted agent. The local
  // half of invalidateSlug is a no-op here (the slot was torn down above,
  // before the store delete); using the shared helper keeps delete inside
  // the one invalidation mechanism every other mutation route uses.
  await invalidateSlug(c.env, slug, "delete");

  debug("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
