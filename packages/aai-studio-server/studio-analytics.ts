// Copyright 2026 the AAI authors. MIT license.
/**
 * A project's analytics: the default view behind the Analytics pane, and the
 * ad-hoc SQL surface behind the coding agent's `query_analytics` tool.
 *
 * ## A project is two agents, and both count
 *
 * Every read here resolves the project's PRODUCTION and PREVIEW slugs and
 * queries both — the same rule the database and secrets switches follow. It
 * matters more here than there: the preview agent is the one a user talks to
 * while building, so scoping to production alone would show an empty pane to
 * exactly the person who just finished testing their agent, and scoping
 * without distinguishing them would let preview experiments pollute the
 * production numbers. Rows carry their own `slug`, so the pane can separate
 * them and the summary counts both.
 *
 * ## Ownership is checked per slug, never assumed from the workspace
 *
 * A workspace document is a file the user can write, `deployedSlug` included.
 * So naming a slug in it is a CLAIM, and reading analytics for a claimed slug
 * without checking would make this an oracle for other tenants' transcripts —
 * the same reasoning that puts `verifySlugOwner` in the project DELETE
 * cascade. Every slug is verified against the caller's key before a single
 * row is read.
 */

import { errorMessage } from "@alexkroman1/aai";
import { buildScopedAnalyticsQuery, validateAnalyticsSql } from "aai-server/analytics-query";
import type { AnalyticsQueryResult, AnalyticsStore } from "aai-server/analytics-store";
import { type AnalyticsSummary, summarize } from "aai-server/analytics-summary";
import type { BundleStore } from "aai-server/store-types";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { ownedProjectSlugs } from "./studio-project-slugs.ts";
import { getWorkspace } from "./studio-workspace.ts";

/** Retention window; must match the pg_cron sweep (`ANALYTICS_RETENTION_DAYS`). */
export const ANALYTICS_WINDOW_DAYS = 7;

/** How many log lines the default view carries. */
const LOG_TAIL_LIMIT = 100;

export type ProjectAnalyticsEnv = {
  workspaces: WorkspaceStore;
  store: BundleStore;
  analytics?: { store: AnalyticsStore } | undefined;
};

export type ProjectAnalyticsRequest = {
  scope: string;
  project: string;
  apiKey: string;
};

/** What the pane renders. `slugs` is empty for a project that never deployed. */
export type ProjectAnalytics = AnalyticsSummary & {
  /** The verified slugs these numbers cover, production first. */
  slugs: string[];
  /** Present when the deployment has no analytics store configured. */
  unavailable?: string;
};

/**
 * The project's two slugs, filtered to the ones this caller actually owns —
 * `null` when the project does not exist, which is the route's 404.
 *
 * The resolution itself is `studio-project-slugs.ts`, shared with the
 * database and secrets switches: a project is two agents, and that fact has
 * been rediscovered per feature before. An unowned or unclaimed slug is
 * dropped there rather than raising — the common case is a `deployedSlug`
 * whose agent was deleted, and a 403 for that would make an ordinary project
 * look broken.
 */
export async function analyticsSlugs(
  env: ProjectAnalyticsEnv,
  req: ProjectAnalyticsRequest,
): Promise<string[] | null> {
  const workspace = await getWorkspace(env.workspaces, req.scope, req.project);
  if (!workspace) return null;
  const owned = await ownedProjectSlugs(env.store, req.apiKey, workspace);
  return owned.map((entry) => entry.slug);
}

/**
 * The default view. Returns `null` when the project does not exist — the
 * route's 404 — and an `unavailable` summary when the deployment has no
 * analytics store, which is deliberately NOT the same as "no traffic": a pane
 * that renders zeroes for a feature that is switched off tells the user their
 * agent has no users.
 */
export async function projectAnalytics(
  env: ProjectAnalyticsEnv,
  req: ProjectAnalyticsRequest,
): Promise<ProjectAnalytics | null> {
  const slugs = await analyticsSlugs(env, req);
  if (slugs === null) return null;

  // Built only on the paths that answer with it: the common path summarizes
  // real rows, and this one allocates six maps and four percentile passes.
  const empty = (): AnalyticsSummary =>
    summarize({ rows: [], logs: [], windowDays: ANALYTICS_WINDOW_DAYS });
  if (!env.analytics) {
    return { ...empty(), slugs, unavailable: "Analytics is not enabled on this deployment." };
  }
  if (slugs.length === 0) return { ...empty(), slugs };

  const sinceMs = Date.now() - ANALYTICS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const [rows, logs] = await Promise.all([
    env.analytics.store.summaryRows({ slugs, sinceMs }),
    env.analytics.store.logs({ slugs, sinceMs, limit: LOG_TAIL_LIMIT }),
  ]);
  return { ...summarize({ rows, logs, windowDays: ANALYTICS_WINDOW_DAYS }), slugs };
}

export type AnalyticsQueryOutcome =
  | { ok: true; result: AnalyticsQueryResult; slugs: string[] }
  /** A refusal the CALLER can fix by rewriting the query. */
  | { ok: false; error: string };

/**
 * Run one model-authored statement against this project's rows.
 *
 * The validation and the scoping wrapper both live in `aai-server`
 * (`analytics-query.ts`) and are documented there. What is decided HERE is
 * narrower and is the part specific to a project: which slugs the `events`
 * CTE is bound to, and that they are the caller's own.
 */
export async function runProjectAnalyticsQuery(
  env: ProjectAnalyticsEnv,
  req: ProjectAnalyticsRequest & { sql: string; limit?: number },
): Promise<AnalyticsQueryOutcome | null> {
  const slugs = await analyticsSlugs(env, req);
  if (slugs === null) return null;
  if (!env.analytics) {
    return { ok: false, error: "Analytics is not enabled on this deployment." };
  }

  // Validated BEFORE the empty-slug shortcut, so a malformed query is
  // reported as malformed rather than as an empty result — an agent told
  // "no rows" would go looking for the missing data instead of the typo.
  const invalid = validateAnalyticsSql(req.sql);
  if (invalid) return { ok: false, error: invalid };
  if (slugs.length === 0) {
    return { ok: true, result: { columns: [], rows: [], truncated: false }, slugs };
  }

  const scoped = buildScopedAnalyticsQuery({
    sql: req.sql,
    slugs,
    retentionDays: ANALYTICS_WINDOW_DAYS,
    ...(req.limit === undefined ? {} : { limit: req.limit }),
  });
  try {
    // The slugs ride along separately from the wrapper's own filter: they are
    // what the RLS policy on `agent_events` is applied with, so the scoping
    // holds even for a statement that got around the CTE.
    const result = await env.analytics.store.runScoped({ ...scoped, slugs });
    return { ok: true, result, slugs };
  } catch (err) {
    // A database error here is nearly always the model's SQL — an unknown
    // column, a type mismatch, a bad aggregate — so the message goes BACK to
    // it rather than becoming a 500 it cannot learn from. Nothing in it names
    // anything the caller does not already have: the statement is its own,
    // and the wrapper only adds its slugs.
    return { ok: false, error: errorMessage(err) };
  }
}
