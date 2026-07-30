// Copyright 2025 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { appDbSecretName } from "./bundle-store.ts";
import type { AppContext } from "./context.ts";
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

  // Deprovision the app's database (schema + role) before deleteAgent wipes
  // the stored credentials. Best-effort: a failed drop must not leave the
  // agent half-deleted, and deprovision is idempotent for a later retry.
  if (c.env.appDb && (await c.env.secrets.get(appDbSecretName(slug))) !== null) {
    try {
      await c.env.appDb.deprovision(slug);
      // deleteAgent below also sweeps this name in the real store; deleting
      // here keeps the handler correct against any BundleStore.
      await c.env.secrets.delete(appDbSecretName(slug));
    } catch (err) {
      console.warn(`Failed to deprovision app database for ${slug}: ${errorMessage(err)}`);
    }
  }

  await c.env.store.deleteAgent(slug);

  debug("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
