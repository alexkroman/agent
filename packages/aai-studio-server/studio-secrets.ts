// Copyright 2026 the AAI authors. MIT license.
/**
 * A project's secrets, across BOTH of its deployed agents — and before either
 * of them exists.
 *
 * The per-slug routes (`/:slug/secret`, what `aai secret` drives) stay the
 * platform primitive; this is the project-level switch over them, exactly as
 * `studio-secrets`' sibling `studio-database.ts` is for `ctx.db`. The fan-out
 * used to live in the browser (`settings.tsx` PUT the production slug, then
 * mirrored to the preview one), which made it a property of the STUDIO CLIENT
 * rather than of a project — so every other caller silently wrote to
 * production alone. See `studio-project-slugs.ts` for what that cost.
 *
 * **The project holds its own copy, so a secret can be saved before anything
 * is deployed.** Writing only to the slugs that exist made the panel need a
 * Publish first — and the order that forces is backwards: an agent needs its
 * provider key to run at all, so "deploy it broken, then attach the key, then
 * deploy again" was the shortest path to a working agent. It is also NOT the
 * production slug that needs the key first; the preview agent is auto-deployed
 * on the first edit and is the one the user is about to talk to. So the record
 * below is the project's intent — the same shape as the database switch's
 * `databaseEnabled` flag — and {@link reconcileProjectSecrets} applies it to
 * each slug as its deploy claims it.
 *
 * Intent could not be stamped on the WORKSPACE the way `databaseEnabled` is:
 * the workspace doc is returned wholesale by `GET /studio/projects/:project`
 * and streamed to every open tab, and these are values. It lives in the same
 * SecretStore (Supabase Vault, encrypted at rest) that holds every
 * `agent-env:<slug>` — the record's names are reported, its values leave the
 * platform nowhere.
 */

import {
  deleteSlugSecret,
  listSlugSecrets,
  type SecretEnv,
  setSlugSecrets,
} from "aai-server/secret-handler";
import type { SecretStore } from "aai-server/secret-store";
import type { BundleStore } from "aai-server/store-types";
import type { WorkspaceStore } from "aai-server/workspace-store";
import {
  ownedProjectSlugs,
  PROJECT_ENVIRONMENTS,
  type ProjectEnvironment,
} from "./studio-project-slugs.ts";
import { getWorkspace, stampWorkspaceMeta } from "./studio-workspace.ts";

export type ProjectSecretsEnv = SecretEnv & {
  workspaces: WorkspaceStore;
  store: BundleStore;
  /** Where the project's own copy lives (see the module doc). */
  secrets: SecretStore;
};

/**
 * SecretStore name for a project's own secret record — the sibling of
 * `agent-env:<slug>` and `app-db:<slug>`, keyed by (scope, project) because
 * that pair is what identifies a project and neither half is guessable from
 * outside the owning account (`scope` is a SHA-256).
 */
export function projectEnvSecretName(scope: string, project: string): string {
  return `studio-project-env:${scope}:${project}`;
}

/**
 * The project's own copy of its secrets. A missing or unparseable record
 * reads as empty: this is a cache of intent in front of the per-slug stores,
 * so failing a read closed would take down the whole panel for a bad row.
 */
async function readProjectSecrets(
  env: ProjectSecretsEnv,
  scope: string,
  project: string,
): Promise<Record<string, string>> {
  const raw = await env.secrets.get(projectEnvSecretName(scope, project));
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Replace the project's record; an empty one is deleted rather than stored. */
async function writeProjectSecrets(
  env: ProjectSecretsEnv,
  scope: string,
  project: string,
  values: Record<string, string>,
): Promise<void> {
  const name = projectEnvSecretName(scope, project);
  if (Object.keys(values).length === 0) await env.secrets.delete(name);
  else await env.secrets.put(name, JSON.stringify(values));
}

/** Drop a deleted project's record — the delete cascade's share of this. */
export function deleteProjectSecrets(
  env: Pick<ProjectSecretsEnv, "secrets">,
  scope: string,
  project: string,
): Promise<void> {
  return env.secrets.delete(projectEnvSecretName(scope, project));
}

export type ProjectSecretsEnvironmentState = {
  environment: ProjectEnvironment;
  /** Absent until that environment has been deployed at least once. */
  slug?: string;
  /** Names only. */
  vars: string[];
};

export type ProjectSecretsState = {
  /**
   * The union of every environment's names AND the project's own record —
   * what the panel lists, since a secret set before the preview existed (or
   * before anything was deployed at all) is still "set on this project".
   */
  vars: string[];
  environments: ProjectSecretsEnvironmentState[];
  /**
   * Names held by the project but not yet by every deployed environment —
   * they reach an agent on its next deploy. Empty once both are current.
   */
  pending: string[];
};

type ProjectParams = { scope: string; project: string; apiKey: string };

/**
 * A mutation additionally takes the redeploy hook, because a stored secret
 * only reaches an agent's env when its sandbox is BUILT — the same "takes
 * effect on the next deploy" trade the per-slug routes make, and the same one
 * `setProjectDatabase` handles this way. Absent in tests that assert storage
 * alone.
 */
type MutationParams = ProjectParams & { schedulePreview?: () => void };

/**
 * Redeploy the preview so the agent the user is looking at picks the change
 * up on its own. Clearing the stamp is what makes the deploy run at all — it
 * no-ops on a matching files hash. Production waits for a Publish.
 */
async function redeployPreview(env: ProjectSecretsEnv, params: MutationParams): Promise<void> {
  if (!params.schedulePreview) return;
  const workspace = await getWorkspace(env.workspaces, params.scope, params.project);
  if (workspace?.previewSlug === undefined) return;
  await stampWorkspaceMeta(env.workspaces, params.scope, params.project, {
    previewHash: undefined,
  });
  params.schedulePreview();
}

/**
 * Run `op` against every agent of the project this caller owns.
 * Returns null when the project itself does not exist (a 404), and an empty
 * list when it exists but has deployed nothing yet — writing secrets before a
 * first deploy reaches no agent TODAY, and the project record is what carries
 * it to the deploy that comes later.
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
  const held = Object.keys(await readProjectSecrets(env, params.scope, params.project));
  const byEnvironment = new Map(listed.map((entry) => [entry.environment, entry]));
  const environments: ProjectSecretsEnvironmentState[] = PROJECT_ENVIRONMENTS.map((environment) => {
    const entry = byEnvironment.get(environment);
    return entry === undefined
      ? { environment, vars: [] }
      : { environment, slug: entry.slug, vars: entry.result };
  });
  const vars = [...new Set([...environments.flatMap((e) => e.vars), ...held])].sort();
  // A name the project holds but some environment does not is waiting on that
  // environment's next deploy — including the environments that don't exist
  // yet, which is why an undeployed project reports everything as pending.
  const pending = held.filter((name) => environments.some((e) => !e.vars.includes(name))).sort();
  return { vars, environments, pending };
}

/**
 * Merge `updates` into the project's own record AND every agent it already
 * has. The record is written FIRST, in both this and
 * {@link deleteProjectSecret}, for the reason `setProjectDatabase` stamps its
 * flag first: a deploy racing this reads the record to decide what to inject,
 * so writing it last would let an update miss a deploy that landed in between
 * — and let a delete be undone by one.
 */
export async function setProjectSecrets(
  env: ProjectSecretsEnv,
  params: MutationParams & { updates: Record<string, string> },
): Promise<ProjectSecretsState | null> {
  const { scope, project } = params;
  const held = await readProjectSecrets(env, scope, project);
  await writeProjectSecrets(env, scope, project, { ...held, ...params.updates });
  const written = await overProjectAgents(env, params, (slug) =>
    setSlugSecrets(env, slug, params.updates),
  );
  if (written === null) return null;
  await redeployPreview(env, params);
  return projectSecretsState(env, params);
}

/** Drop `key` from the project's record and from every agent it has. */
export async function deleteProjectSecret(
  env: ProjectSecretsEnv,
  params: MutationParams & { key: string },
): Promise<ProjectSecretsState | null> {
  const { scope, project, key } = params;
  const { [key]: _dropped, ...rest } = await readProjectSecrets(env, scope, project);
  await writeProjectSecrets(env, scope, project, rest);
  const deleted = await overProjectAgents(env, params, (slug) => deleteSlugSecret(env, slug, key));
  if (deleted === null) return null;
  await redeployPreview(env, params);
  return projectSecretsState(env, params);
}

/**
 * Give a slug the deploy just claimed the secrets its project holds.
 *
 * This is what makes "save a secret" hold for an environment that did not
 * exist when it was saved — the common case, since the panel is reachable
 * from the moment a project is created and the preview agent is deployed by
 * the first edit. Called from the broker's one deploy path, so Publish and
 * the auto preview deploy are both covered by one hook.
 *
 * The project record is a FLOOR, never an override: a name the slug already
 * carries is left exactly as it is. Otherwise every deploy would reinstate
 * the studio's value over one set with `aai secret put` against that slug —
 * silently, and on a schedule nobody triggered. The panel's own writes reach
 * a live slug directly, so the floor only ever fills in what is missing.
 *
 * No ownership check: the deploy that just succeeded on the caller's key IS
 * the proof of ownership, matching `reconcileProjectDatabase`.
 */
export async function reconcileProjectSecrets(
  env: ProjectSecretsEnv,
  params: { scope: string; project: string; slug: string },
): Promise<void> {
  const held = await readProjectSecrets(env, params.scope, params.project);
  if (Object.keys(held).length === 0) return;
  await env.slugLock(params.slug, async () => {
    const existing = (await env.store.getEnv(params.slug)) ?? {};
    const merged = { ...held, ...existing };
    // Nothing to write when the slug already carries every name — a deploy of
    // an unchanged project is the common case.
    if (Object.keys(merged).length === Object.keys(existing).length) return;
    await env.store.putEnv(params.slug, merged);
    console.info("Project secrets applied to a newly deployed slug", {
      slug: params.slug,
      keyCount: Object.keys(merged).length - Object.keys(existing).length,
    });
  });
}
