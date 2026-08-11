// Copyright 2026 the AAI authors. MIT license.

import { MAX_DB_RESULT_ROWS } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import {
  ANALYTICS_COLUMNS,
  buildScopedAnalyticsQuery,
  percentile,
  summarize,
  validateAnalyticsSql,
} from "./analytics-query.ts";
import {
  ANALYTICS_QUERY_ROW_CAP,
  type LogRow,
  SUMMARY_ROW_CAP,
  type SummaryRow,
} from "./analytics-store.ts";

function row(over: Partial<SummaryRow> & Pick<SummaryRow, "kind">): SummaryRow {
  return {
    sessionId: "s1",
    ts: Date.parse("2026-08-10T12:00:00Z"),
    turn: 1,
    durationMs: null,
    name: null,
    ok: null,
    firstAudioMs: null,
    ...over,
  };
}

describe("validateAnalyticsSql", () => {
  test("accepts a plain SELECT and a WITH", () => {
    expect(validateAnalyticsSql("select count(*) from events")).toBeNull();
    expect(
      validateAnalyticsSql("with t as (select 1 as a from events) select * from t"),
    ).toBeNull();
  });

  test("accepts a trailing semicolon but not a second statement", () => {
    expect(validateAnalyticsSql("select 1 from events;")).toBeNull();
    expect(validateAnalyticsSql("select 1 from events; drop table x")).toMatch(/one statement/i);
  });

  test.each([
    ["insert into events values (1)"],
    ["update events set ok = true"],
    ["delete from events"],
    ["with x as (delete from events returning 1) select * from x"],
    ["create table t (a int)"],
    ["grant select on events to public"],
    // Refused by the leading-keyword check or by the keyword scan, depending
    // on where the write appears — both are refusals, and asserting on the
    // exact one would pin which guard fires rather than that one does.
  ])("refuses %s", (sql) => {
    expect(validateAnalyticsSql(sql)).toMatch(/read-only|not allowed|only select/i);
  });

  test("refuses pg_catalog, which is the hole a CTE wrapper leaves open", () => {
    // aai_platform is not on the search path, but pg_catalog always is —
    // pg_authid and pg_read_file are reachable unqualified.
    expect(validateAnalyticsSql("select * from pg_authid")).toMatch(/pg_/);
    expect(validateAnalyticsSql("select pg_read_file('/etc/passwd')")).toMatch(/pg_/);
  });

  test.each([
    ["select * from aai_platform.agents"],
    ["select * from vault.decrypted_secrets"],
    ["select * from information_schema.tables"],
    ["select * from storage.objects"],
  ])("refuses the schema-qualified escape %s", (sql) => {
    expect(validateAnalyticsSql(sql)).toMatch(/not queryable|not allowed/i);
  });

  test("does not mistake a word inside a string literal for a keyword", () => {
    // A transcript filter is a legitimate query, and the false positive is
    // what would push someone to weaken these rules.
    expect(
      validateAnalyticsSql("select * from events where body ilike '%delete my account%'"),
    ).toBeNull();
    expect(validateAnalyticsSql("select * from events where body = 'drop table'")).toBeNull();
  });

  test("does not mistake a comment for a statement", () => {
    expect(validateAnalyticsSql("select 1 from events -- delete everything")).toBeNull();
  });

  test("refuses an empty or oversized query", () => {
    expect(validateAnalyticsSql("   ")).toMatch(/empty/i);
    expect(validateAnalyticsSql(`select ${"a".repeat(5000)} from events`)).toMatch(/too long/i);
  });
});

describe("buildScopedAnalyticsQuery", () => {
  test("binds the slug list and window as parameters, never as text", () => {
    const built = buildScopedAnalyticsQuery({
      sql: "select count(*) from events",
      slugs: ["a", "a-preview"],
      retentionDays: 7,
    });
    expect(built.params).toEqual([["a", "a-preview"], "7"]);
    // A crafted project name cannot reach the SQL text.
    expect(built.sql).not.toContain("a-preview");
  });

  test("wraps the caller's statement under the scoped CTE", () => {
    const built = buildScopedAnalyticsQuery({
      sql: "select kind from events",
      slugs: ["a"],
      retentionDays: 7,
    });
    expect(built.sql).toContain("with events as (");
    expect(built.sql).toContain("slug = any($1)");
    expect(built.sql).toContain("select kind from events");
    for (const column of ANALYTICS_COLUMNS) expect(built.sql).toContain(column);
  });

  test("caps the row limit, and the +1 probe stays inside the driver's ceiling", () => {
    const built = buildScopedAnalyticsQuery({
      sql: "select 1 from events",
      slugs: ["a"],
      retentionDays: 7,
      limit: 999_999,
    });
    // `limit + 1` is what lets the store tell "exactly at the cap" from
    // "truncated" — and it is the row that would THROW if the cap sat at the
    // driver's own ceiling, in the one case the probe exists to detect.
    expect(built.sql).toContain(`limit ${ANALYTICS_QUERY_ROW_CAP + 1}`);
    expect(ANALYTICS_QUERY_ROW_CAP + 1).toBeLessThanOrEqual(MAX_DB_RESULT_ROWS);
  });

  test("strips a trailing semicolon so the wrapper stays one statement", () => {
    const built = buildScopedAnalyticsQuery({
      sql: "select 1 from events;",
      slugs: ["a"],
      retentionDays: 7,
    });
    expect(built.sql).not.toContain(";");
  });
});

test("both row caps stay within the driver's ceiling", () => {
  // `createPostgresDb` THROWS past MAX_DB_RESULT_ROWS, so a cap above it is
  // not a bigger read — it is a read that cannot succeed. At 50_000 the
  // pane's summary failed outright for any project with real traffic.
  expect(SUMMARY_ROW_CAP).toBeLessThanOrEqual(MAX_DB_RESULT_ROWS);
  expect(ANALYTICS_QUERY_ROW_CAP).toBeLessThan(MAX_DB_RESULT_ROWS);
});

describe("percentile", () => {
  test("is nearest-rank and null for an empty sample", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  test("does not mutate its input", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("summarize", () => {
  test("counts sessions, turns and latency percentiles", () => {
    const summary = summarize({
      rows: [
        row({ kind: "session_start" }),
        row({ kind: "agent_turn", durationMs: 900, ok: true, firstAudioMs: 400 }),
        row({ kind: "agent_turn", durationMs: 700, ok: false, firstAudioMs: 800 }),
        row({ kind: "session_end", durationMs: 30_000, name: "idle_timeout" }),
      ],
      logs: [],
      windowDays: 7,
    });
    expect(summary.sessions.count).toBe(1);
    expect(summary.sessions.medianDurationMs).toBe(30_000);
    expect(summary.turns).toMatchObject({ count: 2, interrupted: 1 });
    expect(summary.turns.p50FirstAudioMs).toBe(400);
    expect(summary.turns.p95FirstAudioMs).toBe(800);
  });

  test("a turn that produced no audio does not count as instant", () => {
    const summary = summarize({
      rows: [row({ kind: "agent_turn", durationMs: 500, ok: true, firstAudioMs: null })],
      logs: [],
      windowDays: 7,
    });
    expect(summary.turns.count).toBe(1);
    expect(summary.turns.p50FirstAudioMs).toBeNull();
  });

  test("ranks tools by call count and reports their failures", () => {
    const summary = summarize({
      rows: [
        row({ kind: "tool_call", name: "lookup", durationMs: 30, ok: true }),
        row({ kind: "tool_call", name: "lookup", durationMs: 90, ok: false }),
        row({ kind: "tool_call", name: "book", durationMs: 10, ok: true }),
      ],
      logs: [],
      windowDays: 7,
    });
    expect(summary.tools).toEqual([
      { name: "lookup", calls: 2, errors: 1, p50Ms: 30, p95Ms: 90 },
      { name: "book", calls: 1, errors: 0, p50Ms: 10, p95Ms: 10 },
    ]);
  });

  test("groups errors by code, commonest first", () => {
    const summary = summarize({
      rows: [
        row({ kind: "error", name: "tool" }),
        row({ kind: "error", name: "stt" }),
        row({ kind: "error", name: "tool" }),
      ],
      logs: [],
      windowDays: 7,
    });
    expect(summary.errors).toEqual([
      { name: "tool", count: 2 },
      { name: "stt", count: 1 },
    ]);
  });

  test("takes each session's start from its EARLIEST row", () => {
    // Rows arrive newest-first, so a naive first-seen would report the end.
    const late = Date.parse("2026-08-10T12:00:30Z");
    const early = Date.parse("2026-08-10T12:00:00Z");
    const summary = summarize({
      rows: [
        row({ kind: "session_end", ts: late, durationMs: 30_000 }),
        row({ kind: "session_start", ts: early }),
      ],
      logs: [],
      windowDays: 7,
    });
    expect(summary.recentSessions[0]?.startedAt).toBe(early);
  });

  test("buckets by UTC day and carries the log tail through", () => {
    const logs: LogRow[] = [
      { ts: 1, sessionId: "s1", level: "warn", message: "slow reply_done dispatch" },
    ];
    const summary = summarize({
      rows: [
        row({ kind: "session_start", ts: Date.parse("2026-08-09T23:00:00Z") }),
        row({ kind: "session_start", ts: Date.parse("2026-08-10T01:00:00Z") }),
      ],
      logs,
      windowDays: 7,
    });
    expect(summary.daily.map((d) => d.day)).toEqual(["2026-08-09", "2026-08-10"]);
    expect(summary.logs).toEqual(logs);
  });

  test("an empty window summarizes to zeroes rather than throwing", () => {
    const summary = summarize({ rows: [], logs: [], windowDays: 7 });
    expect(summary.sessions.count).toBe(0);
    expect(summary.sampled).toBe(false);
    expect(summary.tools).toEqual([]);
  });
});
