// Copyright 2026 the AAI authors. MIT license.
/**
 * Storage for deployed-agent session analytics (`aai_platform.agent_events`).
 *
 * ## Every read carries a `received_at` bound
 *
 * The table is RANGE partitioned by day on `received_at` (see the migration
 * for why that column and not `ts`), so `received_at` is what the planner
 * prunes partitions on. A query filtered only on `ts` is correct and scans
 * every partition in the retention window; the extra predicate costs a
 * duplicated parameter and makes it read one day's partition instead. Both
 * bounds use the same value — `received_at >= ts` always holds, so the pair
 * can only narrow, never drop a row a `ts` filter would have kept.
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

import { MAX_DB_RESULT_ROWS } from "@alexkroman1/aai";
import { createSemaphore, type Semaphore } from "./_semaphore.ts";
import type { AdminDb } from "./platform-lock.ts";
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

/**
 * One ad-hoc query, plus the slugs it is allowed to see.
 *
 * The slugs are passed SEPARATELY from the statement even though the CTE
 * wrapper already filters on them, because they are enforced twice by
 * different mechanisms: the wrapper is a predicate the statement could in
 * principle be written around, while the RLS policy on `agent_events` is
 * applied by Postgres to the reader role no matter what the statement says.
 * A caller that forgot to pass them reads zero rows, not every row.
 */
export type ScopedQueryRequest = {
  sql: string;
  params: readonly unknown[];
  slugs: readonly string[];
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
  /** Recent log lines, newest first. */
  logs(opts: { slugs: readonly string[]; sinceMs: number; limit: number }): Promise<LogRow[]>;
  /**
   * Run a pre-validated, model-authored statement under the READER ROLE.
   *
   * `sql` must already have been through `buildScopedAnalyticsQuery`; this
   * does no syntactic checking of its own. What it adds is the half the
   * validator cannot provide — see {@link ScopedQueryRequest}.
   */
  runScoped(request: ScopedQueryRequest): Promise<AnalyticsQueryResult>;
};

/**
 * How many rows the default view reads, and the ad-hoc cap — both DERIVED
 * from the driver's own ceiling rather than chosen.
 *
 * `createPostgresDb` THROWS on a result past {@link MAX_DB_RESULT_ROWS}
 * ("add a LIMIT"), and the platform's admin handle is a `createPostgresDb`.
 * So a cap above it is not a bigger read — it is a read that cannot succeed:
 * at 50_000 the pane's summary failed outright for any project with more than
 * a thousand events in a week, on every 30s refetch, which is precisely the
 * projects the pane exists for.
 *
 * The summary therefore describes THE MOST RECENT {@link SUMMARY_ROW_CAP}
 * events rather than the whole window, and says so (`sampled`) when it hits
 * the cap. That is the honest shape for this pane anyway: exact figures over
 * the full window are what `query_analytics` is for, and the sampled notice
 * points there.
 */
export const SUMMARY_ROW_CAP = MAX_DB_RESULT_ROWS;

/**
 * Max rows an ad-hoc query may return. One under the driver's ceiling,
 * because `buildScopedAnalyticsQuery` asks for `limit + 1` to tell "exactly
 * at the cap" from "truncated" — at the ceiling that probe row is what would
 * throw, in the one case the probe exists to detect.
 */
export const ANALYTICS_QUERY_ROW_CAP = MAX_DB_RESULT_ROWS - 1;

/**
 * Epoch millis from whatever the driver handed back. postgres.js decodes
 * `timestamptz` as a `Date`, so the common path is a field read — the string
 * branch is for a driver (or a fake) that returns text, and going through it
 * unconditionally cost a stringify plus a full parse per row, on a read that
 * returns up to {@link SUMMARY_ROW_CAP} of them.
 */
function toEpochMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

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

/**
 * How long a model-authored query may run before Postgres cancels it.
 *
 * A `GROUP BY` an LLM wrote over a week of a busy agent's rows is the case
 * this bounds, and it is bounded IN THE DATABASE rather than by a client
 * timeout: abandoning the request would leave the query running.
 */
const READER_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * How many ad-hoc queries may hold an admin connection at once.
 *
 * Each one reserves a connection from the shared admin pool for up to
 * {@link READER_STATEMENT_TIMEOUT_MS}, and that pool is `ADMIN_POOL_MAX` (4)
 * — the same four connections every Vault read, agents-row lookup, workspace
 * read and analytics INGEST on this replica share. Unbounded, four coding
 * agents each running a slow `GROUP BY` would stall the control plane for ten
 * seconds.
 *
 * A semaphore rather than a pool of its own, deliberately: the platform's
 * direct-connection budget is fleet-wide and already sits at its declared
 * ceiling (`MAX_PLATFORM_DB_CONNECTIONS`, held by `platform-db-budget.test.ts`),
 * so a third pool would be a claim about the provisioned instance rather than
 * a local decision. Capping the SHARE of an existing pool needs no new
 * connections.
 *
 * The wait is bounded too — a query that cannot get a slot is refused with a
 * message the model can act on, which is better than one that hangs.
 */
const READER_CONCURRENCY = 2;
const READER_WAIT_MS = 5000;

/**
 * Run one statement as `aai_analytics_reader` on a RESERVED connection.
 *
 * This is the structural half of the ad-hoc SQL guard, and the reason it can
 * be structural at all is that all four settings below are transaction-local
 * — which needs connection affinity, which is what `reserve()` provides (the
 * same primitive the slug lock uses for advisory locks; over the pool, the
 * `set local`s and the query could land on different connections).
 *
 * What each one buys, in the order they are applied:
 *
 * 1. **`aai.analytics_slugs`** is set BEFORE the role switch, so the reader
 *    cannot choose its own scope. The RLS policy on `agent_events` reads it;
 *    unset means zero rows.
 * 2. **`set local role`** drops from the table owner to a role holding
 *    `select` on exactly this one table. Owners bypass RLS, so without this
 *    step the policy would be inert — this is what makes it apply.
 * 3. **`read only`** refuses writes at the transaction level, which is what
 *    stops a data-modifying CTE the validator's keyword scan missed.
 * 4. **`statement_timeout`** bounds the work.
 *
 * The validator (`analytics-query.ts`) still runs first. It is now the layer
 * that produces a MESSAGE the model can act on, rather than the only thing
 * standing between a prompt injection and the control plane.
 */
async function runAsReader(
  db: AdminDb,
  slots: Semaphore,
  request: ScopedQueryRequest,
): Promise<Record<string, unknown>[]> {
  const slot = await slots.acquire(READER_WAIT_MS);
  if (!slot) {
    throw new Error("Too many analytics queries in flight right now — try again in a moment.");
  }
  const conn = await db.reserve();
  try {
    await conn.query("begin");
    try {
      // A slug is `[a-z0-9-]` by construction (validateSlug), so the joined
      // list cannot contain the delimiter the policy splits on — but it is a
      // bound parameter regardless, so nothing here is interpolated.
      await conn.query("select set_config('aai.analytics_slugs', $1, true)", [
        request.slugs.join(","),
      ]);
      await conn.query("set local role aai_analytics_reader");
      await conn.query("set local transaction read only");
      await conn.query(`set local statement_timeout = ${READER_STATEMENT_TIMEOUT_MS}`);
      const rows = await conn.query(request.sql, [...request.params]);
      await conn.query("commit");
      return rows;
    } catch (err) {
      // Rollback resets the role and every `set local` with it; a failed
      // rollback is not worth masking the query error the caller needs.
      await conn.query("rollback").catch(() => undefined);
      throw err;
    }
  } finally {
    conn.release();
    slot();
  }
}

/**
 * Postgres-backed store. The table is declared by the migrations, never here.
 *
 * `db` is separate from `sql` because ad-hoc queries need connection affinity
 * (see {@link runAsReader}) while ingest and the summary reads are ordinary
 * pooled statements. It is the same `AdminDb` the slug lock reserves on.
 */
export function createPostgresAnalyticsStore(sql: SqlExec, db: AdminDb): AnalyticsStore {
  const readerSlots = createSemaphore(READER_CONCURRENCY);
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
          where slug = any($1) and received_at >= $2 and ts >= $2
          order by ts desc
          limit $3`,
        [[...slugs], new Date(sinceMs).toISOString(), SUMMARY_ROW_CAP],
      );
      return rows.map((row) => ({
        sessionId: String(row.session_id),
        ts: toEpochMs(row.ts),
        kind: String(row.kind),
        turn: Number(row.turn ?? 0),
        durationMs: toNumberOrNull(row.duration_ms),
        name: row.name === null || row.name === undefined ? null : String(row.name),
        ok: typeof row.ok === "boolean" ? row.ok : null,
        firstAudioMs: toNumberOrNull(row.first_audio),
      }));
    },

    async logs({ slugs, sinceMs, limit }) {
      if (slugs.length === 0) return [];
      const rows = await sql(
        `select ts, session_id, level, body
           from aai_platform.agent_events
          where slug = any($1) and received_at >= $2 and ts >= $2 and kind = 'log'
          order by ts desc
          limit $3`,
        [[...slugs], new Date(sinceMs).toISOString(), limit],
      );
      return rows.map((row) => ({
        ts: toEpochMs(row.ts),
        sessionId: String(row.session_id),
        level: String(row.level ?? "info"),
        message: String(row.body ?? ""),
      }));
    },

    async runScoped(request) {
      const rows = await runAsReader(db, readerSlots, request);
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
    logs({ slugs, sinceMs, limit }) {
      const rows = stored
        .filter((row) => inWindow(row, slugs, sinceMs) && row.kind === "log")
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
