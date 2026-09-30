// Copyright 2026 the AAI authors. MIT license.
/**
 * `clientRunsRoutes` against a stubbed `ctx.workflows`: the keys it mounts, the
 * `?client=` door, the recent window, the three per-run choices, the detail
 * precedence, the order, and the cancel that refuses another client's run.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStubWorkflows } from "./_testing-context.ts";
import type { RouteContext, RouteRequest } from "./agent-routes.ts";
import { readRouteResponse } from "./agent-routes.ts";
import { type ClientRunsResponse, clientRunsRoutes } from "./client-runs-routes.ts";
import type { WorkflowClient } from "./workflow-client.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function ctxWith(workflows: Partial<WorkflowClient>): RouteContext {
  return {
    env: {},
    workflows: createStubWorkflows(workflows),
    clientTranscript: async () => ({ sessions: [] }),
    signal: new AbortController().signal,
  };
}

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: "GET",
    path: "/tasks",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    clientId: "kitchen",
    ...over,
  };
}

const base = { key: "kitchen" } as const;
const RUNS: WorkflowRunSnapshot[] = [
  { ...base, runId: "r-new", workflow: "research", createdAt: NOW - MIN, status: "running" },
  {
    ...base,
    runId: "r-fail",
    workflow: "call",
    label: "Call Luigi's",
    createdAt: NOW - 2 * MIN,
    status: "failed",
    error: "Request to https://api.example.com/v1?key=abc123 failed with 403. Retry later.",
  },
  {
    ...base,
    runId: "r-call",
    workflow: "call",
    createdAt: NOW - 3 * MIN,
    status: "completed",
    output: { said: "Luigi's didn't answer" },
  },
  {
    ...base,
    runId: "r-quiet",
    workflow: "appEvent",
    createdAt: NOW - 4 * MIN,
    status: "completed",
    output: { told: false },
  },
  {
    ...base,
    runId: "r-old",
    workflow: "remind",
    createdAt: NOW - 60 * MIN,
    status: "completed",
    output: null,
  },
  { ...base, runId: "r-wait", workflow: "remind", createdAt: NOW - 90 * MIN, status: "pending" },
];

async function list(
  handlers: ReturnType<typeof clientRunsRoutes>,
  ctx: RouteContext,
  key = "GET /tasks",
): Promise<ClientRunsResponse> {
  const handler = handlers[key];
  if (!handler) throw new Error(`no ${key}`);
  return (await handler(req(), ctx)) as ClientRunsResponse;
}

describe("clientRunsRoutes", () => {
  test("mounts GET <path> and DELETE <path>/:runId, and refuses a path it cannot key", () => {
    expect(Object.keys(clientRunsRoutes())).toEqual(["GET /tasks", "DELETE /tasks/:runId"]);
    expect(Object.keys(clientRunsRoutes({ path: "/running" }))).toEqual([
      "GET /running",
      "DELETE /running/:runId",
    ]);
    for (const path of ["tasks", "/tasks/", ""]) {
      expect.soft(() => clientRunsRoutes({ path }), path).toThrow(TypeError);
    }
  });

  test("lists the client's live and recent runs, oldest first, with the default details", async () => {
    const findByKey = vi.fn(async () => RUNS);
    const lastLine = vi.fn(async () => "Reading three sources");
    const body = await list(clientRunsRoutes(), ctxWith({ findByKey, lastLine }));
    // The default route reads no `output`, so it asks for none.
    expect(findByKey).toHaveBeenCalledWith("kitchen", { limit: 100, withOutput: false });
    expect(lastLine).toHaveBeenCalledTimes(1);
    expect(body.runs).toEqual([
      {
        runId: "r-wait",
        workflow: "remind",
        status: "waiting",
        title: "remind",
        createdAt: NOW - 90 * MIN,
      },
      {
        runId: "r-quiet",
        workflow: "appEvent",
        status: "completed",
        title: "appEvent",
        createdAt: NOW - 4 * MIN,
      },
      {
        runId: "r-call",
        workflow: "call",
        status: "completed",
        title: "call",
        createdAt: NOW - 3 * MIN,
      },
      {
        runId: "r-fail",
        workflow: "call",
        status: "failed",
        title: "Call Luigi's",
        detail: "Request to failed with 403.",
        createdAt: NOW - 2 * MIN,
      },
      {
        runId: "r-new",
        workflow: "research",
        status: "running",
        title: "research",
        detail: "Reading three sources",
        createdAt: NOW - MIN,
      },
    ]);
  });

  test("include, progressFor, detail and recentMs express the app's own rules", async () => {
    const lastLine = vi.fn(async () => "never read");
    const handlers = clientRunsRoutes({
      recentMs: 150_000,
      limit: 20,
      include: (r) =>
        !(
          r.workflow === "appEvent" &&
          r.status === "completed" &&
          (r.output as { told?: unknown } | undefined)?.told !== true
        ),
      progressFor: (r) => r.workflow === "appJob",
      detail: (r) => {
        const said =
          r.status === "completed" && r.workflow === "call"
            ? (r.output as { said?: unknown } | undefined)?.said
            : undefined;
        return typeof said === "string" ? said : undefined;
      },
    });
    const findByKey = vi.fn(async () => RUNS);
    const body = await list(handlers, ctxWith({ findByKey, lastLine }));
    // `include`/`detail` read `output`, so it is still read.
    expect(findByKey).toHaveBeenCalledWith("kitchen", { limit: 20, withOutput: true });
    expect(lastLine).not.toHaveBeenCalled();
    // r-call (3 min) is outside a 2.5-minute window; r-quiet is excluded outright.
    expect(body.runs.map((r) => [r.runId, r.detail])).toEqual([
      ["r-wait", undefined],
      ["r-fail", "Request to failed with 403."],
      ["r-new", undefined],
    ]);
  });

  test("a completed call's own summary wins over the defaults, and a lost or non-string line is not shown", async () => {
    const handlers = clientRunsRoutes({
      detail: (r) => (r.runId === "r-call" ? "Luigi's didn't answer" : undefined),
    });
    const findByKey = async () => RUNS.filter((r) => r.runId === "r-call" || r.runId === "r-new");
    const lost = await list(
      handlers,
      ctxWith({ findByKey, lastLine: async () => Promise.reject(new Error("restarted")) }),
    );
    expect(lost.runs.map((r) => [r.runId, r.detail])).toEqual([
      ["r-call", "Luigi's didn't answer"],
      ["r-new", undefined],
    ]);
    const structured = await list(
      handlers,
      ctxWith({ findByKey, lastLine: async () => ({ pct: 40 }) }),
    );
    expect(structured.runs.find((r) => r.runId === "r-new")).not.toHaveProperty("detail");
  });

  test("both routes need ?client=", async () => {
    const handlers = clientRunsRoutes();
    for (const [key, handler] of Object.entries(handlers)) {
      const { clientId: _none, ...anonymous } = req();
      const answer = readRouteResponse(await handler(anonymous, ctxWith({})));
      expect.soft(answer?.status, key).toBe(400);
    }
  });

  test("cancels only a run keyed by the asking client, and 404s the rest", async () => {
    const cancel = vi.fn(async () => true);
    const runs: Record<string, WorkflowRunSnapshot> = {
      mine: {
        runId: "mine",
        workflow: "remind",
        key: "kitchen",
        createdAt: NOW,
        status: "running",
      },
      theirs: {
        runId: "theirs",
        workflow: "remind",
        key: "bedroom",
        createdAt: NOW,
        status: "running",
      },
      unkeyed: { runId: "unkeyed", workflow: "remind", createdAt: NOW, status: "running" },
    };
    const ctx = ctxWith({ get: (async (id: string) => runs[id]) as WorkflowClient["get"], cancel });
    const handler = clientRunsRoutes()["DELETE /tasks/:runId"];
    if (!handler) throw new Error("no cancel route");
    const del = (runId: string | undefined) =>
      handler(req({ method: "DELETE", params: runId === undefined ? {} : { runId } }), ctx);

    expect(await del("mine")).toEqual({ cancelled: true });
    expect(cancel).toHaveBeenCalledWith("mine");
    for (const runId of ["theirs", "unkeyed", "missing", undefined]) {
      const answer = readRouteResponse(await del(runId));
      expect.soft(answer, String(runId)).toEqual({
        status: 404,
        body: { error: "No such run for this client" },
      });
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
