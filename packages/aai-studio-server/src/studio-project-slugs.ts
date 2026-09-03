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

import { hash } from "node:crypto";
import { MAX_SLUG_LENGTH, PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/internal";
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

/** Hex digits of the name digest a truncated preview slug carries. */
const PREVIEW_NAME_DIGEST = 8;

/**
 * The slug a project's PREVIEW agent claims when it has none yet:
 * `<project>-preview`, shortened to fit the platform's 64-character slug
 * shape.
 *
 * Beside {@link projectSlugFor} because the two answer the same question from
 * the two sides — what a project's agents are CALLED — and this half is the
 * only one that has to invent a name.
 *
 * **Shortening is by digest, not by truncation, because the names are not
 * unique in their first 56 characters.** `ProjectNameSchema` admits the full
 * 64, so `<56 shared chars>-alpha` and `<56 shared chars>-beta` both used to
 * reduce to one preview slug: both deploys succeed (same account, so no
 * ownership 409), both stamp their own `previewHash`, and ONE agent then
 * serves both Preview panes, each showing the other project's work with no
 * error anywhere. The old comment argued the collision was as unlikely as for
 * the production slug because names are suffix-randomized server-side — true
 * of generated names, and `aai push` and the create body both accept an
 * explicit one. Spending the last 9 characters on a digest of the WHOLE name
 * makes the shortened form injective in practice, for the same reason the
 * random suffix does.
 *
 * Only NEW previews are affected: once a preview has deployed, its slug is
 * stamped on the workspace (`previewSlug`) and that stamp is what every later
 * deploy reuses.
 */
export function previewSlugFor(project: string): string {
  // Suffix shared with the sandbox-tag inference (`roleForSlug`), so preview
  // deploys and the "preview" role in Modal's dashboard can't drift.
  const budget = MAX_SLUG_LENGTH - PREVIEW_SLUG_SUFFIX.length;
  if (project.length <= budget) return `${project}${PREVIEW_SLUG_SUFFIX}`;
  const digest = hash("sha256", project, "hex").slice(0, PREVIEW_NAME_DIGEST);
  // Trailing separators are trimmed so the join can never read `--` or `_-`,
  // which is legal in a slug but reads as a truncation artifact.
  const base = project.slice(0, budget - PREVIEW_NAME_DIGEST - 1).replace(/[-_]+$/, "");
  return `${base}-${digest}${PREVIEW_SLUG_SUFFIX}`;
}

/**
 * Ownership of a slug the workspace names, checked against the agents row's
 * credential hashes rather than project scope alone — the same rule the
 * project delete cascade follows, for the same reason: a workspace naming a
 * slug the caller does not own (however it got there) must not become an
 * oracle for, or a lever on, someone else's agent.
 *
 * Module-private now: every caller wants the PAIR, and asking per slug is what
 * had the database switch resolving ownership twice per request (once
 * sequentially). {@link ownedProjectSlugs} is the answer to reach for.
 */
async function ownsProjectSlug(store: BundleStore, apiKey: string, slug: string): Promise<boolean> {
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
