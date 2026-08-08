// Copyright 2026 the AAI authors. MIT license.
/**
 * HTTP surface of a project's secrets, mounted under `/studio/projects/:project`
 * by studio-routes.ts:
 *
 * - `GET    …/secret`      — the names set, per environment
 * - `PUT    …/secret`      — merge updates into BOTH deployed agents
 * - `DELETE …/secret/:key` — drop one name from both
 *
 * One switch per PROJECT rather than per slug, because a project is two
 * deployed agents. `studio-secrets.ts` owns the reasoning; this is the
 * routing and the request-bound wiring, mirroring studio-database-routes.ts.
 *
 * The per-slug routes (`/:slug/secret`) remain the platform primitive and
 * the only surface for an agent that belongs to no project.
 */

import { zValidator } from "@hono/zod-validator";
import { SecretKeySchema, SecretUpdatesSchema } from "aai-server/schemas";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StudioHonoEnv } from "./studio-context.ts";
import {
  deleteProjectSecret,
  type ProjectSecretsEnv,
  projectSecretsState,
  setProjectSecrets,
} from "./studio-secrets.ts";

/**
 * The secrets core's bindings, read off the REQUEST env — never closed over
 * the Context, matching `databaseEnvFor`'s reasoning.
 */
export function secretsEnvFor(c: Context<StudioHonoEnv>): ProjectSecretsEnv {
  return {
    workspaces: c.env.workspaces,
    store: c.env.store,
    slugLock: c.env.slugLock,
  };
}

export function registerSecretRoutes(studio: Hono<StudioHonoEnv>): void {
  studio.get("/projects/:project/secret", async (c) => {
    const { scope, project, apiKey } = c.var;
    const state = await projectSecretsState(secretsEnvFor(c), { scope, project, apiKey });
    if (!state) return c.json({ error: "Project not found" }, 404);
    return c.json(state);
  });

  studio.put("/projects/:project/secret", zValidator("json", SecretUpdatesSchema), async (c) => {
    const { scope, project, apiKey } = c.var;
    const state = await setProjectSecrets(secretsEnvFor(c), {
      scope,
      project,
      apiKey,
      updates: c.req.valid("json"),
    });
    if (!state) return c.json({ error: "Project not found" }, 404);
    return c.json(state);
  });

  studio.delete(
    "/projects/:project/secret/:key",
    zValidator("param", z.object({ project: z.string(), key: SecretKeySchema })),
    async (c) => {
      const { scope, project, apiKey } = c.var;
      const state = await deleteProjectSecret(secretsEnvFor(c), {
        scope,
        project,
        apiKey,
        key: c.req.valid("param").key,
      });
      if (!state) return c.json({ error: "Project not found" }, 404);
      return c.json(state);
    },
  );
}
