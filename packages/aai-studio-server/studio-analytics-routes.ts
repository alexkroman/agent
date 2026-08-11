// Copyright 2026 the AAI authors. MIT license.
/**
 * HTTP surface of a project's analytics, mounted under
 * `/studio/projects/:project` by studio-routes.ts:
 *
 * - `GET  …/analytics`       — the default view the Analytics pane renders
 * - `POST …/analytics/query` — one read-only SQL statement over the project's
 *   own rows, which is what the coding agent's `query_analytics` tool calls
 *
 * Both authenticate as every other project route does (the caller's own
 * bearer, scope-resolved by the `/projects/:project` middleware) and then
 * check slug ownership inside `studio-analytics.ts`.
 *
 * **A refused query is 200, not 4xx.** The caller is usually an LLM: the
 * refusal is a message it should read and act on ("you may not name
 * `pg_catalog`; select from `events`"), and the guest's tool layer turns a
 * non-2xx into a thrown error whose text the model sees far less reliably
 * than a result body. A malformed REQUEST — no `sql` field at all — is still
 * a 400, because that one is the caller's bug rather than the model's.
 */

import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import {
  type ProjectAnalyticsEnv,
  projectAnalytics,
  runProjectAnalyticsQuery,
} from "./studio-analytics.ts";
import type { StudioHonoEnv } from "./studio-context.ts";

const QueryBodySchema = z.object({
  sql: z.string().min(1).max(4000),
  /**
   * CLAMPED, not rejected — `buildScopedAnalyticsQuery` already does
   * `Math.min(limit, ANALYTICS_QUERY_ROW_CAP)`, and the result says
   * `truncated: true`.
   *
   * A `.max(ANALYTICS_QUERY_ROW_CAP)` here turned an over-large limit into a
   * 400 the guest's tool layer surfaces to the model as an opaque `HTTP 400`,
   * while the tool's own description promised "capped server-side" — so the
   * caller was told the number would be clamped and then rejected for it.
   * Clamping is also the more useful answer: rows plus a truncation flag beats
   * an error the model has to guess its way out of.
   */
  limit: z.number().int().positive().optional(),
});

/** Bindings read off the REQUEST env, matching `databaseEnvFor`'s reasoning. */
function analyticsEnvFor(c: { env: StudioHonoEnv["Bindings"] }): ProjectAnalyticsEnv {
  return {
    workspaces: c.env.workspaces,
    store: c.env.store,
    ...(c.env.analytics && { analytics: c.env.analytics }),
  };
}

export function registerAnalyticsRoutes(studio: Hono<StudioHonoEnv>): void {
  studio.get("/projects/:project/analytics", async (c) => {
    const { scope, project } = c.var;
    const summary = await projectAnalytics(analyticsEnvFor(c), {
      scope,
      project,
      apiKey: c.var.apiKey,
    });
    if (!summary) return c.json({ error: "Project not found" }, 404);
    return c.json(summary);
  });

  studio.post(
    "/projects/:project/analytics/query",
    zValidator("json", QueryBodySchema),
    async (c) => {
      const { scope, project } = c.var;
      const body = c.req.valid("json");
      const outcome = await runProjectAnalyticsQuery(analyticsEnvFor(c), {
        scope,
        project,
        apiKey: c.var.apiKey,
        sql: body.sql,
        ...(body.limit === undefined ? {} : { limit: body.limit }),
      });
      if (!outcome) return c.json({ error: "Project not found" }, 404);
      if (!outcome.ok) return c.json({ error: outcome.error });
      return c.json({
        slugs: outcome.slugs,
        columns: outcome.result.columns,
        rows: outcome.result.rows,
        truncated: outcome.result.truncated,
      });
    },
  );
}
