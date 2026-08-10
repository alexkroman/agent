// Copyright 2026 the AAI authors. MIT license.
/**
 * Everything a newly claimed slug owes its project, composed into the ONE
 * post-deploy hook the session broker takes.
 *
 * Both project-level switches — the database and secrets — are reachable
 * before either agent exists, which is the ordinary state (a project has a
 * preview long before a publish, and secrets are what an agent needs to run
 * at all). So each records intent and each owes a reconcile when a deploy
 * finally claims a slug, and the broker's single `afterDeploy` is where both
 * Publish and the auto preview deploy pass through.
 *
 * They are awaited INDEPENDENTLY rather than chained: neither is allowed to
 * skip the other, and a hook that fails must not take the sibling with it.
 * The publisher already treats the whole hook as unable to fail a deploy —
 * the CLI output is on its way to the chat by then.
 */

import type { Context } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import { databaseDeployHook } from "./studio-database-routes.ts";
import { secretsDeployHook } from "./studio-secret-routes.ts";

export type AfterDeploy = (scope: string, project: string, slug: string) => Promise<void>;

/**
 * Bound to THIS request's stores and handed to a broker that outlives the
 * request — safe because each hook reads the request env rather than closing
 * over the Context (see `databaseEnvFor` / `secretsEnvFor`).
 */
export function createAfterDeploy(c: Context<StudioHonoEnv>): AfterDeploy {
  const hooks: AfterDeploy[] = [databaseDeployHook(c), secretsDeployHook(c)];
  return async (scope, project, slug) => {
    await Promise.all(hooks.map((hook) => hook(scope, project, slug)));
  };
}
