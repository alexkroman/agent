// Copyright 2025 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import type { AppContext } from "./context.ts";

export function handleDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return c.env.slugLock(slug, () => handleDeleteInner(c));
}

async function handleDeleteInner(c: AppContext): Promise<Response> {
  const slug = c.var.slug;

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

  // The row delete IS the invalidation: every replica's resident sandbox for
  // this slug — this one's included — is terminated by the agents row's
  // change stream (version reads null; see watchAgentInvalidation), and a
  // rebuild finds no record, so the slug 404s instead of serving the deleted
  // agent.

  debug("Delete received", { slug });

  return c.json({ ok: true, message: `Deleted ${slug}` });
}
