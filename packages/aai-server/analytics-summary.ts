// Copyright 2026 the AAI authors. MIT license.
/**
 * The Analytics pane's DEFAULT VIEW: one pass over a window of rows, folded
 * into the handful of numbers the pane renders.
 *
 * Split from `analytics-query.ts`, which owns the other half of this feature —
 * the guard around model-authored SQL and the CTE wrapper that scopes it. The
 * two share nothing but the row types: one decides what a caller is ALLOWED to
 * ask, this one answers the single question nobody has to ask.
 *
 * **It is a fold, not a series of passes.** The rows are the whole window
 * (capped at {@link SUMMARY_ROW_CAP}) and every figure the pane shows comes
 * out of one traversal plus the percentile sorts — a `filter` per statistic
 * would walk the same array eight times on the studio's hot path.
 */

import { type LogRow, SUMMARY_ROW_CAP, type SummaryRow } from "./analytics-store.ts";

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
  sessions: { count: number; medianDurationMs: number | null };
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
/** How many sessions the pane lists. */
const RECENT_SESSION_LIMIT = 25;

export function summarize(opts: {
  rows: readonly SummaryRow[];
  logs: readonly LogRow[];
  windowDays: number;
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
      .slice(0, RECENT_SESSION_LIMIT),
    logs: [...logs],
  };
}
