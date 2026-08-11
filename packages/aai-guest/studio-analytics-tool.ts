// Copyright 2026 the AAI authors. MIT license.
/**
 * `query_analytics` — the coding agent's read-only SQL access to how its own
 * agent behaves in production.
 *
 * ## Why SQL rather than a metrics API
 *
 * The pane's default view answers the questions someone anticipated. The
 * questions an agent's author actually has are shaped by the agent — "which
 * tool fails for callers who mention refunds", "do sessions that hit
 * `check_stock` end sooner", "did p95 latency move after the last publish" —
 * and no fixed endpoint enumerates those. A table plus a `GROUP BY` does. The
 * model is a competent SQL writer; what it needs is a schema it can trust and
 * a refusal it can learn from, both of which are below.
 *
 * ## The guest holds no privilege here
 *
 * The tool does NOT reach a database. It posts to the platform's own
 * `/studio/projects/:project/analytics/query` on the caller's own API key —
 * the same credential, the same route, and the same slug-ownership check the
 * browser's pane goes through. Validation and slug scoping happen there
 * (`aai-server/analytics-query.ts`), server-side, where a compromised guest
 * cannot skip them. This module is a well-described HTTP call.
 */

import { errorMessage } from "@alexkroman1/aai";
import { type ToolSet, tool } from "ai";
import { z } from "zod";

/** Cap on what one tool result may carry back into the model's context. */
const MAX_RESULT_CHARS = 20_000;
const DEFAULT_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The schema the model is handed. Written as prose rather than DDL because
 * the model has to know what each `kind` MEANS — `agent_turn.duration_ms` is
 * the whole turn while `data->>'firstAudioMs'` is the part the caller spent
 * in silence, and no column list conveys that.
 */
export const ANALYTICS_SCHEMA_DOC = `Read-only SQL over this project's live session analytics.

Select from the table \`events\` — already scoped to this project's deployed
agents (production and preview) and to the last 7 days, which is the full
retention window.

Columns:
  slug           text        which agent (production, or the \`-preview\` one)
  agent_version  bigint      deploy generation — group by this to compare releases
  session_id     text        one conversation; join rows by it to reconstruct one
  ts             timestamptz when it happened
  kind           text        see below
  turn           int         1-based user-turn number within the session (0 = before the first)
  duration_ms    int         elapsed time, meaning depends on kind
  level          text        log level, for kind='log'
  name           text        tool name / error code / agent name / session end reason
  body           text        transcript, error message, tool result, or log message
  ok             boolean     tool succeeded; agent_turn completed (NULL = abandoned)
  data           jsonb       kind-specific extras

Kinds:
  session_start  a session began.       name = agent name
  session_end    a session ended.       duration_ms = session length,
                                        name = end reason (e.g. idle_timeout),
                                        data = {turns, errors, tools}
  user_turn      the user's committed transcript. body = what they said
  agent_turn     one reply.             duration_ms = user finished → reply done,
                                        data->>'firstAudioMs' = user finished → FIRST AUDIO
                                        (the silence the caller actually heard — the
                                        latency metric that matters),
                                        ok = true completed / false the caller barged in
                                        / NULL the session ended mid-reply
                                        (data->>'abandoned'), which is NOT a barge-in,
                                        body = what the agent said
  tool_call      one tool execution.    name = tool, duration_ms = how long,
                                        ok = whether it succeeded, body = the result
  barge_in       the caller interrupted the agent while it was speaking
  error          a session error.       name = code (stt|llm|tts|tool|protocol|
                                        connection|audio|internal), body = message
  log            a runtime log line.    level + body

Rules: one SELECT (or WITH … SELECT) statement, no semicolons, no other tables
or schemas. Rows are capped at ${DEFAULT_LIMIT} unless you pass a higher limit.

Examples:
  select count(*) from events where kind = 'session_start'
  select percentile_disc(0.95) within group (order by (data->>'firstAudioMs')::int)
    from events where kind = 'agent_turn' and data ? 'firstAudioMs'
  select name, count(*) filter (where not ok) as failures, count(*) as calls
    from events where kind = 'tool_call' group by name order by failures desc`;

export type AnalyticsToolDeps = {
  /** Platform public origin; absent means the tool is not offered at all. */
  serverUrl?: string | undefined;
  project: string;
  /** The caller's own API key — the same bearer the browser's pane uses. */
  apiKey: string;
  /** Test seam. */
  fetchImpl?: typeof globalThis.fetch;
};

type QueryResponse = {
  error?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  slugs?: string[];
};

/** Render rows as compact JSON lines — the densest form a model reads well. */
function renderRows(body: QueryResponse): string {
  const rows = body.rows ?? [];
  if (rows.length === 0) {
    return "No rows. (If you expected data: this project's agents may have had no traffic in the last 7 days.)";
  }
  const lines = rows.map((row) => JSON.stringify(row));
  let out = lines.join("\n");
  if (out.length > MAX_RESULT_CHARS) {
    // Whole lines only: half a JSON object is worse than fewer rows.
    const kept: string[] = [];
    let size = 0;
    for (const line of lines) {
      if (size + line.length > MAX_RESULT_CHARS) break;
      kept.push(line);
      size += line.length + 1;
    }
    out = `${kept.join("\n")}\n… ${rows.length - kept.length} more rows omitted (add a LIMIT or aggregate).`;
  }
  return body.truncated
    ? `${out}\n(Result truncated at the row cap — aggregate or add a LIMIT.)`
    : out;
}

/**
 * Build the tool, or nothing when the platform origin is unknown — a tool
 * that cannot reach its endpoint is worse than an absent one: the model
 * spends steps retrying and reports the absence of data as a finding.
 */
export function createAnalyticsTools(deps: AnalyticsToolDeps): ToolSet {
  const { serverUrl } = deps;
  if (!serverUrl) return {};
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  return {
    query_analytics: tool({
      description: ANALYTICS_SCHEMA_DOC,
      inputSchema: z.object({
        sql: z.string().describe("One SELECT (or WITH … SELECT) statement over `events`"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          // No figure: the cap lives in aai-server (`ANALYTICS_QUERY_ROW_CAP`)
          // and this package must not import from there, so a number written
          // here is a second copy that drifts — it already had, naming 1000
          // against a schema that rejected anything over 999.
          .describe(
            `Max rows (default ${DEFAULT_LIMIT}). Larger values are clamped server-side; ` +
              "check `truncated` in the result.",
          ),
      }),
      execute: async ({ sql, limit }) => {
        const url = `${serverUrl.replace(/\/+$/, "")}/studio/projects/${encodeURIComponent(deps.project)}/analytics/query`;
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${deps.apiKey}`,
            },
            body: JSON.stringify({ sql, limit: limit ?? DEFAULT_LIMIT }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          return `Analytics request failed: ${errorMessage(err)}`;
        }
        if (!res.ok) return `Analytics request failed: HTTP ${res.status}`;
        const body = (await res.json()) as QueryResponse;
        // A refusal comes back 200 with an `error` message on purpose — it is
        // addressed to the model and it is actionable (see the routes module).
        if (body.error) return `Query rejected: ${body.error}`;
        return renderRows(body);
      },
    }),
  };
}
