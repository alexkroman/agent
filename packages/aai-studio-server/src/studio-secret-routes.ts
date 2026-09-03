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
 * routing and the request-bound wiring. It had a twin in
 * `studio-database-routes.ts`, which went with per-app databases — so this is now
 * the only project-level switch, and `studio-deploy-hooks.ts` explains why the
 * independent-await composition survives being a list of one.
 *
 * The per-slug routes (`/:slug/secret`) remain the platform primitive and
 * the only surface for an agent that belongs to no project.
 */

import { zValidator } from "@hono/zod-validator";
import { SecretKeySchema, SecretUpdatesSchema } from "aai-server/schemas";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { projectNotFound, type StudioHonoEnv } from "./studio-context.ts";
import {
  deleteProjectSecret,
  type ProjectSecretsEnv,
  projectSecretsState,
  reconcileProjectSecrets,
  setProjectSecrets,
} from "./studio-secrets.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import type { AfterDeploy } from "./studio-session-publish.ts";
import { schedulePreviewFor } from "./studio-settled-edit.ts";

/**
 * The secrets core's bindings, read off the REQUEST env — never closed over the
 * Context.
 *
 * The parameter is narrowed to the ONE thing this reads rather than the whole
 * `Context`, which is what the sentence above claims and what
 * {@link secretsDeployHook} depends on: a hook handed to a broker outlives the
 * request, so closing over a Context would be a use-after-free of the request
 * scope. Narrow enough that a test can call it with the bindings alone, which is
 * the point — the alternative was a cast, and a cast stops reporting the moment a
 * field is added.
 */
export function secretsEnvFor(c: { env: ProjectSecretsEnv }): ProjectSecretsEnv {
  return {
    workspaces: c.env.workspaces,
    store: c.env.store,
    secrets: c.env.secrets,
    slugLock: c.env.slugLock,
  };
}

/**
 * `ensureBroker` is needed for one thing: a stored secret reaches an agent's env
 * when its sandbox is BUILT, so the environment the user is looking at has to be redeployed or
 * the change sits there until an unrelated edit. Production still waits for a
 * Publish, which is the user's call.
 */
export function registerSecretRoutes(
  studio: Hono<StudioHonoEnv>,
  ensureBroker: (c: Context<StudioHonoEnv>) => StudioSessionBroker,
): void {
  const redeployPreview = (c: Context<StudioHonoEnv>, scope: string, project: string): void =>
    schedulePreviewFor(ensureBroker(c), c, scope, project);

  studio.get("/projects/:project/secret", async (c) => {
    const { scope, project, apiKey } = c.var;
    const state = await projectSecretsState(secretsEnvFor(c), { scope, project, apiKey });
    if (!state) return projectNotFound(c);
    return c.json(state);
  });

  studio.put("/projects/:project/secret", zValidator("json", SecretUpdatesSchema), async (c) => {
    const { scope, project, apiKey } = c.var;
    const state = await setProjectSecrets(secretsEnvFor(c), {
      scope,
      project,
      apiKey,
      updates: c.req.valid("json"),
      schedulePreview: () => redeployPreview(c, scope, project),
    });
    if (!state) return projectNotFound(c);
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
        schedulePreview: () => redeployPreview(c, scope, project),
      });
      if (!state) return projectNotFound(c);
      return c.json(state);
    },
  );
}

/**
 * The post-deploy hook the session broker is wired with: give a slug the deploy
 * just claimed the secrets its project holds.
 *
 * It had a twin, `databaseDeployHook`, which went with per-app databases. Bound
 * the way that one was: {@link secretsEnvFor} reads the request ENV rather than the
 * Context, which is what makes the returned function safe to hand to a broker that
 * outlives the request.
 */
export function secretsDeployHook(c: { env: ProjectSecretsEnv }): AfterDeploy {
  const env = secretsEnvFor(c);
  return (scope, project, slug) => reconcileProjectSecrets(env, { scope, project, slug });
}
