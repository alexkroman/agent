// Copyright 2026 the AAI authors. MIT license.
/**
 * HTTP surface of the project database (`ctx.db`), mounted under
 * `/studio/projects/:project` by studio-routes.ts:
 *
 * - `GET    …/database` — the switch's state, per environment
 * - `POST   …/database` — provision it for both environments
 * - `DELETE …/database` — drop both, with all their data
 *
 * One switch per PROJECT rather than per slug, because a project is two
 * deployed agents (production and preview). studio-database.ts owns the
 * reasoning; this is the routing and the request-bound wiring.
 */

import type { Context, Hono } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import {
  type ProjectDatabaseEnv,
  projectDatabaseState,
  reconcileProjectDatabase,
  setProjectDatabase,
} from "./studio-database.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import { schedulePreviewFor } from "./studio-settled-edit.ts";

/**
 * The database core's bindings, read off the REQUEST env — never closed over
 * the Context, so this is equally safe for a request handler and for the
 * broker's long-lived post-deploy hook (which outlives every request).
 */
export function databaseEnvFor(c: Context<StudioHonoEnv>): ProjectDatabaseEnv {
  return {
    workspaces: c.env.workspaces,
    store: c.env.store,
    secrets: c.env.secrets,
    ...(c.env.appDb && { appDb: c.env.appDb }),
    slugLock: c.env.slugLock,
  };
}

/**
 * `ensureBroker` is needed for one thing: redeploying the project's preview
 * so the running preview agent picks the change up — its `DATABASE_URL` is
 * fixed at its last deploy.
 */
export function registerDatabaseRoutes(
  studio: Hono<StudioHonoEnv>,
  ensureBroker: (c: Context<StudioHonoEnv>) => StudioSessionBroker,
): void {
  studio.get("/projects/:project/database", async (c) => {
    const { scope, project } = c.var;
    const state = await projectDatabaseState(databaseEnvFor(c), {
      scope,
      project,
      apiKey: c.var.apiKey,
    });
    if (!state) return c.json({ error: "Project not found" }, 404);
    return c.json(state);
  });

  /** POST enables; DELETE disables, dropping every schema and its data. */
  const setDatabase = async (c: Context<StudioHonoEnv>, enabled: boolean): Promise<Response> => {
    const { scope, project } = c.var;
    const result = await setProjectDatabase(databaseEnvFor(c), {
      scope,
      project,
      apiKey: c.var.apiKey,
      enabled,
      schedulePreview: () => schedulePreviewFor(ensureBroker(c), c, scope, project),
    });
    if (!result) return c.json({ error: "Project not found" }, 404);
    return c.json(result);
  };

  studio.post("/projects/:project/database", (c) => setDatabase(c, true));
  studio.delete("/projects/:project/database", (c) => setDatabase(c, false));
}

/**
 * The post-deploy hook the session broker is wired with: give a slug the
 * deploy just claimed the database its project asked for. Bound to this
 * request's stores, and handed to the broker, which outlives the request —
 * safe because {@link databaseEnvFor} reads the env rather than the Context.
 */
export function databaseDeployHook(
  c: Context<StudioHonoEnv>,
): (scope: string, project: string, slug: string) => Promise<void> {
  const env = databaseEnvFor(c);
  return (scope, project, slug) => reconcileProjectDatabase(env, { scope, project, slug });
}
