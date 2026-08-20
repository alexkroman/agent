// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading what a project's agents have STORED — the table list and one page of
 * rows behind the studio's Database pane.
 *
 * Its own module beside `studio-database.ts`, which is about the switch: that
 * file provisions, drops and reconciles, and everything here is a read of a
 * tenant's own rows. The SQL is aai-server's (`app-db-browse.ts`, reached
 * through `storageTables` / `storageTableRows`); what this adds is the studio's
 * own two questions — WHICH agent, and may this caller read it.
 *
 * **An environment is named by the caller and resolved here.** A project is two
 * deployed agents with two separate schemas, and which one somebody is looking
 * at is the whole difference between "my tool saved nothing" and "my tool saved
 * it in the preview". The pane therefore asks for one by name and this answers
 * for exactly that one — never a silent fallback to the other, which would show
 * production's rows under a preview heading.
 *
 * **Ownership is checked the same way every other project route checks it**
 * (`ownedProjectSlugs` → the agents row's credential hashes): a workspace
 * naming a foreign slug must not become a reader of someone else's data, which
 * is a sharper version of the rule the database switch already follows, because
 * this returns the rows themselves rather than a count.
 */

import type { AppTable, AppTablePage, ReadAppTableParams } from "aai-server/app-db-browse";
import { storageTableRows, storageTables } from "aai-server/storage-handler";
import { type ProjectDatabaseEnv, storageEnvOf } from "./studio-database.ts";
import { ownedProjectSlugs, type ProjectEnvironment } from "./studio-project-slugs.ts";
import { getWorkspace, type StudioWorkspace } from "./studio-workspace.ts";

/** What a browse read needs to name its target. */
export type BrowseParams = {
  scope: string;
  project: string;
  apiKey: string;
  environment: ProjectEnvironment;
};

/** The tables one environment holds, plus which agent answered. */
export type ProjectTables = { environment: ProjectEnvironment; slug: string; tables: AppTable[] };

/**
 * The slug of one environment, when it exists and the caller owns it.
 *
 * `undefined` covers three different situations on purpose — the environment
 * has never deployed, the caller does not own the slug, or the project is gone
 * — because a reader is entitled to none of them: telling an unauthorized
 * caller apart from an undeployed environment is an ownership oracle over the
 * slug namespace, and the pane's answer ("nothing to read here") is the same
 * either way.
 */
async function ownedSlugFor(
  env: ProjectDatabaseEnv,
  params: BrowseParams,
  workspace: StudioWorkspace,
): Promise<string | undefined> {
  const owned = await ownedProjectSlugs(env.store, params.apiKey, workspace);
  return owned.find((entry) => entry.environment === params.environment)?.slug;
}

/** Load the workspace and resolve the requested environment's owned slug. */
async function resolveTarget(
  env: ProjectDatabaseEnv,
  params: BrowseParams,
): Promise<string | undefined> {
  const workspace = await getWorkspace(env.workspaces, params.scope, params.project);
  if (!workspace) return undefined;
  return ownedSlugFor(env, params, workspace);
}

/**
 * Every table in one environment's database.
 *
 * `null` when there is nothing to read — no such project, an environment that
 * has not deployed, a slug the caller does not own, or storage switched off.
 * The route answers 404 for all of them, which is the same statement the pane
 * makes: this environment has no database to show you.
 */
export async function projectTables(
  env: ProjectDatabaseEnv,
  params: BrowseParams,
): Promise<ProjectTables | null> {
  const slug = await resolveTarget(env, params);
  if (slug === undefined) return null;
  const tables = await storageTables(storageEnvOf(env), slug);
  if (tables === null) return null;
  return { environment: params.environment, slug, tables };
}

/** One page of one table, or `null` under the same four conditions as above. */
export async function projectTableRows(
  env: ProjectDatabaseEnv,
  params: BrowseParams & ReadAppTableParams,
): Promise<AppTablePage | null> {
  const slug = await resolveTarget(env, params);
  if (slug === undefined) return null;
  return storageTableRows(storageEnvOf(env), slug, {
    schema: params.schema,
    table: params.table,
    limit: params.limit,
    offset: params.offset,
  });
}
