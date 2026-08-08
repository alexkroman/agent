// Copyright 2026 the AAI authors. MIT license.
/**
 * A project is TWO deployed agents — production and preview — and everything
 * configured per project has to reach both.
 *
 * That fact was rediscovered per feature: the database switch resolved the
 * pair server-side while the Secrets panel fanned out in the BROWSER, which
 * meant `aai secret put` and `aai publish`'s `.env` sync reached production
 * only. A preview agent missing a provider key fails at its first session
 * while production works, so it reads as a broken preview rather than a
 * missing secret — and the CLI could create that preview (a push schedules
 * one) without any way to configure it.
 *
 * So the pair lives here, once, and every project-level surface resolves it
 * the same way.
 */

import { verifySlugOwner } from "aai-server/secrets";
import type { BundleStore } from "aai-server/store-types";
import type { StudioWorkspace } from "./studio-workspace.ts";

/** The two agents a project deploys. */
export const PROJECT_ENVIRONMENTS = ["production", "preview"] as const;

export type ProjectEnvironment = (typeof PROJECT_ENVIRONMENTS)[number];

/** The slug an environment's agent runs under, once it has one. */
export function projectSlugFor(
  workspace: StudioWorkspace,
  environment: ProjectEnvironment,
): string | undefined {
  return environment === "production" ? workspace.deployedSlug : workspace.previewSlug;
}

/**
 * Ownership of a slug the workspace names, checked against the agents row's
 * credential hashes rather than project scope alone — the same rule the
 * project delete cascade follows, for the same reason: a workspace naming a
 * slug the caller does not own (however it got there) must not become an
 * oracle for, or a lever on, someone else's agent.
 */
export async function ownsProjectSlug(
  store: BundleStore,
  apiKey: string,
  slug: string,
): Promise<boolean> {
  const owner = await verifySlugOwner(apiKey, { slug, store });
  return owner.status === "owned";
}

/**
 * The slugs of a project's agents this caller owns, in environment order.
 * A slug that does not exist yet, or that belongs to someone else, is simply
 * absent — never an error, and never reported as belonging to the project.
 */
export async function ownedProjectSlugs(
  store: BundleStore,
  apiKey: string,
  workspace: StudioWorkspace,
): Promise<{ environment: ProjectEnvironment; slug: string }[]> {
  const candidates = PROJECT_ENVIRONMENTS.map((environment) => ({
    environment,
    slug: projectSlugFor(workspace, environment),
  })).filter(
    (entry): entry is { environment: ProjectEnvironment; slug: string } => entry.slug !== undefined,
  );
  const owned = await Promise.all(
    candidates.map(({ slug }) => ownsProjectSlug(store, apiKey, slug)),
  );
  return candidates.filter((_, i) => owned[i]);
}
