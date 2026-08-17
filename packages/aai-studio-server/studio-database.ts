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
 * **A studio project has a database by DEFAULT** — `databaseEnabled` absent
 * means on, and only an explicit `false` turns it off. The agent the coding
 * agent writes should be able to call `ctx.db` in its first tool; the
 * alternative is that it reaches for storage, gets the enablement error, and the
 * user has to know a settings pane exists. Because the default is applied at
 * READ time, projects that predate it are covered with nothing to backfill.
 * The cost is a schema and a login role per project per environment, which the
 * orphan-preview sweep and `deleteAgentResources` already reclaim.
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

import type { AppDatabases, AppDbUsage } from "aai-server/app-database";
import type { SlugMutationLock } from "aai-server/platform-lock";
import type { SecretStore } from "aai-server/secret-store";
import {
  disableStorage,
  enableStorage,
  type StorageEnv,
  storageStatus,
  storageUsage,
} from "aai-server/storage-handler";
import type { BundleStore } from "aai-server/store-types";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { forcePreviewRedeploy } from "./studio-preview.ts";
import {
  ownedProjectSlugs,
  PROJECT_ENVIRONMENTS,
  type ProjectEnvironment,
  projectSlugFor,
} from "./studio-project-slugs.ts";
import { getWorkspace, type StudioWorkspace, stampWorkspaceMeta } from "./studio-workspace.ts";

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
  /**
   * What that schema currently holds — tables, rows, bytes. Absent when the
   * database is off, or when the read failed (see `storageUsage`): a missing
   * measurement and an empty database are different answers, and collapsing
   * them would report "0 rows" for a database nobody could look at.
   */
  usage?: AppDbUsage;
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

async function environmentState(
  env: ProjectDatabaseEnv,
  owned: ReadonlySet<string>,
  workspace: StudioWorkspace,
  environment: ProjectEnvironment,
): Promise<ProjectDatabaseEnvironmentState> {
  const slug = projectSlugFor(workspace, environment);
  if (slug === undefined) return { environment, enabled: false };
  // A foreign slug reads as "no database here" rather than reporting whether
  // someone else's agent has one. It is still NAMED, unlike an environment
  // that has never deployed — the pane can say which agent it is looking at.
  if (!owned.has(slug)) return { environment, slug, enabled: false };
  const storage = storageEnvOf(env);
  const { enabled } = await storageStatus(storage, slug);
  if (!enabled) return { environment, slug, enabled };
  // The point of the number is to answer "is my agent actually saving
  // anything" — so it is read live rather than stamped anywhere.
  const usage = await storageUsage(storage, slug);
  return { environment, slug, enabled, ...(usage && { usage }) };
}

async function stateFor(
  env: ProjectDatabaseEnv,
  apiKey: string,
  workspace: StudioWorkspace,
): Promise<ProjectDatabaseState> {
  // One ownership resolution for both environments — `ownedProjectSlugs` is
  // the shared answer to "which of this project's agents are the caller's"
  // (studio-project-slugs.ts), and it checks them concurrently.
  const owned = new Set((await ownedProjectSlugs(env.store, apiKey, workspace)).map((e) => e.slug));
  const environments = await Promise.all(
    PROJECT_ENVIRONMENTS.map((environment) => environmentState(env, owned, workspace, environment)),
  );
  return {
    // Absent means ON — see StudioWorkspace.databaseEnabled.
    enabled: workspace.databaseEnabled !== false,
    configured: env.appDb !== undefined,
    environments,
  };
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
  const workspace = await stampWorkspaceMeta(env.workspaces, scope, project, {
    // Stored EXPLICITLY in both directions. Absent means ON (see
    // StudioWorkspace.databaseEnabled), so a disable that cleared the field
    // would read as enabled again on the very next request.
    databaseEnabled: enabled,
  });
  if (!workspace) return null;

  const failures: string[] = [];
  let switched = 0;
  let lastFailure: unknown;
  // An environment with no agent yet is simply absent here: the flag above is
  // the whole answer for it, and its first deploy provisions through
  // `reconcileProjectDatabase`. Same for one whose slug the caller does not
  // own. The applies stay SEQUENTIAL — each is a schema provision under the
  // slug lock — while the ownership reads inside `ownedProjectSlugs` are not.
  for (const { environment, slug } of await ownedProjectSlugs(env.store, apiKey, workspace)) {
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
  // wait for an unrelated edit to pick this up. `forcePreviewRedeploy` owns
  // the clear-then-schedule pair (studio-preview.ts) — the clear is what makes
  // the deploy run at all, since it no-ops on a matching files hash.
  const schedulePreview = params.schedulePreview;
  if (schedulePreview && workspace.previewSlug !== undefined) {
    await forcePreviewRedeploy(env.workspaces, scope, project, schedulePreview);
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
  // A project that never touched the switch still gets one: absent means ON.
  if (workspace?.databaseEnabled === false) return;
  await applyToSlug(env, params.slug, true);
}
