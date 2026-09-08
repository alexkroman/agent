// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

/**
 * Specs for the research desk's four tools.
 *
 * All are exercised against a STUBBED `ctx.workflows`, which is the honest way
 * to unit-test a TOOL: what a tool owns is the call it makes, not what the run
 * does afterwards.
 * What these assert is the agent's half of the contract — that the handoff tool
 * passes the correlation key, that the status tool narrows a snapshot correctly
 * before reading it aloud, and that the two tools reaching PAST a status (the
 * progress stream, the early wake) ask for what a voice reply can use.
 *
 * The WORKFLOW half is `workflows.test.ts` beside this file: the steps driven
 * directly, the body on the real replay engine, and what a finished pass files.
 * The split is where the subject changes rather than where the line count did —
 * a tool's subject is the call it makes with a `ToolContext`, and a step's is
 * what it does with none.
 */

/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { WorkflowClient } from "@alexkroman1/aai";
import {
  createRunSnapshot,
  createToolContext,
  parseSchemaInput,
  schemaInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { installStubWorkflows } from "@alexkroman1/aai/testing/vitest";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test, vi } from "vitest";
import { research } from "./shared.ts";
import { REVIEW_SLEEP_ID } from "./workflows/review.ts";

/**
 * Every tool here is driven through the agent's own table, by the name the model
 * calls.
 *
 * The second parameter is args-or-context, which is `runTool`'s own shape: three
 * of this desk's four tools take no arguments, and the `{}` those calls were
 * obliged to pass sat between the two values a reader cares about.
 */
const run = toolRunner(agentDef);

/**
 * A `ctx.workflows` that records `start` and answers `find` from a fixture.
 *
 * Returned WITHOUT a cast, which is the property worth keeping: a cast would
 * also stop reporting the day `WorkflowClient` grows a method, and this stub is
 * how the template's tools reach the client at all. `installStubWorkflows`
 * (`@alexkroman1/aai/testing/vitest`) is what keeps that affordable — a `vi.fn`
 * per method over one `runs` list, filling in what this desk does not drive, so
 * the day the client does grow a method only the tests using it change.
 * `stream`/`streamTail` are left rejecting on purpose: `research_progress` reads
 * progress through `lastLine`, and composing those two by hand is the hazard
 * `lastLine` exists to remove.
 */
function stubWorkflows(runs: WorkflowRunSnapshot[] = []): WorkflowClient {
  // Name only: `WorkflowSummary.description` is optional, so passing this
  // desk's through would mean handing `description: undefined` to a field that
  // does not accept it. Nothing here reads the description anyway.
  return installStubWorkflows({ runs, names: ["research"] });
}

describe("the agent declares its workflow", () => {
  test("under the name ctx.workflows.start resolves it by", () => {
    // `toContain` rather than an exact key list: a second workflow is an
    // invited edit and must not redden a test the author did not write. The
    // NAME is still pinned, deliberately — this key is a STRING to everything
    // outside this file (the REST route, `ctx.workflows.get`, a schedule), so
    // renaming it is a runtime 404 rather than a compile error, and nothing
    // else says so.
    expect(Object.keys(agentDef.workflows ?? {})).toContain("research");
    expect(agentDef.workflows?.research).toBe(research);
  });

  test("with an input schema, so a bad topic fails at the call site", async () => {
    // `parseSchemaInput` / `schemaInputIssues` rather than a reach through
    // `["~standard"].validate`: that is the vendor WIRE contract, and whether it
    // answers synchronously or with a promise is the vendor's business — a
    // missing `await` there leaves `.issues` undefined and the refusing half
    // passes for the wrong reason.
    const parsed = await parseSchemaInput(research.input, { topic: "otters", requestedBy: "s" });
    expect(parsed).toMatchObject({ topic: "otters" });
    expect(
      await schemaInputIssues(research.input, { topic: "no", requestedBy: "s" }),
    ).toBeDefined();
  });
});

/**
 * The options `request_research` starts its run with.
 *
 * AWAITED rather than `void`-ed. Reading a mock's call list off a floating
 * promise worked only because the tool body happens to reach `start` before its
 * first `await`; anything async landing ahead of that would have made this
 * return `undefined` and the reader throw a `TypeError` instead of failing on
 * the option it is about — and the dropped promise is an unhandled rejection
 * either way.
 *
 * The return type is inferred from the mock, so `notify` arrives typed and the
 * caller needs no cast.
 */
async function workflowsStartOptions() {
  const workflows = stubWorkflows();
  const ctx = createToolContext({ workflows });
  await run("request_research", { topic: "otters" }, ctx);
  return vi.mocked(workflows.start).mock.calls[0]?.[2];
}

describe("request_research", () => {
  test("starts a run keyed by the session, so a later turn can find it", async () => {
    const workflows = stubWorkflows();
    const ctx = createToolContext({ workflows });
    const result = await run("request_research", { topic: "otters" }, ctx);

    expect(workflows.start).toHaveBeenCalledWith(
      research,
      { topic: "otters", requestedBy: ctx.sessionId },
      // `key` is the DURABLE handle — a later call finds the run by it — and
      // `notify` is the live one: this session is told when the run lands, which
      // is what makes the agent's "I'll let you know" true.
      { key: ctx.sessionId, notify: expect.stringContaining("read the summary") },
    );
    expect(result).toMatchObject({ started: true, runId: "wrun_stub", topic: "otters" });
  });

  test("asks to be TOLD when the run lands, rather than waiting to be asked", async () => {
    // The gap this closes: the agent promised an update, the run finished, and
    // nothing made it speak — so the caller had to think to ask again. A voice
    // agent that starts durable work and never announces it is the shape to
    // avoid, and one option is the whole fix.
    const options = await workflowsStartOptions();
    expect(options, "request_research started no run").toBeDefined();
    expect(typeof options?.notify).toBe("string");
  });

  test("passes the definition rather than its name", async () => {
    const workflows = stubWorkflows();
    await run("request_research", { topic: "otters" }, createToolContext({ workflows }));
    // The def overload is what types the input and turns a rename into a compile
    // error; a string would still work at runtime and lose both.
    expect(vi.mocked(workflows.start).mock.calls[0]?.[0]).toBe(research);
  });
});

describe("research_status", () => {
  test("says nothing was started when the key has no runs", async () => {
    const ctx = createToolContext({ workflows: stubWorkflows([]) });
    const result = await run("research_status", ctx);
    expect(result).toMatchObject({ runs: [], note: "Nothing started yet." });
  });

  test("reads a completed run's summary and source count back", async () => {
    const runs = [
      createRunSnapshot({
        workflow: "research",
        status: "completed",
        output: { topic: "otters", summary: "Otters use tools.", sources: 3, filedAt: "now" },
      }),
    ];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Otters use tools.");
    expect(result.runs[0]).toContain("3 sources");
  });

  test("says WHEN it was asked for, so two requests can be told apart", async () => {
    // What a caller ringing back needs. It replaces the workflow NAME, which
    // was the same word on every line and read aloud as noise.
    const runs = [
      createRunSnapshot({
        workflow: "research",
        status: "running",
        createdAt: Date.now() - 12 * 60_000,
      }),
    ];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("12 minutes ago");
    expect(result.runs[0]).not.toContain("research:");
  });

  test("a run started moments ago is not reported as zero minutes old", async () => {
    const ctx = createToolContext({
      workflows: stubWorkflows([
        createRunSnapshot({ workflow: "research", status: "running", createdAt: Date.now() }),
      ]),
    });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Just now");
  });

  test("reports a live run as still working rather than as empty", async () => {
    const ctx = createToolContext({
      workflows: stubWorkflows([createRunSnapshot({ workflow: "research", status: "running" })]),
    });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("Still working on it.");
  });

  test("surfaces a failed run's message instead of swallowing it", async () => {
    const runs = [
      createRunSnapshot({ workflow: "research", status: "failed", error: "model unavailable" }),
    ];
    const ctx = createToolContext({ workflows: stubWorkflows(runs) });
    const result = (await run("research_status", ctx)) as { runs: string[] };
    expect(result.runs[0]).toContain("model unavailable");
  });

  test("bounds how many past runs it reads aloud", async () => {
    const workflows = stubWorkflows([]);
    const ctx = createToolContext({ workflows });
    await run("research_status", ctx);
    // A voice reply cannot be a list of twenty runs.
    expect(workflows.find).toHaveBeenCalledWith(research, ctx.sessionId, { limit: 3 });
  });
});

describe("research_progress", () => {
  test("reads the run's own progress line rather than its status", async () => {
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.lastLine).mockResolvedValue("Found 3 sources.");
    const result = await run("research_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ progress: "Found 3 sources." });
  });

  test("asks for the LAST line, not the whole log", async () => {
    // A voice reply cannot recite every line the run has written. `lastLine` is
    // the whole request — the bound that keeps an empty channel from hanging
    // belongs to the method, so nothing here composes `streamTail` and `stream`.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.lastLine).mockResolvedValue("a");
    await run("research_progress", createToolContext({ workflows }));
    expect(workflows.lastLine).toHaveBeenCalledWith("wrun_1");
  });

  test("a run that has written nothing yet says so", async () => {
    // `lastLine` resolves `undefined` for an empty channel, and this is the arm
    // the tool branches on. That an empty channel does not HANG — it is never
    // closed, so a stream opened on one waits for a line that may never come —
    // is `lastLine`'s own guarantee now, and `aai`'s to test.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    const result = await run("research_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Started, nothing to report yet." });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await run("research_progress", createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.lastLine).not.toHaveBeenCalled();
  });
});

describe("file_it_now", () => {
  test("wakes the sleeping run so the review wait ends early", async () => {
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(1);
    const result = await run("file_it_now", createToolContext({ workflows }));
    expect(workflows.wakeUp).toHaveBeenCalledWith("wrun_1", {
      correlationIds: [REVIEW_SLEEP_ID],
    });
    expect(result).toMatchObject({ filed: true });
  });

  test("wakes the REVIEW wait by name, not whatever the run happens to hold", async () => {
    // The tool's description is "skip the review wait", and an un-named
    // `wakeUp(runId)` ends every suspension the run has — including an approval
    // waitpoint a later body might open, which would file a report that was
    // still waiting on a person. `review.ts` is where both sides read the id.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(1);
    await run("file_it_now", createToolContext({ workflows }));
    expect(vi.mocked(workflows.wakeUp).mock.calls[0]?.[1]?.correlationIds).toEqual([
      REVIEW_SLEEP_ID,
    ]);
  });

  test("a run that was not waiting is reported honestly, not as a failure", async () => {
    // `wakeUp` answering 0 means the run had already moved past its sleep — the
    // same shape as `cancel` answering false.
    const workflows = stubWorkflows([
      createRunSnapshot({ workflow: "research", status: "running" }),
    ]);
    vi.mocked(workflows.wakeUp).mockResolvedValue(0);
    const result = await run("file_it_now", createToolContext({ workflows }));
    expect(result).toMatchObject({ filed: false });
  });

  test("says nothing was started when the key has no runs", async () => {
    const workflows = stubWorkflows([]);
    const result = await run("file_it_now", createToolContext({ workflows }));
    expect(result).toMatchObject({ note: "Nothing started yet." });
    expect(workflows.wakeUp).not.toHaveBeenCalled();
  });
});
