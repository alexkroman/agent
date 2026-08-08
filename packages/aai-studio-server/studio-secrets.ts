// Copyright 2026 the AAI authors. MIT license.
/**
 * A project's secrets, across BOTH of its deployed agents.
 *
 * The per-slug routes (`/:slug/secret`, what `aai secret` drives) stay the
 * platform primitive; this is the project-level switch over them, exactly as
 * `studio-secrets`' sibling `studio-database.ts` is for `ctx.db`. The fan-out
 * used to live in the browser (`settings.tsx` PUT the production slug, then
 * mirrored to the preview one), which made it a property of the STUDIO CLIENT
 * rather than of a project — so every other caller silently wrote to
 * production alone. See `studio-project-slugs.ts` for what that cost.
 *
 * Values are never returned. A secret's value leaves the platform nowhere:
 * these routes report NAMES, and the store hands values only to a guest's
 * boot env.
 */

import {
  deleteSlugSecret,
  listSlugSecrets,
  type SecretEnv,
  setSlugSecrets,
} from "aai-server/secret-handler";
import type { BundleStore } from "aai-server/store-types";
import type { WorkspaceStore } from "aai-server/workspace-store";
import {
  ownedProjectSlugs,
  PROJECT_ENVIRONMENTS,
  type ProjectEnvironment,
} from "./studio-project-slugs.ts";
import { getWorkspace } from "./studio-workspace.ts";

export type ProjectSecretsEnv = SecretEnv & {
  workspaces: WorkspaceStore;
  store: BundleStore;
};

export type ProjectSecretsEnvironmentState = {
  environment: ProjectEnvironment;
  /** Absent until that environment has been deployed at least once. */
  slug?: string;
  /** Names only. */
  vars: string[];
};

export type ProjectSecretsState = {
  /**
   * The union of every environment's names — what the panel lists, since a
   * secret set before the preview existed is still "set on this project".
   */
  vars: string[];
  environments: ProjectSecretsEnvironmentState[];
};

type ProjectParams = { scope: string; project: string; apiKey: string };

/**
 * Run `op` against every agent of the project this caller owns.
 * Returns null when the project itself does not exist (a 404), and an empty
 * list when it exists but has deployed nothing yet — writing secrets before
 * a first deploy is legal and simply reaches no agent.
 */
async function overProjectAgents<T>(
  env: ProjectSecretsEnv,
  params: ProjectParams,
  op: (slug: string, environment: ProjectEnvironment) => Promise<T>,
): Promise<{ environment: ProjectEnvironment; slug: string; result: T }[] | null> {
  const workspace = await getWorkspace(env.workspaces, params.scope, params.project);
  if (!workspace) return null;
  const targets = await ownedProjectSlugs(env.store, params.apiKey, workspace);
  // The agents are independent stores under independent per-slug locks.
  return Promise.all(
    targets.map(async ({ environment, slug }) => ({
      environment,
      slug,
      result: await op(slug, environment),
    })),
  );
}

/** Every name set on the project, per environment. Null when it doesn't exist. */
export async function projectSecretsState(
  env: ProjectSecretsEnv,
  params: ProjectParams,
): Promise<ProjectSecretsState | null> {
  const listed = await overProjectAgents(env, params, (slug) => listSlugSecrets(env, slug));
  if (listed === null) return null;
  const byEnvironment = new Map(listed.map((entry) => [entry.environment, entry]));
  const environments = PROJECT_ENVIRONMENTS.map((environment) => {
    const entry = byEnvironment.get(environment);
    return entry === undefined
      ? { environment, vars: [] }
      : { environment, slug: entry.slug, vars: entry.result };
  });
  const vars = [...new Set(environments.flatMap((e) => e.vars))].sort();
  return { vars, environments };
}

/** Merge `updates` into every agent of the project. */
export function setProjectSecrets(
  env: ProjectSecretsEnv,
  params: ProjectParams & { updates: Record<string, string> },
): Promise<ProjectSecretsState | null> {
  return overProjectAgents(env, params, (slug) => setSlugSecrets(env, slug, params.updates)).then(
    (written) => (written === null ? null : projectSecretsState(env, params)),
  );
}

/** Drop `key` from every agent of the project. */
export function deleteProjectSecret(
  env: ProjectSecretsEnv,
  params: ProjectParams & { key: string },
): Promise<ProjectSecretsState | null> {
  return overProjectAgents(env, params, (slug) => deleteSlugSecret(env, slug, params.key)).then(
    (deleted) => (deleted === null ? null : projectSecretsState(env, params)),
  );
}
