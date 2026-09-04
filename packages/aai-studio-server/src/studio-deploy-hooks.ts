// Copyright 2026 the AAI authors. MIT license.
/**
 * Everything a newly claimed slug owes its project, composed into the ONE
 * post-deploy hook the session broker takes.
 *
 * The project-level SECRETS switch is reachable before either agent exists, which
 * is the ordinary state (a project has a preview long before a publish, and secrets
 * are what an agent needs to run at all). So it records intent and owes a reconcile
 * when a deploy finally claims a slug, and the broker's single `afterDeploy` is
 * where both Publish and the auto preview deploy pass through.
 *
 * There were TWO — the database switch was the other, with the same shape for the
 * same reason — and the list plus the independent await survive its removal
 * deliberately: hooks are awaited independently rather than chained, so neither may
 * skip the other and a failing one must not take a sibling with it. That property is
 * why this file exists, and it is what the next hook inherits. The publisher already
 * treats the whole hook as unable to fail a deploy — the CLI output is on its way to
 * the chat by then.
 */

import type { Context } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import { secretsDeployHook } from "./studio-secret-routes.ts";
import type { AfterDeploy } from "./studio-session-publish.ts";

/**
 * Bound to THIS request's stores and handed to a broker that outlives the
 * request — safe because each hook reads the request env rather than closing
 * over the Context (see `secretsEnvFor`).
 */
export function createAfterDeploy(c: Context<StudioHonoEnv>): AfterDeploy {
  const hooks: AfterDeploy[] = [secretsDeployHook(c)];
  return async (scope, project, slug) => {
    await Promise.all(hooks.map((hook) => hook(scope, project, slug)));
  };
}
