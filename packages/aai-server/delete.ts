// Copyright 2025 the AAI authors. MIT license.
import { errorMessage } from "@alexkroman1/aai";
import { HTTPException } from "hono/http-exception";
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
    // Deprovision the app's database (schema + role) BEFORE deleteAgent wipes
    // the stored credentials, and FAIL THE DELETE if it does not work.
    //
    // This used to warn and continue, on the reasoning that "a failed drop must
    // not leave the agent half-deleted, and a later retry can finish the job".
    // The first half was right and the second was not true of anything: there is
    // no retry. Continuing deletes the `app-db:<slug>` secret and the agents
    // row, which leaves the tenant schema and its login role alive with their
    // only credential record gone and nothing left naming the slug —
    // `slugs()` no longer lists it, and the orphan sweep (pg-cron.ts) matches
    // `slug like '%-preview'` only. That is tenant data stranded permanently,
    // reported as `{ ok: true }`.
    //
    // Throwing makes the retry the comment claimed REAL: nothing has been
    // deleted, the agents row still lists the slug, and re-issuing the delete
    // finishes the job. It is also the only outcome that cannot silently
    // strand a schema — the drops are `if exists`, so the second attempt is a
    // no-op on whatever the first one did manage.
    //
    // The credentials are read here for their LOCATOR, not to connect with:
    // the stored `url` names the cluster this app was placed on, and it is the
    // only thing that survives a change to APP_DB_URLS (see
    // AppDatabases.deprovision). It has to be read before `deleteAgent`, which
    // deletes the very secret holding it.
    if (env.appDb) {
      const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
      try {
        await env.appDb.deprovision(slug, meta);
      } catch (err) {
        // 503 rather than 500: the cause is a cluster that would not answer,
        // and re-issuing the delete is exactly what the caller should do. The
        // technical message stays in the log, as everywhere else here.
        console.error(`Failed to deprovision app database for ${slug}: ${errorMessage(err)}`);
        throw new HTTPException(503, {
          message:
            `Could not drop the app database for ${slug}, so nothing was deleted — ` +
            "retry the delete.",
          cause: err,
        });
      }
    }
    await env.store.deleteAgent(slug);
    debug("Delete received", { slug });
  });
}
