// Copyright 2026 the AAI authors. MIT license.
import {
  type AnalyticsRow,
  type AnalyticsStore,
  createMemoryAnalyticsStore,
} from "aai-server/analytics-store";
import { hashApiKey } from "aai-server/secrets";
import { createTestStore } from "aai-server/test-utils";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { beforeEach, describe, expect, test } from "vitest";
import {
  ownedProjectSlugs,
  type ProjectAnalyticsEnv,
  projectAnalytics,
  runProjectAnalyticsQuery,
} from "./studio-analytics.ts";

const KEY = "owner-key";
const OTHER_KEY = "someone-else";
const SCOPE = "user:1";
const PROJECT = "my-project";

function row(over: Partial<AnalyticsRow> & Pick<AnalyticsRow, "kind">): AnalyticsRow {
  return {
    slug: "my-project",
    sessionId: "s1",
    ts: Date.now(),
    turn: 1,
    ...over,
  };
}

async function setup(opts: { analytics?: AnalyticsStore | null } = {}) {
  const workspaces = createMemoryWorkspaceStore();
  const store = createTestStore();
  const analytics =
    opts.analytics === null ? null : (opts.analytics ?? createMemoryAnalyticsStore());

  const deploy = async (slug: string, apiKey: string): Promise<void> => {
    await store.putAgent({
      slug,
      env: {},
      worker: "export default {}",
      clientFiles: {},
      credential_hashes: [hashApiKey(apiKey)],
    });
  };

  const writeWorkspace = async (doc: Record<string, unknown>): Promise<void> => {
    await workspaces.put(SCOPE, PROJECT, { files: {}, updatedAt: Date.now(), ...doc }, null);
  };

  const env: ProjectAnalyticsEnv = {
    workspaces,
    store,
    ...(analytics && { analytics: { store: analytics } }),
  };
  return { env, analytics, deploy, writeWorkspace };
}

const request = { scope: SCOPE, project: PROJECT, apiKey: KEY };

describe("ownedProjectSlugs", () => {
  test("returns null for a project that does not exist", async () => {
    const { env } = await setup();
    await expect(ownedProjectSlugs(env, request)).resolves.toBeNull();
  });

  test("covers BOTH the production and the preview agent", async () => {
    // A project is two deployed agents, and the preview one is what a user
    // has actually been talking to while building.
    const { env, deploy, writeWorkspace } = await setup();
    await deploy("my-project", KEY);
    await deploy("my-project-preview", KEY);
    await writeWorkspace({ deployedSlug: "my-project", previewSlug: "my-project-preview" });
    await expect(ownedProjectSlugs(env, request)).resolves.toEqual([
      "my-project",
      "my-project-preview",
    ]);
  });

  test("drops a slug the caller does not own", async () => {
    // The workspace document is a file the user can write, so a slug named in
    // it is a CLAIM — reading it unchecked would make this an oracle for
    // another tenant's transcripts.
    const { env, deploy, writeWorkspace } = await setup();
    await deploy("someone-elses-agent", OTHER_KEY);
    await writeWorkspace({ deployedSlug: "someone-elses-agent" });
    await expect(ownedProjectSlugs(env, request)).resolves.toEqual([]);
  });

  test("drops a slug whose agent was deleted rather than failing", async () => {
    const { env, writeWorkspace } = await setup();
    await writeWorkspace({ deployedSlug: "gone" });
    await expect(ownedProjectSlugs(env, request)).resolves.toEqual([]);
  });
});

describe("projectAnalytics", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    await ctx.deploy("my-project", KEY);
    await ctx.writeWorkspace({ deployedSlug: "my-project" });
  });

  test("summarizes the project's own rows", async () => {
    await ctx.analytics?.append([
      row({ kind: "session_start" }),
      row({ kind: "agent_turn", durationMs: 800, ok: true, data: { firstAudioMs: 300 } }),
      row({ kind: "tool_call", name: "lookup", durationMs: 20, ok: false }),
      row({ kind: "log", level: "warn", body: "slow reply" }),
    ]);
    const summary = await projectAnalytics(ctx.env, request);
    expect(summary).toMatchObject({
      slugs: ["my-project"],
      windowDays: 7,
      turns: { count: 1, p50FirstAudioMs: 300 },
      tools: [{ name: "lookup", calls: 1, errors: 1 }],
    });
    expect(summary?.logs).toHaveLength(1);
  });

  test("does not read another project's rows", async () => {
    await ctx.analytics?.append([row({ slug: "other-agent", kind: "session_start" })]);
    const summary = await projectAnalytics(ctx.env, request);
    expect(summary?.sessions.count).toBe(0);
  });

  test("404s (null) for a project that does not exist", async () => {
    const { env } = await setup();
    await expect(projectAnalytics(env, request)).resolves.toBeNull();
  });

  test("says the feature is OFF rather than reporting zero traffic", async () => {
    // Rendering zeroes for a disabled deployment tells a user their agent has
    // no users, which is a lie that looks like data.
    const off = await setup({ analytics: null });
    await off.deploy("my-project", KEY);
    await off.writeWorkspace({ deployedSlug: "my-project" });
    const summary = await projectAnalytics(off.env, request);
    expect(summary?.unavailable).toMatch(/not enabled/i);
  });

  test("a project with no deployed agent reports no slugs and no traffic", async () => {
    const fresh = await setup();
    await fresh.writeWorkspace({});
    const summary = await projectAnalytics(fresh.env, request);
    expect(summary).toMatchObject({ slugs: [], sessions: { count: 0 } });
    expect(summary?.unavailable).toBeUndefined();
  });
});

describe("runProjectAnalyticsQuery", () => {
  test("refuses a statement the validator rejects, with a message the model can act on", async () => {
    const { env, deploy, writeWorkspace } = await setup();
    await deploy("my-project", KEY);
    await writeWorkspace({ deployedSlug: "my-project" });
    const outcome = await runProjectAnalyticsQuery(env, {
      ...request,
      sql: "delete from events",
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/read-only|only select/i) });
  });

  test("validates BEFORE the empty-slug shortcut", async () => {
    // An agent told "no rows" for a typo'd query goes looking for missing
    // data instead of the typo.
    const { env, writeWorkspace } = await setup();
    await writeWorkspace({});
    const outcome = await runProjectAnalyticsQuery(env, {
      ...request,
      sql: "select * from pg_authid",
    });
    expect(outcome).toMatchObject({ ok: false });
  });

  test("a project with no deployed agent returns an empty result, not an error", async () => {
    const { env, writeWorkspace } = await setup();
    await writeWorkspace({});
    const outcome = await runProjectAnalyticsQuery(env, {
      ...request,
      sql: "select count(*) from events",
    });
    expect(outcome).toEqual({
      ok: true,
      slugs: [],
      result: { columns: [], rows: [], truncated: false },
    });
  });

  test("passes a valid statement to the store, scoped to the owned slugs", async () => {
    const seen: { sql: string; params: readonly unknown[] }[] = [];
    const recording: AnalyticsStore = {
      ...createMemoryAnalyticsStore(),
      runScoped: (sql, params) => {
        seen.push({ sql, params });
        return Promise.resolve({ columns: ["count"], rows: [{ count: 3 }], truncated: false });
      },
    };
    const ctx = await setup({ analytics: recording });
    await ctx.deploy("my-project", KEY);
    await ctx.writeWorkspace({ deployedSlug: "my-project" });

    const outcome = await runProjectAnalyticsQuery(ctx.env, {
      ...request,
      sql: "select count(*) from events",
    });
    expect(outcome).toMatchObject({ ok: true, result: { rows: [{ count: 3 }] } });
    expect(seen[0]?.params[0]).toEqual(["my-project"]);
    expect(seen[0]?.sql).toContain("with events as (");
  });

  test("returns a database error to the caller instead of throwing", async () => {
    // Nearly always the model's SQL — an unknown column, a bad aggregate —
    // so the message is what lets it fix the query.
    const failing: AnalyticsStore = {
      ...createMemoryAnalyticsStore(),
      runScoped: () => Promise.reject(new Error('column "nope" does not exist')),
    };
    const ctx = await setup({ analytics: failing });
    await ctx.deploy("my-project", KEY);
    await ctx.writeWorkspace({ deployedSlug: "my-project" });
    const outcome = await runProjectAnalyticsQuery(ctx.env, {
      ...request,
      sql: "select nope from events",
    });
    expect(outcome).toEqual({ ok: false, error: 'column "nope" does not exist' });
  });

  test("the memory store says ad-hoc SQL needs a database rather than answering empty", async () => {
    const ctx = await setup();
    await ctx.deploy("my-project", KEY);
    await ctx.writeWorkspace({ deployedSlug: "my-project" });
    const outcome = await runProjectAnalyticsQuery(ctx.env, {
      ...request,
      sql: "select count(*) from events",
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringMatching(/requires the platform database/i),
    });
  });
});
