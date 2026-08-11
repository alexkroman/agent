// Copyright 2026 the AAI authors. MIT license.
/**
 * The guard around model-authored SQL, and the aggregation behind the
 * studio's default Analytics view.
 *
 * ## The threat, stated precisely
 *
 * `query_analytics` hands an LLM a SQL prompt against the platform's own
 * Postgres, over the connection that OWNS every control-plane table. The
 * statement is untrusted in the strict sense — a prompt-injected coding agent
 * is a realistic author of it — so "the model probably won't" is not part of
 * the design. Three independent things have to hold, and none of them is a
 * keyword blocklist on its own:
 *
 * 1. **The user's statement can only NAME one relation.** Everything runs
 *    wrapped in a CTE called `events`, already filtered to the caller's own
 *    slugs. Reaching a platform table needs a schema qualifier, because
 *    `aai_platform` is not on the connection's `search_path` — every store in
 *    this package writes `aai_platform.x` in full, and that is why. So
 *    `select * from studio_workspaces` does not resolve to anything; it
 *    errors. {@link validateAnalyticsSql} then rejects the qualified spelling.
 * 2. **`pg_catalog` IS always on the search path**, which is the real hole a
 *    CTE wrapper leaves open: `pg_authid`, `pg_read_file`, `pg_settings` are
 *    all reachable unqualified. Every `pg_`-prefixed identifier is rejected
 *    for that reason, not as generic hygiene.
 * 3. **Only one statement, and only a reading one.** A trailing `;` plus a
 *    second statement would escape the wrapper entirely, and a data-modifying
 *    CTE (`with x as (delete from …)`) is legal SQL inside a `with`.
 *
 * The validator is deliberately a REJECT-list over a tokenized statement
 * rather than a parser: a SQL parser here would be a bigger thing to trust
 * than the surface it guards, and every rejection is recoverable — the model
 * is told what it may not do and writes the query again. What it cannot be is
 * ADVISORY, so the wrapper is applied unconditionally and the validator runs
 * before it, never instead of it.
 *
 * What this does NOT claim: it is not a substitute for a read-only role. The
 * statement runs on the platform's own connection, so a hole in these rules
 * is a hole in the control plane, not merely in analytics. A dedicated
 * `aai_analytics_reader` login role with `select` on exactly this table is
 * the structural fix, and it is the follow-up recorded in
 * `packages/aai-server/CLAUDE.md`.
 */

import {
  ANALYTICS_QUERY_ROW_CAP,
  type LogRow,
  SUMMARY_ROW_CAP,
  type SummaryRow,
} from "./analytics-store.ts";

/** Schemas and identifier prefixes a scoped query may never name. */
const FORBIDDEN_IDENTIFIERS = [
  "aai_platform",
  "information_schema",
  "vault",
  "cron",
  "pgmq",
  "storage",
  "auth",
  "extensions",
  "realtime",
];

/**
 * Statement kinds that may not appear ANYWHERE — including inside a `with`,
 * where Postgres happily accepts a data-modifying CTE.
 */
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "execute",
  "vacuum",
  "analyze",
  "set",
  "reset",
  "listen",
  "notify",
  "lock",
  "begin",
  "commit",
  "rollback",
  "prepare",
  "refresh",
  "comment",
  "security",
];

/** Max characters of SQL accepted — a bound on what the parser has to chew. */
const MAX_SQL_CHARS = 4000;

/**
 * Strip string literals and comments before scanning for identifiers. A
 * transcript filter (`where body ilike '%delete my account%'`) is a legitimate
 * query and must not be rejected for the word inside the quotes — which is
 * exactly the false positive that would push someone to weaken the rules.
 */
function maskLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Validate one model-authored statement. Returns an error MESSAGE (addressed
 * to the model, so it can fix and retry) or null when the statement is
 * acceptable.
 */
export function validateAnalyticsSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (trimmed.length === 0) return "Empty query.";
  if (trimmed.length > MAX_SQL_CHARS) {
    return `Query too long (${trimmed.length} chars; max ${MAX_SQL_CHARS}).`;
  }

  const masked = maskLiterals(trimmed);

  // One statement. A trailing semicolon is idiomatic and harmless; anything
  // after it is a second statement outside the scoping wrapper.
  const withoutTrailing = masked.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return "Only one statement per query — remove the extra `;`.";
  }

  if (!/^\s*(select|with)\b/i.test(withoutTrailing)) {
    return "Only SELECT (or WITH … SELECT) queries are allowed.";
  }

  const lowered = withoutTrailing.toLowerCase();
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(lowered)) {
      return `\`${keyword}\` is not allowed — analytics queries are read-only.`;
    }
  }

  // `pg_` covers pg_catalog's tables AND its functions (pg_read_file,
  // pg_sleep), which is the whole reason it is a prefix rule.
  if (/\bpg_\w*/.test(lowered)) {
    return "Identifiers starting with `pg_` are not allowed.";
  }
  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    if (new RegExp(`\\b${identifier}\\b`).test(lowered)) {
      return `\`${identifier}\` is not queryable here — select from \`events\` instead.`;
    }
  }
  return null;
}

/**
 * The column list the `events` CTE exposes, and the ONE description of the
 * schema. The tool description, the pane's help text, and this wrapper all
 * read it, so a column added to the table cannot be advertised to a model
 * without also being selectable.
 */
export const ANALYTICS_COLUMNS = [
  "slug",
  "agent_version",
  "session_id",
  "ts",
  "kind",
  "turn",
  "duration_ms",
  "level",
  "name",
  "body",
  "ok",
  "data",
] as const;

export type ScopedAnalyticsQuery = { sql: string; params: unknown[] };

/**
 * Wrap a validated statement so it can only see this caller's rows.
 *
 * The user's SQL becomes a subquery of a `select … limit`, under a CTE that
 * is already filtered by slug and retention window. Both the slug list and
 * the window are BOUND PARAMETERS — nothing a caller controls is ever
 * interpolated into SQL text, so the wrapper itself cannot be escaped by a
 * crafted project name.
 */
export function buildScopedAnalyticsQuery(opts: {
  sql: string;
  slugs: readonly string[];
  retentionDays: number;
  limit?: number;
}): ScopedAnalyticsQuery {
  const limit = Math.min(opts.limit ?? ANALYTICS_QUERY_ROW_CAP, ANALYTICS_QUERY_ROW_CAP);
  return {
    // `limit + 1` so the store can tell "exactly at the cap" from "truncated"
    // without a second count query.
    sql: `with events as (
  select ${ANALYTICS_COLUMNS.join(", ")}
    from aai_platform.agent_events
   where slug = any($1) and received_at >= now() - ($2 || ' days')::interval
)
select * from (
${opts.sql.trim().replace(/;\s*$/, "")}
) as _scoped limit ${limit + 1}`,
    params: [[...opts.slugs], String(opts.retentionDays)],
  };
}

// ─── The default view ────────────────────────────────────────────────────────

export type ToolStat = {
  name: string;
  calls: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
};

export type DailyStat = { day: string; sessions: number; turns: number; errors: number };

export type SessionStat = {
  sessionId: string;
  startedAt: number;
  durationMs: number | null;
  turns: number;
  errors: number;
  endReason: string | null;
};

export type AnalyticsSummary = {
  windowDays: number;
  /** True when the row cap trimmed the window — the numbers describe a sample. */
  sampled: boolean;
  sessions: { count: number; medianDurationMs: number | null; totalTurns: number };
  turns: {
    count: number;
    interrupted: number;
    p50FirstAudioMs: number | null;
    p95FirstAudioMs: number | null;
  };
  tools: ToolStat[];
  errors: { name: string; count: number }[];
  daily: DailyStat[];
  recentSessions: SessionStat[];
  logs: LogRow[];
};

/** Nearest-rank percentile over a copy; null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

function bumpCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** UTC day key. Deliberately UTC: rows are compared across replicas and users. */
function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Reduce the raw window into the pane's default view.
 *
 * Shared by both stores on purpose — see the module doc on `analytics-store.ts`
 * for why this is not two SQL aggregations.
 */
/**
 * The running totals {@link summarize} folds rows into.
 *
 * A named accumulator rather than a dozen closure variables, so the per-kind
 * handling can live OUTSIDE the fold as a plain function — which is what
 * keeps either half small enough to read (and, incidentally, under the
 * complexity lint, which counts a nested closure against its parent).
 */
type Totals = {
  sessionDurations: number[];
  firstAudio: number[];
  toolDurations: Map<string, number[]>;
  toolCalls: Map<string, number>;
  toolErrors: Map<string, number>;
  errorCounts: Map<string, number>;
  daily: Map<string, DailyStat>;
  sessions: Map<string, SessionStat>;
  turnCount: number;
  interrupted: number;
};

function emptyTotals(): Totals {
  return {
    sessionDurations: [],
    firstAudio: [],
    toolDurations: new Map(),
    toolCalls: new Map(),
    toolErrors: new Map(),
    errorCounts: new Map(),
    daily: new Map(),
    sessions: new Map(),
    turnCount: 0,
    interrupted: 0,
  };
}

/** The day bucket for a timestamp, created on first use. */
function dayFor(totals: Totals, ts: number): DailyStat {
  const key = dayOf(ts);
  const existing = totals.daily.get(key);
  if (existing) return existing;
  const created: DailyStat = { day: key, sessions: 0, turns: 0, errors: 0 };
  totals.daily.set(key, created);
  return created;
}

/**
 * The session a row belongs to, created on first use.
 *
 * Rows arrive NEWEST FIRST, so `startedAt` is the minimum seen rather than
 * the first: taking the first would report every session as starting when it
 * ended.
 */
function sessionFor(totals: Totals, row: SummaryRow): SessionStat {
  const existing = totals.sessions.get(row.sessionId);
  if (existing) {
    existing.startedAt = Math.min(existing.startedAt, row.ts);
    return existing;
  }
  const created: SessionStat = {
    sessionId: row.sessionId,
    startedAt: row.ts,
    durationMs: null,
    turns: 0,
    errors: 0,
    endReason: null,
  };
  totals.sessions.set(row.sessionId, created);
  return created;
}

/** Fold one tool call into the per-tool stats. */
function applyToolCall(totals: Totals, row: SummaryRow): void {
  const name = row.name ?? "(unnamed)";
  bumpCount(totals.toolCalls, name);
  if (row.ok === false) bumpCount(totals.toolErrors, name);
  if (row.durationMs === null) return;
  const list = totals.toolDurations.get(name) ?? [];
  list.push(row.durationMs);
  totals.toolDurations.set(name, list);
}

/** Fold one row in. Unknown kinds are ignored — a guest may ship a newer one. */
function applyRow(totals: Totals, row: SummaryRow): void {
  const session = sessionFor(totals, row);
  switch (row.kind) {
    case "session_start":
      dayFor(totals, row.ts).sessions += 1;
      return;
    case "session_end":
      if (row.durationMs !== null) {
        totals.sessionDurations.push(row.durationMs);
        session.durationMs = row.durationMs;
      }
      session.endReason = row.name;
      return;
    case "agent_turn":
      totals.turnCount += 1;
      session.turns = Math.max(session.turns, row.turn);
      dayFor(totals, row.ts).turns += 1;
      if (row.ok === false) totals.interrupted += 1;
      if (row.firstAudioMs !== null) totals.firstAudio.push(row.firstAudioMs);
      return;
    case "tool_call":
      applyToolCall(totals, row);
      return;
    case "error":
      bumpCount(totals.errorCounts, row.name ?? "unknown");
      dayFor(totals, row.ts).errors += 1;
      session.errors += 1;
      return;
    default:
      return;
  }
}

/** Per-tool stats, commonest tool first. */
function toolStats(totals: Totals): ToolStat[] {
  return [...totals.toolCalls.entries()]
    .map(([name, calls]) => ({
      name,
      calls,
      errors: totals.toolErrors.get(name) ?? 0,
      p50Ms: percentile(totals.toolDurations.get(name) ?? [], 50),
      p95Ms: percentile(totals.toolDurations.get(name) ?? [], 95),
    }))
    .sort((a, b) => b.calls - a.calls);
}

/**
 * Reduce the raw window into the pane's default view.
 *
 * Shared by both stores on purpose — see the module doc on
 * `analytics-store.ts` for why this is not two SQL aggregations.
 */
export function summarize(opts: {
  rows: readonly SummaryRow[];
  logs: readonly LogRow[];
  windowDays: number;
  recentSessionLimit?: number;
}): AnalyticsSummary {
  const { rows, logs, windowDays } = opts;
  const totals = emptyTotals();
  for (const row of rows) applyRow(totals, row);

  return {
    windowDays,
    sampled: rows.length >= SUMMARY_ROW_CAP,
    sessions: {
      count: totals.sessions.size,
      medianDurationMs: percentile(totals.sessionDurations, 50),
      totalTurns: totals.turnCount,
    },
    turns: {
      count: totals.turnCount,
      interrupted: totals.interrupted,
      p50FirstAudioMs: percentile(totals.firstAudio, 50),
      p95FirstAudioMs: percentile(totals.firstAudio, 95),
    },
    tools: toolStats(totals),
    errors: [...totals.errorCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    daily: [...totals.daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    recentSessions: [...totals.sessions.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, opts.recentSessionLimit ?? 25),
    logs: [...logs],
  };
}
