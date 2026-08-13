// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the research desk's four tools.
 *
 * All are exercised against a STUBBED `ctx.workflows`, which is the only honest
 * way to unit-test them: the real client needs a Workflow DevKit world, and the
 * bodies in `workflows/` are only durable once the build has transformed them.
 * What these assert is the agent's half of the contract — that the handoff tool
 * passes the correlation key, that the status tool narrows a snapshot correctly
 * before reading it aloud, and that the two tools reaching PAST a status (the
 * progress stream, the early wake) ask for what a voice reply can use.
 */

import type { WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai";
import { createStubWorkflows, createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import agentDef, { research } from "./agent.ts";

/**
 * A `ctx.workflows` that records `start` and answers `find` from a fixture.
 *
 * Returned WITHOUT a cast, which is the property worth keeping: a cast would
 * also stop reporting the day `WorkflowClient` grows a method, and this stub is
 * how the template's tools reach the client at all. `createStubWorkflows` is
 * what keeps that affordable — it fills in the methods this desk does not
 * drive, so the day the client does grow one, only the tests that use it change.
 */
function stubWorkflows(runs: WorkflowRunSnapshot[] = []): WorkflowClient {
  return createStubWorkflows({
    start: vi.fn(async () => "wrun_stub"),
    get: vi.fn(async () => runs[0]),
    find: vi.fn(async () => runs),
    recent: vi.fn(async () => runs),
    cancel: vi.fn(async () => true),
    wakeUp: vi.fn(async () => 0),
    stream: vi.fn(async () => lineStream([])),
    // Name only: `WorkflowDef.description` is optional, so passing it through
    // would mean handing `description: undefined` to a field that does not
    // accept it. Nothing here reads the description anyway.
    listing: () => [{ name: "research" }],
  });
}

/** What a run's progress channel looks like from the read side. */
function lineStream(lines: readonly string[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const line of lines) controller.enqueue(line);
      controller.close();
    },
  });
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

describe("research_progress", () => {
  test("reads the run's own progress line rather than its status", async () => {
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.stream).mockResolvedValue(lineStream(["Found 3 sources."]));
    const ctx = createToolContext({ workflows });
    const result = await agentDef.tools.research_progress?.execute({}, ctx);
    expect(result).toMatchObject({ progress: "Found 3 sources." });
  });

  test("asks for the LAST line, not the whole log", async () => {
    // A voice reply cannot recite every line the run has written.
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.stream).mockResolvedValue(lineStream(["a"]));
    await agentDef.tools.research_progress?.execute({}, createToolContext({ workflows }));
    expect(workflows.stream).toHaveBeenCalledWith("wrun_1", { startIndex: -1 });
  });

  test("a run that has written nothing yet says so rather than going silent", async () => {
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.stream).mockResolvedValue(lineStream([]));
    const result = await agentDef.tools.research_progress?.execute(
      {},
      createToolContext({ workflows }),
    );
    expect(result).toMatchObject({ note: "Started, nothing to report yet." });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await agentDef.tools.research_progress?.execute(
      {},
      createToolContext({ workflows }),
    );
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.stream).not.toHaveBeenCalled();
  });
});

describe("file_it_now", () => {
  test("wakes the sleeping run so the review wait ends early", async () => {
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(1);
    const result = await agentDef.tools.file_it_now?.execute({}, createToolContext({ workflows }));
    expect(workflows.wakeUp).toHaveBeenCalledWith("wrun_1");
    expect(result).toMatchObject({ filed: true });
  });

  test("a run that was not waiting is reported honestly, not as a failure", async () => {
    // `wakeUp` answering 0 means the run had already moved past its sleep — the
    // same shape as `cancel` answering false.
    const workflows = stubWorkflows([snapshot({ status: "running" })]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(0);
    const result = await agentDef.tools.file_it_now?.execute({}, createToolContext({ workflows }));
    expect(result).toMatchObject({ filed: false });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await agentDef.tools.file_it_now?.execute({}, createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.wakeUp).not.toHaveBeenCalled();
  });
});
