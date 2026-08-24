// Copyright 2026 the AAI authors. MIT license.
/**
 * HTTP surface of the project database (`ctx.db`), mounted under
 * `/studio/projects/:project` by studio-routes.ts:
 *
 * - `GET    …/database` — the switch's state, per environment
 * - `POST   …/database` — provision it for both environments
 * - `DELETE …/database` — drop both, with all their data
 * - `GET    …/database/tables` — one environment's tables (the viewer)
 * - `GET    …/database/rows` — one page of one table
 *
 * One switch per PROJECT rather than per slug, because a project is two
 * deployed agents (production and preview). studio-database.ts owns the
 * reasoning; this is the routing and the request-bound wiring.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Context, Hono } from "hono";
import { projectNotFound, type StudioHonoEnv } from "./studio-context.ts";
import {
  type ProjectDatabaseEnv,
  projectDatabaseState,
  reconcileProjectDatabase,
  setProjectDatabase,
} from "./studio-database.ts";
import { projectTableRows, projectTables } from "./studio-database-browse.ts";
import { PROJECT_ENVIRONMENTS, type ProjectEnvironment } from "./studio-project-slugs.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import type { AfterDeploy } from "./studio-session-publish.ts";
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
    ...omitUndefined({ appDb: c.env.appDb }),
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
    if (!state) return projectNotFound(c);
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
    if (!result) return projectNotFound(c);
    return c.json(result);
  };

  studio.post("/projects/:project/database", (c) => setDatabase(c, true));
  studio.delete("/projects/:project/database", (c) => setDatabase(c, false));

  // The read-only viewer. Both routes answer 404 for every "nothing to show
  // you" — no such project, an environment that has not deployed, a slug the
  // caller does not own, storage off — because the pane makes one statement
  // for all of them and telling them apart would be an ownership oracle over
  // the slug namespace (see studio-database-browse.ts).
  studio.get("/projects/:project/database/tables", async (c) => {
    const environment = environmentParam(c);
    if (!environment) return c.json({ error: BAD_ENVIRONMENT }, 400);
    const tables = await projectTables(databaseEnvFor(c), {
      scope: c.var.scope,
      project: c.var.project,
      apiKey: c.var.apiKey,
      environment,
    });
    if (!tables) return c.json({ error: NO_DATABASE }, 404);
    return c.json(tables);
  });

  studio.get("/projects/:project/database/rows", async (c) => {
    const environment = environmentParam(c);
    if (!environment) return c.json({ error: BAD_ENVIRONMENT }, 400);
    const schema = c.req.query("schema");
    const table = c.req.query("table");
    if (schema === undefined || table === undefined) {
      return c.json({ error: "schema and table are required" }, 400);
    }
    const page = await projectTableRows(databaseEnvFor(c), {
      scope: c.var.scope,
      project: c.var.project,
      apiKey: c.var.apiKey,
      environment,
      schema,
      table,
      // Clamped by `readAppTable` itself rather than here — a cap enforced at
      // the route is a cap the next caller of the core does not get.
      limit: positiveParam(c.req.query("limit"), DEFAULT_ROWS),
      offset: positiveParam(c.req.query("offset"), 0),
    });
    // A table that is gone (a migration between the list and the click) is the
    // same 404 as no database: the pane re-reads its list either way.
    if (!page) return c.json({ error: NO_DATABASE }, 404);
    return c.json(page);
  });
}

/** Rows a page carries when the caller does not say. */
const DEFAULT_ROWS = 50;

const BAD_ENVIRONMENT = `environment must be one of: ${PROJECT_ENVIRONMENTS.join(", ")}`;
const NO_DATABASE = "No database to read for this environment";

/**
 * The `?environment=` query value, or undefined when it is not one of ours.
 *
 * Validated rather than defaulted: which agent's rows you are looking at is the
 * difference between "my tool saved nothing" and "my tool saved it in the
 * preview", so a typo has to be a 400 instead of quietly answering for
 * production.
 */
function environmentParam(c: Context<StudioHonoEnv>): ProjectEnvironment | undefined {
  const value = c.req.query("environment");
  return PROJECT_ENVIRONMENTS.find((environment) => environment === value);
}

/** A non-negative integer query parameter, or the default for anything else. */
function positiveParam(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The post-deploy hook the session broker is wired with: give a slug the
 * deploy just claimed the database its project asked for. Bound to this
 * request's stores, and handed to the broker, which outlives the request —
 * safe because {@link databaseEnvFor} reads the env rather than the Context.
 */
export function databaseDeployHook(c: Context<StudioHonoEnv>): AfterDeploy {
  const env = databaseEnvFor(c);
  return (scope, project, slug) => reconcileProjectDatabase(env, { scope, project, slug });
}
