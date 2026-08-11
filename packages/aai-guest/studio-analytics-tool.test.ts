// Copyright 2026 the AAI authors. MIT license.
import type { ToolSet } from "ai";
import { describe, expect, test, vi } from "vitest";
import { ANALYTICS_SCHEMA_DOC, createAnalyticsTools } from "./studio-analytics-tool.ts";

/**
 * The one narrowing in this file, in one place.
 *
 * `ToolSet` types `execute` against the SDK's generic tool shape, which is
 * not callable with a plain argument object — so reaching a tool's body from
 * a test needs a narrowing whatever else changes. Doing it here means the
 * assertions below call `tool.execute({ sql })` directly, and a tool that
 * disappears fails at this line rather than at a `?.` deep in a test.
 */
function analyticsTool(tools: ToolSet): (args: { sql: string; limit?: number }) => Promise<string> {
  const tool = tools.query_analytics;
  if (!tool?.execute) throw new Error("query_analytics tool is not present");
  const execute = tool.execute;
  // `as never` for the AI SDK's call options, matching studio-tools.test.ts:
  // this tool ignores that argument entirely, and spelling the full
  // `ToolExecutionOptions` here would assert a shape nothing reads.
  return (args) => Promise.resolve(execute(args, toolOpts())) as Promise<string>;
}

const toolOpts = () => ({ toolCallId: "t1", messages: [] }) as never;

function toolsWith(response: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(response), { status })),
  );
  const tools = createAnalyticsTools({
    serverUrl: "https://platform/",
    project: "my project",
    apiKey: "key-123",
    fetchImpl,
  });
  return { tools, fetchImpl, tool: { execute: analyticsTool(tools) } };
}

describe("query_analytics", () => {
  test("is not offered when the platform origin is unknown", () => {
    // A tool that cannot reach its endpoint is worse than an absent one: the
    // model burns steps and then reports the absence of data as a finding.
    expect(createAnalyticsTools({ project: "p", apiKey: "k" })).toEqual({});
  });

  test("posts to the project's analytics query route on the caller's key", async () => {
    const { fetchImpl, tool } = toolsWith({ columns: ["n"], rows: [{ n: 2 }] });
    await tool.execute({ sql: "select count(*) as n from events" });

    const [url, init = {}] = fetchImpl.mock.calls[0] ?? [];
    // The project name is encoded — a space in it must not build a bad URL.
    expect(url).toBe("https://platform/studio/projects/my%20project/analytics/query");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key-123");
    expect(JSON.parse(String(init.body))).toEqual({
      sql: "select count(*) as n from events",
      limit: 100,
    });
  });

  test("renders rows as JSON lines", async () => {
    const { tool } = toolsWith({ columns: ["a"], rows: [{ a: 1 }, { a: 2 }] });
    await expect(tool.execute({ sql: "select a from events" })).resolves.toBe('{"a":1}\n{"a":2}');
  });

  test("an empty result says so, and says what it could mean", async () => {
    const { tool } = toolsWith({ columns: [], rows: [] });
    await expect(tool.execute({ sql: "select 1 from events" })).resolves.toMatch(/No rows/);
  });

  test("returns a refusal as text the model can act on", async () => {
    // The route answers 200 with an `error` field on purpose — see the routes
    // module for why a 4xx reaches the model less reliably.
    const { tool } = toolsWith({ error: "`pg_` identifiers are not allowed." });
    await expect(tool.execute({ sql: "select * from pg_authid" })).resolves.toMatch(
      /Query rejected: `pg_`/,
    );
  });

  test("reports a transport failure instead of throwing into the turn", async () => {
    const tools = createAnalyticsTools({
      serverUrl: "https://platform",
      project: "p",
      apiKey: "k",
      fetchImpl: vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error("connection refused")),
      ),
    });
    const execute = analyticsTool(tools);
    await expect(execute({ sql: "select 1 from events" })).resolves.toMatch(
      /Analytics request failed: connection refused/,
    );
  });

  test("reports a non-2xx as a failure", async () => {
    const { tool } = toolsWith({}, 500);
    await expect(tool.execute({ sql: "select 1 from events" })).resolves.toMatch(/HTTP 500/);
  });

  test("truncates a large result on whole lines", async () => {
    // Half a JSON object is worse than fewer rows.
    const rows = Array.from({ length: 5000 }, (_, i) => ({ i, pad: "x".repeat(50) }));
    const { tool } = toolsWith({ columns: ["i", "pad"], rows });
    const out = await tool.execute({ sql: "select * from events" });
    expect(out).toMatch(/more rows omitted/);
    for (const line of out.split("\n").slice(0, -1)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  test("says when the server capped the result", async () => {
    const { tool } = toolsWith({ columns: ["a"], rows: [{ a: 1 }], truncated: true });
    await expect(tool.execute({ sql: "select a from events" })).resolves.toMatch(/row cap/);
  });

  test("passes an explicit limit through", async () => {
    const { fetchImpl, tool } = toolsWith({ rows: [] });
    await tool.execute({ sql: "select 1 from events", limit: 5 });
    const [, init = {}] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(String(init.body)).limit).toBe(5);
  });
});

describe("the schema handed to the model", () => {
  test("documents every kind the runtime emits", () => {
    // A kind the model cannot enumerate is a kind it cannot query, and this
    // doc is the ONLY place it learns them.
    for (const kind of [
      "session_start",
      "session_end",
      "user_turn",
      "agent_turn",
      "tool_call",
      "barge_in",
      "error",
      "log",
    ]) {
      expect(ANALYTICS_SCHEMA_DOC).toContain(kind);
    }
  });

  test("names the latency field, which is not derivable from the column list", () => {
    expect(ANALYTICS_SCHEMA_DOC).toContain("firstAudioMs");
  });

  test("states the constraints the server enforces", () => {
    expect(ANALYTICS_SCHEMA_DOC).toMatch(/one SELECT/i);
    expect(ANALYTICS_SCHEMA_DOC).toMatch(/7 days/);
  });
});
