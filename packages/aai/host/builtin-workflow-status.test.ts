// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createToolContext } from "../sdk/testing.ts";
import type { WorkflowClient, WorkflowRunSnapshot } from "../sdk/workflow.ts";
import { rejectingWorkflows } from "../sdk/workflow.ts";
import { mustRun } from "./_test-utils.ts";
import {
  createWorkflowStatus,
  MAX_WORKFLOW_STATUS_OUTPUT_CHARS,
  MAX_WORKFLOW_STATUS_RUNS,
} from "./builtin-workflow-status.ts";

const tool = createWorkflowStatus();

/** A run snapshot with the fields every member carries. */
function run(over: Partial<WorkflowRunSnapshot> & { status: WorkflowRunSnapshot["status"] }) {
  return {
    runId: "r1",
    workflow: "digest",
    stepsCompleted: 2,
    ...over,
  } as WorkflowRunSnapshot;
}

/**
 * A `WorkflowClient` serving scripted runs, recording what it was asked.
 *
 * Built over `rejectingWorkflows` so the methods this builtin must NOT reach
 * (`start`, `cancel`) fail loudly if it ever does — the point of the tool is that
 * it only reads.
 */
function client(
  runs: WorkflowRunSnapshot[],
  names = ["digest"],
): WorkflowClient & { asked: { workflow: string; key: string }[] } {
  const asked: { workflow: string; key: string }[] = [];
  return {
    ...rejectingWorkflows("workflow_status must not call this"),
    asked,
    listing: () => names.map((name) => ({ name })),
    find: ((workflow: string, key: string) => {
      asked.push({ workflow, key });
      return Promise.resolve(runs.filter((r) => r.workflow === workflow));
    }) as WorkflowClient["find"],
  };
}

/** Narrow the tool's result to the reporting shape, failing loudly otherwise. */
function reportsOf(result: unknown): Record<string, unknown>[] {
  if (typeof result !== "object" || result === null || !("runs" in result)) {
    throw new Error(`expected a { runs } report, got ${JSON.stringify(result)}`);
  }
  return (result as { runs: Record<string, unknown>[] }).runs;
}

async function execute(
  workflows: WorkflowClient,
  args: { workflow?: string } = {},
  sessionId = "session-7",
): Promise<unknown> {
  const ctx = createToolContext({ workflows, sessionId });
  return await mustRun(tool)(args, ctx);
}

describe("workflow_status", () => {
  test("scopes every lookup to the calling session's key", async () => {
    const api = client([run({ status: "running" })]);

    await execute(api, {}, "session-42");

    // The model picks the WORKFLOW; the key is always this session, so no argument
    // it can produce reaches another caller's runs.
    expect(api.asked).toEqual([{ workflow: "digest", key: "session-42" }]);
  });

  test("checks every declared workflow when the model names none", async () => {
    const api = client(
      [run({ status: "running" }), run({ workflow: "reindex", status: "pending" })],
      ["digest", "reindex"],
    );

    const reports = reportsOf(await execute(api));

    expect(api.asked.map((a) => a.workflow)).toEqual(["digest", "reindex"]);
    expect(reports.map((r) => r.workflow)).toEqual(["digest", "reindex"]);
  });

  test("narrows to one workflow when the model names it", async () => {
    const api = client([run({ status: "running" })], ["digest", "reindex"]);

    await execute(api, { workflow: "digest" });

    expect(api.asked).toEqual([{ workflow: "digest", key: "session-7" }]);
  });

  test("states `finished` alongside the status", async () => {
    const api = client([
      run({ status: "completed", output: { words: 12 } }),
      run({ status: "sleeping", wakeAt: Date.now() + 90_000 }),
    ]);

    const reports = reportsOf(await execute(api));

    // A model reads "sleeping" as finished about as often as not, so the answer to
    // the question actually asked is stated rather than implied.
    expect(reports[0]).toMatchObject({ status: "completed", finished: true });
    expect(reports[1]).toMatchObject({ status: "sleeping", finished: false });
  });

  test("reports a sleeping run's wake time in seconds from now", async () => {
    const api = client([run({ status: "sleeping", wakeAt: Date.now() + 90_000 })]);

    const reports = reportsOf(await execute(api));

    // An epoch millisecond timestamp is not something a model turns into "about a
    // minute and a half" reliably, and this tool exists to be spoken.
    expect(reports[0]?.resumesInSeconds).toBe(90);
    expect(reports[0]).not.toHaveProperty("wakeAt");
  });

  test("never reports a negative wait for a run that is already due", async () => {
    const api = client([run({ status: "sleeping", wakeAt: Date.now() - 5000 })]);
    const reports = reportsOf(await execute(api));
    expect(reports[0]?.resumesInSeconds).toBe(0);
  });

  test("carries a completed run's output and a failed run's error", async () => {
    const api = client([
      run({ status: "completed", output: { words: 12 } }),
      run({ runId: "r2", status: "failed", error: "provider 503" }),
    ]);

    const reports = reportsOf(await execute(api));

    expect(reports[0]?.output).toEqual({ words: 12 });
    expect(reports[1]?.error).toBe("provider 503");
  });

  test("truncates a large output and says so", async () => {
    const output = { transcript: "x".repeat(MAX_WORKFLOW_STATUS_OUTPUT_CHARS * 2) };
    const api = client([run({ status: "completed", output })]);

    const reports = reportsOf(await execute(api));

    // Silent truncation would have the model treat a clipped document as the whole
    // answer — this is spoken material heading into its context.
    expect(String(reports[0]?.output)).toContain("truncated");
    expect(String(reports[0]?.output).length).toBeLessThan(MAX_WORKFLOW_STATUS_OUTPUT_CHARS + 100);
  });

  test("bounds how many runs one workflow contributes", async () => {
    const api = client([run({ status: "running" })]);
    const find = vi.spyOn(api, "find");

    await execute(api);

    // An agent listing every background job it ever started is not answering the
    // question; the newest few are what "is it ready?" means.
    expect(find.mock.calls[0]?.[2]).toEqual({ limit: MAX_WORKFLOW_STATUS_RUNS });
  });

  test("says so plainly when this conversation started nothing", async () => {
    const result = await execute(client([]));

    expect(result).toBe("No background work has been started in this conversation yet.");
  });

  test("reports a failure when the agent declares no workflows at all", async () => {
    const result = await execute(client([], []));

    // A `{ error }` rather than prose, so the model treats it as a tool that does
    // not apply here rather than as a fact about the caller's request.
    expect(result).toEqual({
      error: "This agent declares no workflows, so nothing runs in the background.",
    });
  });

  test("carries guidance and a schema, like every other builtin", () => {
    expect(tool.guidance).toContain("workflow_status");
    expect(tool.input).toBeDefined();
  });
});
