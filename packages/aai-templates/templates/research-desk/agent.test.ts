// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the research desk's two tools.
 *
 * Both are exercised against a STUBBED `ctx.workflows`, which is the only honest
 * way to unit-test them: the real client needs a Workflow DevKit world, and the
 * bodies in `workflows/` are only durable once the build has transformed them.
 * What these assert is the agent's half of the contract — that the handoff tool
 * passes the correlation key, and that the status tool narrows a snapshot
 * correctly before reading it aloud.
 */

import type { WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import agentDef, { research } from "./agent.ts";

/**
 * A `ctx.workflows` that records `start` and answers `find` from a fixture.
 *
 * Returned WITHOUT a cast, which is the property worth keeping: a cast would
 * also stop reporting the day `WorkflowClient` grows a method, and this stub is
 * how the template's tools reach the client at all.
 */
function stubWorkflows(runs: WorkflowRunSnapshot[] = []): WorkflowClient {
  return {
    start: vi.fn(async () => "wrun_stub"),
    get: vi.fn(async () => runs[0]),
    find: vi.fn(async () => runs),
    recent: vi.fn(async () => runs),
    cancel: vi.fn(async () => true),
    listing: () => [{ name: "research" }],
  };
}

function snapshot(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "research",
    createdAt: Date.UTC(2026, 7, 12),
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

describe("the agent declares its workflow", () => {
  test("under the name ctx.workflows.start resolves it by", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["research"]);
    expect(agentDef.workflows?.research).toBe(research);
  });

  test("with an input schema, so a bad topic fails at the call site", async () => {
    const result = await research.input?.["~standard"].validate({
      topic: "otters",
      requestedBy: "s",
    });
    expect(result?.issues).toBeUndefined();
    const bad = await research.input?.["~standard"].validate({ topic: "no", requestedBy: "s" });
    expect(bad?.issues).toBeDefined();
  });
});

describe("request_research", () => {
  test("starts a run keyed by the session, so a later turn can find it", async () => {
    const workflows = stubWorkflows();
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.request_research?.execute({ topic: "otters" }, ctx);

    expect(workflows.start).toHaveBeenCalledWith(
      research,
      { topic: "otters", requestedBy: ctx.sessionId },
      { key: ctx.sessionId },
    );
    expect(result).toMatchObject({ started: true, runId: "wrun_stub", topic: "otters" });
  });

  test("passes the definition rather than its name", async () => {
    const workflows = stubWorkflows();
    await agentDef.tools.request_research?.execute(
      { topic: "otters" },
      createToolContext({ workflows }),
    );
    // The def overload is what types the input and turns a rename into a compile
    // error; a string would still work at runtime and lose both.
    expect(vi.mocked(workflows.start).mock.calls[0]?.[0]).toBe(research);
  });
});

describe("research_status", () => {
  test("says nothing was started when the key has no runs", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([]) });
    const result = await agentDef.tools.research_status?.execute({}, ctx);
    expect(result).toMatchObject({ runs: [], note: "Nothing started yet." });
  });

  test("reads a completed run's summary and source count back", async () => {
    const runs = [
      snapshot({
        status: "completed",
        output: { topic: "otters", summary: "Otters use tools.", sources: 3, filedAt: "now" },
      }),
    ];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await agentDef.tools.research_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Otters use tools.");
    expect(result.runs[0]).toContain("3 sources");
  });

  test("reports a live run as still working rather than as empty", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([snapshot({ status: "running" })]) });
    const result = (await agentDef.tools.research_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Still working on it.");
  });

  test("surfaces a failed run's message instead of swallowing it", async () => {
    const runs = [snapshot({ status: "failed", error: "model unavailable" })];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await agentDef.tools.research_status?.execute({}, ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("model unavailable");
  });

  test("bounds how many past runs it reads aloud", async () => {
    const workflows = stubWorkflows([]);
    const ctx = createToolContext({ workflows });
    await agentDef.tools.research_status?.execute({}, ctx);
    // A voice reply cannot be a list of twenty runs.
    expect(workflows.find).toHaveBeenCalledWith(research, ctx.sessionId, { limit: 3 });
  });
});
