// Copyright 2026 the AAI authors. MIT license.
/**
 * The project's DATABASE (`ctx.db`) as ONE switch covering BOTH environments.
 *
 * The platform primitive is per-slug: `aai storage enable <slug>` provisions a
 * Postgres schema + login role for one deployed agent and stores its
 * credentials as `app-db:<slug>` (aai-server/storage-handler.ts,
 * app-database.ts). A studio project is TWO deployed agents — the production
 * slug Publish claims and the `<project>-preview` slug the auto-preview
 * deployer claims — so "enable the database" on a project is two
 * provisionings, and a per-slug toggle in the Settings pane would have made
 * that the user's bookkeeping. It is called a database here (and in the pane)
 * rather than "storage" because that is what `ctx.db` is documented as.
 *
 * The two environments get SEPARATE schemas, deliberately: the preview agent
 * is where half-finished tool code runs, and a shared schema would let a
 * preview turn drop the production table.
 *
 * **Intent is stamped on the workspace (`databaseEnabled`); provisioning
 * follows the SLUG.** A database can be switched on before either agent
 * exists (a project usually has a preview and no production deploy), and
 * provisioning a slug nobody has claimed would create a schema that outlives
 * every cleanup path — the orphan-preview sweep and `deleteAgentResources`
 * both key off an agents row — and that a different tenant could inherit by
 * claiming the name first. So the flag records what the project wants, the
 * switch provisions the slugs that already exist, and
 * {@link reconcileProjectDatabase} provisions the rest as their deploys claim
 * them. The invariant that buys: an app database exists only for a deployed,
 * owned slug.
 *
 * **It takes effect on the agent's next DEPLOY.** `DATABASE_URL` is read from
 * the `app-db:` secret when a sandbox is BUILT (sandbox-resolve.ts), and
 * deploy/delete are the only mutations that move sandboxes — the same trade
 * secret changes make. The preview is therefore force-redeployed here (clear
 * `previewHash`, schedule; the `wakeProjectPreview` pattern) so the
 * environment the user is looking at picks the change up on its own.
 * Production needs a Publish, which is the user's call to make and which the
 * pane says out loud.
 */

import type { AppDatabases } from "aai-server/app-database";
import type { SlugMutationLock } from "aai-server/platform-lock";
import type { SecretStore } from "aai-server/secret-store";
import { verifySlugOwner } from "aai-server/secrets";
import {
  disableStorage,
  enableStorage,
  type StorageEnv,
  storageStatus,
} from "aai-server/storage-handler";
import type { BundleStore } from "aai-server/store-types";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { getWorkspace, mutateWorkspace, type StudioWorkspace } from "./studio-workspace.ts";

/** The two agents one studio project deploys. */
export const PROJECT_ENVIRONMENTS = ["production", "preview"] as const;

export type ProjectEnvironment = (typeof PROJECT_ENVIRONMENTS)[number];

/** What this module needs from the studio's request bindings. */
export type ProjectDatabaseEnv = {
  workspaces: WorkspaceStore;
  /** Agents table — the ownership check for a slug the workspace names. */
  store: BundleStore;
  secrets: SecretStore;
  /** Absent when SUPABASE_DB_URL is unset: nothing can be provisioned. */
  appDb?: AppDatabases | undefined;
  slugLock: SlugMutationLock;
};

/** One environment's database state. */
export type ProjectDatabaseEnvironmentState = {
  environment: ProjectEnvironment;
  /** The deployed agent's slug; absent until that environment has deployed. */
  slug?: string;
  /** Is a database provisioned for that slug right now? */
  enabled: boolean;
};

export type ProjectDatabaseState = {
  /** The project's intent — what the next deploy of either agent provisions. */
  enabled: boolean;
  /** Can this server provision at all (SUPABASE_DB_URL configured)? */
  configured: boolean;
  environments: ProjectDatabaseEnvironmentState[];
};

function storageEnvOf(env: ProjectDatabaseEnv): StorageEnv {
  return { secrets: env.secrets, appDb: env.appDb, slugLock: env.slugLock };
}

/** The slug an environment's agent runs under, once it has one. */
function slugFor(workspace: StudioWorkspace, environment: ProjectEnvironment): string | undefined {
  return environment === "production" ? workspace.deployedSlug : workspace.previewSlug;
}

/**
 * Ownership of a slug the workspace names, checked against the agents row's
 * credential hashes rather than project scope alone — the same rule the
 * project delete cascade follows, for the same reason: a workspace naming a
 * slug the caller does not own (however it got there) must not become an
 * oracle for, or a lever on, someone else's agent.
 */
async function ownsSlug(env: ProjectDatabaseEnv, apiKey: string, slug: string): Promise<boolean> {
  const owner = await verifySlugOwner(apiKey, { slug, store: env.store });
  return owner.status === "owned";
}

async function environmentState(
  env: ProjectDatabaseEnv,
  apiKey: string,
  workspace: StudioWorkspace,
  environment: ProjectEnvironment,
): Promise<ProjectDatabaseEnvironmentState> {
  const slug = slugFor(workspace, environment);
  if (slug === undefined) return { environment, enabled: false };
  // A foreign slug reads as "no database here" rather than reporting whether
  // someone else's agent has one.
  if (!(await ownsSlug(env, apiKey, slug))) return { environment, slug, enabled: false };
  const { enabled } = await storageStatus(storageEnvOf(env), slug);
  return { environment, slug, enabled };
}

function stateFor(
  env: ProjectDatabaseEnv,
  apiKey: string,
  workspace: StudioWorkspace,
): Promise<ProjectDatabaseState> {
  return Promise.all(
    PROJECT_ENVIRONMENTS.map((environment) =>
      environmentState(env, apiKey, workspace, environment),
    ),
  ).then((environments) => ({
    enabled: workspace.databaseEnabled === true,
    configured: env.appDb !== undefined,
    environments,
  }));
}

/** The project's database state, or null when the project does not exist. */
export async function projectDatabaseState(
  env: ProjectDatabaseEnv,
  params: { scope: string; project: string; apiKey: string },
): Promise<ProjectDatabaseState | null> {
  const workspace = await getWorkspace(env.workspaces, params.scope, params.project);
  if (!workspace) return null;
  return stateFor(env, params.apiKey, workspace);
}

export type SetProjectDatabaseParams = {
  scope: string;
  project: string;
  apiKey: string;
  enabled: boolean;
  /**
   * Force the preview to redeploy so the running preview agent picks the
   * change up (see the module doc). Absent in tests that only assert
   * provisioning.
   */
  schedulePreview?: () => void;
};

export type SetProjectDatabaseResult = ProjectDatabaseState & {
  /** An environment that could not be switched, when others succeeded. */
  warning?: string;
};

/**
 * Turn the project's database on or off across both environments.
 *
 * The workspace flag is written FIRST in both directions: a deploy racing
 * this reads the flag to decide whether to provision, so stamping last would
 * let an enable miss a deploy that landed in between — and, worse, let a
 * disable be undone by one.
 *
 * Provisioning failures are per environment. With at least one environment
 * switched the rest ride back as a `warning` (the returned state says exactly
 * which environments have a database); with none, the failure is rethrown —
 * an unconfigured platform (`appDb` absent, a 503 from `enableStorage`) has to
 * surface as a failed request rather than a silent no-op.
 *
 * @returns null when the project does not exist.
 */
export async function setProjectDatabase(
  env: ProjectDatabaseEnv,
  params: SetProjectDatabaseParams,
): Promise<SetProjectDatabaseResult | null> {
  const { scope, project, apiKey, enabled } = params;
  const workspace = await mutateWorkspace(env.workspaces, scope, project, (current) => {
    const next = { ...current };
    if (enabled) next.databaseEnabled = true;
    else delete next.databaseEnabled;
    return next;
  });
  if (!workspace) return null;

  const failures: string[] = [];
  let switched = 0;
  let lastFailure: unknown;
  for (const environment of PROJECT_ENVIRONMENTS) {
    const slug = slugFor(workspace, environment);
    // No agent yet: the flag above is the whole answer — its first deploy
    // provisions through reconcileProjectDatabase.
    if (slug === undefined) continue;
    if (!(await ownsSlug(env, apiKey, slug))) continue;
    try {
      await applyToSlug(env, slug, enabled);
      switched += 1;
    } catch (err) {
      lastFailure = err;
      failures.push(environment);
    }
  }
  if (switched === 0 && lastFailure !== undefined) throw lastFailure;

  // The preview environment is the one the user is looking at, so it must not
  // wait for an unrelated edit to pick this up. Clearing the stamp is what
  // makes the deploy run at all (it no-ops on a matching files hash).
  if (params.schedulePreview && workspace.previewSlug !== undefined) {
    await mutateWorkspace(env.workspaces, scope, project, (current) => {
      const next = { ...current };
      delete next.previewHash;
      return next;
    });
    params.schedulePreview();
  }

  const state = await stateFor(env, apiKey, workspace);
  return {
    ...state,
    ...(failures.length > 0 && {
      warning: `Could not ${enabled ? "enable" : "disable"} the ${failures.join(" and ")} database`,
    }),
  };
}

/**
 * Enable or disable one slug's database, skipping the work when it is already
 * in the requested state. The skip is load-bearing on enable: `provision`
 * rotates the role's password on every call, so re-provisioning a live agent's
 * database would invalidate the `DATABASE_URL` its running sandbox holds.
 */
async function applyToSlug(env: ProjectDatabaseEnv, slug: string, enabled: boolean): Promise<void> {
  const storage = storageEnvOf(env);
  const current = await storageStatus(storage, slug);
  if (current.enabled === enabled) return;
  if (enabled) await enableStorage(storage, slug);
  else await disableStorage(storage, slug);
}

/**
 * Provision the database for a slug that has just been deployed, when the
 * project asked for one.
 *
 * This is what makes "enable the database" hold for an environment that did
 * not exist when the switch was flipped — the common case, since a project
 * normally has a preview agent and no production deploy. Called from the
 * broker's one deploy path, so Publish and the auto preview deploy are both
 * covered by one hook.
 *
 * No ownership check: the deploy that just succeeded on the caller's key IS
 * the proof of ownership. Already-provisioned slugs are left alone (see
 * {@link applyToSlug}).
 */
export async function reconcileProjectDatabase(
  env: ProjectDatabaseEnv,
  params: { scope: string; project: string; slug: string },
): Promise<void> {
  if (!env.appDb) return;
  const workspace = await getWorkspace(env.workspaces, params.scope, params.project);
  if (workspace?.databaseEnabled !== true) return;
  await applyToSlug(env, params.slug, true);
}
