// Copyright 2025 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { parseAppDbMeta } from "./app-database.ts";
import type { AppContext, HonoEnv } from "./context.ts";
import { appDbSecretName } from "./secret-store.ts";

export function handleDelete(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  return deleteAgentResources(c.env, slug).then(() =>
    c.json({ ok: true, message: `Deleted ${slug}` }),
  );
}

/**
 * Delete everything a deployed agent owns, under the slug lock: its app
 * database (schema + role), then the agents row — whose removal IS the
 * cross-replica invalidation (every resident sandbox terminates via the
 * change stream, and a rebuild 404s instead of serving the deleted agent).
 *
 * Shared by the agent service's `DELETE /:slug` and the studio's project
 * delete, which cascades to the project's deployed and preview agents —
 * one delete path, exactly like deploy.
 */
export async function deleteAgentResources(
  env: Pick<HonoEnv["Bindings"], "appDb" | "secrets" | "slugLock" | "store">,
  slug: string,
): Promise<void> {
  await env.slugLock(slug, async () => {
    // Deprovision the app's database (schema + role) before deleteAgent wipes
    // the stored credentials. Idempotent (a no-op when nothing was provisioned)
    // and best-effort: a failed drop must not leave the agent half-deleted, and
    // a later retry can finish the job. deleteAgent owns the secret sweep.
    //
    // The credentials are read here for their LOCATOR, not to connect with:
    // the stored `url` names the cluster this app was placed on, and it is the
    // only thing that survives a change to APP_DB_URLS (see
    // AppDatabases.deprovision). It has to be read before `deleteAgent`, which
    // deletes the very secret holding it.
    if (env.appDb) {
      try {
        const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
        await env.appDb.deprovision(slug, meta);
      } catch (err) {
        console.warn(`Failed to deprovision app database for ${slug}: ${errorMessage(err)}`);
      }
    }
    await env.store.deleteAgent(slug);
    debug("Delete received", { slug });
  });
}
