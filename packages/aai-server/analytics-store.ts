// Copyright 2026 the AAI authors. MIT license.
/**
 * Storage for deployed-agent session analytics (`aai_platform.agent_events`).
 *
 * Two implementations with identical semantics, the same pattern every other
 * platform store follows: Postgres over the shared `SqlExec` in production,
 * and an array-backed one for local dev and tests.
 *
 * ## Why the summary is aggregated in JS rather than in SQL
 *
 * Both implementations fetch a bounded, TEXT-FREE column projection for the
 * window and reduce it with the same {@link summarize} function. The obvious
 * alternative — five aggregate queries in the Postgres store and a JS
 * reimplementation for memory — was rejected because the two would drift, and
 * the drift is invisible: dev and tests would exercise one definition of "p95
 * time to first audio" and production another, with no test able to see both.
 *
 * The cost is a bounded fetch per pane load ({@link SUMMARY_ROW_CAP} rows,
 * without the `body` column, which is where the bytes are). When a project
 * exceeds that cap the summary is computed from the most RECENT rows and says
 * so (`sampled: true`) rather than silently describing a slice as the whole.
 * Real aggregation over the full window is what the ad-hoc SQL surface is for
 * — that one runs in the database.
 */

import type { SqlExec } from "./secret-store.ts";

/** One event row as the ingest boundary accepts it (epoch-ms timestamps). */
export type AnalyticsRow = {
  slug: string;
  /** The deploy generation this session ran on; absent for local dev. */
  agentVersion?: number | undefined;
  sessionId: string;
  ts: number;
  kind: string;
  turn: number;
  durationMs?: number | undefined;
  level?: string | undefined;
  name?: string | undefined;
  body?: string | undefined;
  ok?: boolean | undefined;
  data?: Record<string, unknown> | undefined;
};

/** The projection {@link summarize} reduces — no `body`, no `data`. */
export type SummaryRow = {
  sessionId: string;
  ts: number;
  kind: string;
  turn: number;
  durationMs: number | null;
  name: string | null;
  ok: boolean | null;
  firstAudioMs: number | null;
};

/** A recent log line, for the pane's log tail. */
export type LogRow = {
  ts: number;
  sessionId: string;
  level: string;
  message: string;
};

export type AnalyticsQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  /** True when the row cap trimmed the result. */
  truncated: boolean;
};

export type AnalyticsStore = {
  /** Append a shipped batch. Never throws on an empty batch. */
  append(rows: readonly AnalyticsRow[]): Promise<void>;
  /** The projection behind the default view, newest first, capped. */
  summaryRows(opts: { slugs: readonly string[]; sinceMs: number }): Promise<SummaryRow[]>;
  /** Recent log lines at or above `minLevel`, newest first. */
  logs(opts: {
    slugs: readonly string[];
    sinceMs: number;
    limit: number;
    levels?: readonly string[] | undefined;
  }): Promise<LogRow[]>;
  /**
   * Run a pre-validated, slug-scoped read-only statement. `sql` must already
   * have been through `buildScopedAnalyticsQuery` — this method does no
   * checking of its own, which is why it is not called with anything a client
   * sent.
   */
  runScoped(sql: string, params: readonly unknown[]): Promise<AnalyticsQueryResult>;
};

/**
 * How many rows the default view will read. Chosen so that the worst case is
 * a few megabytes over the wire, not a design limit anyone should plan
 * around; past it the pane reports a sample.
 */
export const SUMMARY_ROW_CAP = 50_000;

/** Max rows any ad-hoc query may return, mirroring `ctx.db`'s own cap. */
export const ANALYTICS_QUERY_ROW_CAP = 1000;

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Read `firstAudioMs` back out of the jsonb blob, whatever the driver gave us. */
function firstAudioOf(data: unknown): number | null {
  if (data === null || typeof data !== "object") return null;
  return toNumberOrNull((data as { firstAudioMs?: unknown }).firstAudioMs);
}

/** Postgres-backed store. The table is declared by the migrations, never here. */
export function createPostgresAnalyticsStore(sql: SqlExec): AnalyticsStore {
  return {
    async append(rows) {
      if (rows.length === 0) return;
      // One multi-row INSERT built from parallel arrays rather than N
      // statements: a batch is the unit the guest ships, and a per-row round
      // trip would make the ingest cost scale with conversation length.
      // `unnest` keeps it a single parameterized statement, so nothing in the
      // payload is ever interpolated into SQL text.
      await sql(
        `insert into aai_platform.agent_events
           (slug, agent_version, session_id, ts, kind, turn, duration_ms, level, name, body, ok, data)
         select * from unnest(
           $1::text[], $2::bigint[], $3::text[], $4::timestamptz[], $5::text[],
           $6::int[], $7::int[], $8::text[], $9::text[], $10::text[], $11::boolean[], $12::jsonb[]
         )`,
        [
          rows.map((r) => r.slug),
          rows.map((r) => r.agentVersion ?? null),
          rows.map((r) => r.sessionId),
          rows.map((r) => new Date(r.ts).toISOString()),
          rows.map((r) => r.kind),
          rows.map((r) => r.turn),
          rows.map((r) => r.durationMs ?? null),
          rows.map((r) => r.level ?? null),
          rows.map((r) => r.name ?? null),
          rows.map((r) => r.body ?? null),
          rows.map((r) => r.ok ?? null),
          rows.map((r) => JSON.stringify(r.data ?? {})),
        ],
      );
    },

    async summaryRows({ slugs, sinceMs }) {
      if (slugs.length === 0) return [];
      const rows = await sql(
        `select session_id, ts, kind, turn, duration_ms, name, ok, data->'firstAudioMs' as first_audio
           from aai_platform.agent_events
          where slug = any($1) and ts >= $2
          order by ts desc
          limit $3`,
        [[...slugs], new Date(sinceMs).toISOString(), SUMMARY_ROW_CAP],
      );
      return rows.map((row) => ({
        sessionId: String(row.session_id),
        ts: new Date(String(row.ts)).getTime(),
        kind: String(row.kind),
        turn: Number(row.turn ?? 0),
        durationMs: toNumberOrNull(row.duration_ms),
        name: row.name === null || row.name === undefined ? null : String(row.name),
        ok: typeof row.ok === "boolean" ? row.ok : null,
        firstAudioMs: toNumberOrNull(row.first_audio),
      }));
    },

    async logs({ slugs, sinceMs, limit, levels }) {
      if (slugs.length === 0) return [];
      const rows = await sql(
        `select ts, session_id, level, body
           from aai_platform.agent_events
          where slug = any($1) and ts >= $2 and kind = 'log'
            and ($3::text[] is null or level = any($3))
          order by ts desc
          limit $4`,
        [[...slugs], new Date(sinceMs).toISOString(), levels ? [...levels] : null, limit],
      );
      return rows.map((row) => ({
        ts: new Date(String(row.ts)).getTime(),
        sessionId: String(row.session_id),
        level: String(row.level ?? "info"),
        message: String(row.body ?? ""),
      }));
    },

    async runScoped(query, params) {
      const rows = await sql(query, [...params]);
      return {
        columns: rows[0] ? Object.keys(rows[0]) : [],
        rows: rows.slice(0, ANALYTICS_QUERY_ROW_CAP),
        truncated: rows.length > ANALYTICS_QUERY_ROW_CAP,
      };
    },
  };
}

/**
 * In-memory store for `aai dev` and tests. `runScoped` is the one method it
 * cannot honour — the whole point of that surface is that the DATABASE
 * evaluates the SQL — so it says so rather than pretending, which is what
 * keeps a dev-mode "no rows" from reading like a real empty result.
 */
export function createMemoryAnalyticsStore(): AnalyticsStore & {
  readonly rows: readonly AnalyticsRow[];
} {
  const stored: AnalyticsRow[] = [];
  const inWindow = (row: AnalyticsRow, slugs: readonly string[], sinceMs: number): boolean =>
    slugs.includes(row.slug) && row.ts >= sinceMs;

  return {
    get rows() {
      return stored;
    },
    append(rows) {
      stored.push(...rows);
      return Promise.resolve();
    },
    summaryRows({ slugs, sinceMs }) {
      const rows = stored
        .filter((row) => inWindow(row, slugs, sinceMs))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, SUMMARY_ROW_CAP)
        .map((row) => ({
          sessionId: row.sessionId,
          ts: row.ts,
          kind: row.kind,
          turn: row.turn,
          durationMs: row.durationMs ?? null,
          name: row.name ?? null,
          ok: row.ok ?? null,
          firstAudioMs: firstAudioOf(row.data),
        }));
      return Promise.resolve(rows);
    },
    logs({ slugs, sinceMs, limit, levels }) {
      const rows = stored
        .filter(
          (row) =>
            inWindow(row, slugs, sinceMs) &&
            row.kind === "log" &&
            (!levels || levels.includes(row.level ?? "info")),
        )
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map((row) => ({
          ts: row.ts,
          sessionId: row.sessionId,
          level: row.level ?? "info",
          message: row.body ?? "",
        }));
      return Promise.resolve(rows);
    },
    runScoped() {
      return Promise.reject(
        new Error(
          "Ad-hoc analytics SQL requires the platform database; this deployment has none configured.",
        ),
      );
    },
  };
}
