// Copyright 2026 the AAI authors. MIT license.
/**
 * A project's secrets, across BOTH of its deployed agents — and before either
 * of them exists.
 *
 * The per-slug routes (`/:slug/secret`, what `aai secret` drives) stay the
 * platform primitive; this is the project-level switch over them. It had a
 * sibling, `studio-database.ts`, doing the same for `ctx.db`; that went with
 * per-app databases, so this is the only one left. The fan-out
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

import { createLogger } from "aai-server/logger";
import {
  deleteSlugSecret,
  listSlugSecrets,
  type SecretEnv,
  setSlugSecrets,
} from "aai-server/secret-handler";
import type { SecretStore } from "aai-server/secret-store";
import type { BundleStore } from "aai-server/store-types";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { z } from "zod";
import { forcePreviewRedeploy } from "./studio-preview.ts";
import {
  ownedProjectSlugs,
  PROJECT_ENVIRONMENTS,
  type ProjectEnvironment,
} from "./studio-project-slugs.ts";
import { readJsonSecret, writeJsonSecret } from "./studio-secret-record.ts";
import { getWorkspace, type StudioWorkspace } from "./studio-workspace.ts";

const log = createLogger("studio.secrets");

export type ProjectSecretsEnv = SecretEnv & {
  workspaces: WorkspaceStore;
  store: BundleStore;
  /** Where the project's own copy lives (see the module doc). */
  secrets: SecretStore;
};

/**
 * SecretStore name for a project's own secret record — the sibling of
 * `agent-env:<slug>`, keyed by (scope, project) because
 * that pair is what identifies a project and neither half is guessable from
 * outside the owning account (`scope` is a SHA-256).
 */
export function projectEnvSecretName(scope: string, project: string): string {
  return `studio-project-env:${scope}:${project}`;
}

/**
 * What a project's stored record must look like.
 *
 * A SCHEMA rather than `isRecord` plus a cast, which is what this read used to
 * do: `isRecord` narrows the container and says nothing about the values, so a
 * document with a nested object in it was asserted to be
 * `Record<string, string>` and merged straight into `store.putEnv`.
 */
const ProjectSecretsSchema = z.record(z.string(), z.string());

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
  const name = projectEnvSecretName(scope, project);
  return (await readJsonSecret(env.secrets, name, ProjectSecretsSchema)) ?? {};
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
  else await writeJsonSecret(env.secrets, name, values);
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
 * up on its own. Production waits for a Publish.
 *
 * `forcePreviewRedeploy` (studio-preview.ts) owns the clear-then-schedule
 * pair: clearing the stamp is what makes the deploy run at all, since it
 * no-ops on a matching files hash and a saved secret changes no file.
 */
function redeployPreview(
  env: ProjectSecretsEnv,
  params: MutationParams,
  project: ResolvedProject,
): Promise<void> {
  const schedule = params.schedulePreview;
  if (!schedule || project.workspace.previewSlug === undefined) return Promise.resolve();
  return forcePreviewRedeploy(env.workspaces, params.scope, params.project, schedule);
}

/**
 * The project as every path here needs it: the workspace row, and the slugs of
 * its agents this caller owns.
 *
 * Resolved ONCE per request and threaded, because each of the three steps of a
 * mutation used to resolve it again — the record write, the per-slug fan-out,
 * the preview redeploy, and then the state read that answers the request —
 * which cost three workspace reads and two ownership fan-outs for one PUT.
 *
 * Null means the project does not exist (a 404). An empty `targets` means it
 * exists and has deployed nothing yet: writing secrets before a first deploy
 * reaches no agent TODAY, and the project record is what carries them to the
 * deploy that comes later.
 */
type ResolvedProject = {
  workspace: StudioWorkspace;
  targets: { environment: ProjectEnvironment; slug: string }[];
};

async function resolveProject(
  env: ProjectSecretsEnv,
  params: ProjectParams,
): Promise<ResolvedProject | null> {
  const workspace = await getWorkspace(env.workspaces, params.scope, params.project);
  if (!workspace) return null;
  return { workspace, targets: await ownedProjectSlugs(env.store, params.apiKey, workspace) };
}

/** Run `op` against every agent of the project this caller owns. */
function overProjectAgents<T>(
  project: ResolvedProject,
  op: (slug: string, environment: ProjectEnvironment) => Promise<T>,
): Promise<{ environment: ProjectEnvironment; slug: string; result: T }[]> {
  // The agents are independent stores under independent per-slug locks.
  return Promise.all(
    project.targets.map(async ({ environment, slug }) => ({
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
  known: {
    /** The already-resolved project, when the caller has one (a mutation). */
    resolved?: ResolvedProject;
    /**
     * The project's record, when the caller just WROTE it. A mutation knows
     * exactly what it stored, so re-reading it here was a Vault round trip
     * asking a question the caller had already answered.
     */
    record?: Record<string, string>;
  } = {},
): Promise<ProjectSecretsState | null> {
  const project = known.resolved ?? (await resolveProject(env, params));
  if (project === null) return null;
  // Independent reads — the per-agent listing and the project's own record
  // touch different stores, and this runs on the panel's GET as well as after
  // every mutation.
  const [listed, record] = await Promise.all([
    overProjectAgents(project, (slug) => listSlugSecrets(env, slug)),
    known.record ?? readProjectSecrets(env, params.scope, params.project),
  ]);
  const held = Object.keys(record);
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
 * The sequence EVERY secret mutation runs, spelled once — because the order is
 * the invariant, and both of its steps are a hazard that was got wrong before.
 *
 * The record is written FIRST, for the reason `setProjectDatabase` stamps its
 * flag first: a deploy racing this reads the record to decide what to inject,
 * so writing it last would let an update miss a deploy that landed in between
 * — and let a delete be undone by one.
 *
 * **The project's EXISTENCE is checked ahead of that write**, which is a
 * different ordering question and used to be the wrong way round: the record
 * went in unconditionally and the 404 came from `overProjectAgents` three
 * statements later, so a PUT (or DELETE) against a project that does not exist
 * answered 404 having already written a Vault record under that name. Nothing
 * cascades it — the delete cascade only runs for a project that exists — so a
 * later project taking that name inherited a stranger's values on its first
 * deploy. Resolving first costs nothing: the mutation needs the workspace and
 * its owned slugs anyway.
 *
 * Only the CHANGE differs between the two callers below — what the project's
 * record becomes, and the same change against one deployed agent.
 *
 * @returns the resulting state, or null when the project does not exist.
 */
async function mutateProjectSecrets(
  env: ProjectSecretsEnv,
  params: MutationParams,
  change: {
    /** The project's own record after the change. */
    record: (held: Record<string, string>) => Record<string, string>;
    /** The same change applied to one of the project's deployed agents. */
    perAgent: (slug: string) => Promise<unknown>;
  },
): Promise<ProjectSecretsState | null> {
  const { scope, project } = params;
  // Concurrent because nothing connects them: resolving the project reads the
  // workspace and fans out over its slugs, the held record is a Vault read.
  // The WRITE still waits for both, so the resolve-before-write ordering the
  // block above argues for is unchanged.
  const [resolved, held] = await Promise.all([
    resolveProject(env, params),
    readProjectSecrets(env, scope, project),
  ]);
  if (resolved === null) return null;
  const record = change.record(held);
  await writeProjectSecrets(env, scope, project, record);
  await overProjectAgents(resolved, change.perAgent);
  await redeployPreview(env, params, resolved);
  return projectSecretsState(env, params, { resolved, record });
}

/**
 * Merge `updates` into the project's own record AND every agent it already
 * has — see {@link mutateProjectSecrets} for the ordering both mutations obey.
 */
export function setProjectSecrets(
  env: ProjectSecretsEnv,
  params: MutationParams & { updates: Record<string, string> },
): Promise<ProjectSecretsState | null> {
  return mutateProjectSecrets(env, params, {
    record: (held) => ({ ...held, ...params.updates }),
    perAgent: (slug) => setSlugSecrets(env, slug, params.updates),
  });
}

/** Drop `key` from the project's record and from every agent it has. */
export function deleteProjectSecret(
  env: ProjectSecretsEnv,
  params: MutationParams & { key: string },
): Promise<ProjectSecretsState | null> {
  return mutateProjectSecrets(env, params, {
    record: ({ [params.key]: _dropped, ...rest }) => rest,
    perAgent: (slug) => deleteSlugSecret(env, slug, params.key),
  });
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
    log.info("applied to a newly deployed slug", {
      slug: params.slug,
      keyCount: Object.keys(merged).length - Object.keys(existing).length,
    });
  });
}
