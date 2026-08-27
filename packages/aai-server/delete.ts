// Copyright 2025 the AAI authors. MIT license.
import type { AppContext, HonoEnv } from "./context.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("agent.delete");

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
  env: Pick<HonoEnv["Bindings"], "secrets" | "slugLock" | "store">,
  slug: string,
): Promise<void> {
  await env.slugLock(slug, async () => {
    // The app database used to be dropped here, before the agents row, so a
    // cluster that would not answer failed the delete with a 503 rather than
    // stranding a schema nothing referenced. There is no app database now —
    // durable runs, session state and the run journal are all the platform's —
    // so a delete is one row and the cascades hanging off it.
    await env.store.deleteAgent(slug);
    log.debug("Delete received", { slug });
  });
}
