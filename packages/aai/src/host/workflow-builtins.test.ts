// Copyright 2026 the AAI authors. MIT license.
/**
 * The three run builtins over a stubbed `ctx.workflows`: keyed by the session,
 * narrowed by `workflow`, and saying the author's line.
 */

import { describe, expect, test, vi } from "vitest";
import { createToolContext } from "../sdk/_testing-context.ts";
import {
  createRunSnapshot,
  createStubWorkflows,
  type RunSnapshotOverrides,
} from "../sdk/testing-workflows.ts";
import type { WorkflowDef } from "../sdk/workflow.ts";
import type { WorkflowRunSnapshot } from "../sdk/workflow-run.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";
import { WORKFLOW_BUILTINS } from "./workflow-builtins.ts";

const digest: WorkflowDef = {
  run: async () => ({}),
  describeRun: (run) => `Digest is ${run.status}.`,
  cancelNote: "Okay, I've dropped the digest.",
};
const declared = { digest, other: { run: async () => ({}) } satisfies WorkflowDef };

/** Snapshots for `(digest, sess-1)`, numbered — `running` unless the override says. */
function runs(...list: RunSnapshotOverrides[]): WorkflowRunSnapshot[] {
  return list.map((r, i) => {
    const base = { runId: `wrun_${i}`, workflow: "digest", key: "sess-1" };
    return createRunSnapshot(
      r.status === undefined ? { ...base, ...r, status: "running" } : { ...base, ...r },
    );
  });
}

/** A tool context whose session is `sess-1`, over the given client fakes. */
function harness(over: Parameters<typeof createStubWorkflows>[0]) {
  const workflows = createStubWorkflows(over);
  const ctx = createToolContext({ sessionId: "sess-1", workflows });
  const tools = resolveAllBuiltins(["workflow_status", "workflow_progress", "workflow_cancel"], {
    workflows: declared,
  }).defs;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools[name]?.execute(args, ctx);
  return { call, workflows };
}

describe("registration", () => {
  test("the three resolve, with guidance, and without a `workflows` record", () => {
    const { schemas, guidance } = resolveAllBuiltins(Object.keys(WORKFLOW_BUILTINS));
    expect(schemas.map((s) => s.name)).toEqual([
      "workflow_status",
      "workflow_progress",
      "workflow_cancel",
    ]);
    expect(guidance).toHaveLength(3);
  });
});

describe("workflow_status", () => {
  test("lists the session's newest runs across every workflow, each with the author's line", async () => {
    const findByKey = vi.fn(async () =>
      runs({ status: "completed", output: 1 }, { workflow: "other" }),
    );
    const { call } = harness({ findByKey });
    expect(await call("workflow_status")).toEqual({
      runs: [
        { runId: "wrun_0", workflow: "digest", status: "completed", line: "Digest is completed." },
        {
          runId: "wrun_1",
          workflow: "other",
          status: "running",
          line: "the other run is still in progress.",
        },
      ],
    });
    // Keyed by the SESSION, three at most, and the outputs left unread.
    expect(findByKey).toHaveBeenCalledWith("sess-1", { limit: 3, withOutput: false });
  });

  test("narrows to one workflow through `find`, and says when nothing was started", async () => {
    const find = vi.fn(async () => []);
    const { call } = harness({ find });
    expect(await call("workflow_status", { workflow: "digest" })).toEqual({
      runs: [],
      note: "Nothing has been started yet.",
    });
    expect(find).toHaveBeenCalledWith("digest", "sess-1", { limit: 3 });
  });
});

describe("workflow_progress", () => {
  test("answers the latest run's newest line", async () => {
    const { call } = harness({
      findByKey: async () => runs({}),
      lastLine: async () => "Transcribing 0:00–0:58.",
    });
    expect(await call("workflow_progress")).toEqual({
      runId: "wrun_0",
      workflow: "digest",
      status: "running",
      line: "Transcribing 0:00–0:58.",
    });
  });

  test("falls back to the status line for a run that has written nothing", async () => {
    const { call } = harness({
      findByKey: async () => runs({ status: "pending" }),
      lastLine: async () => undefined,
    });
    expect(await call("workflow_progress")).toMatchObject({ line: "Digest is pending." });
  });

  test("says when nothing was started", async () => {
    const { call } = harness({ findByKey: async () => [] });
    expect(await call("workflow_progress")).toEqual({ note: "Nothing has been started yet." });
  });
});

describe("workflow_cancel", () => {
  test("stops the newest LIVE run and says the author's note", async () => {
    const cancel = vi.fn(async () => true);
    const { call } = harness({ findByKey: async () => runs({}), cancel });
    expect(await call("workflow_cancel")).toEqual({
      cancelled: true,
      runId: "wrun_0",
      workflow: "digest",
      note: "Okay, I've dropped the digest.",
    });
    expect(cancel).toHaveBeenCalledWith("wrun_0");
  });

  test("names the workflow when it declared no note, and reads one workflow through `live`", async () => {
    const live = vi.fn(async () => runs({ workflow: "other" })[0]);
    const { call } = harness({ live, cancel: async () => true });
    expect(await call("workflow_cancel", { workflow: "other" })).toMatchObject({
      cancelled: true,
      note: "Stopped the other run.",
    });
    expect(live).toHaveBeenCalledWith("other", "sess-1");
  });

  test("tells finished from never started", async () => {
    const finished = harness({
      findByKey: async (_key, options) =>
        options?.statuses ? [] : runs({ status: "completed", output: 1 }),
    });
    expect(await finished.call("workflow_cancel")).toEqual({
      cancelled: false,
      note: "That one had already finished.",
    });
    const nothing = harness({ findByKey: async () => [] });
    expect(await nothing.call("workflow_cancel")).toEqual({
      cancelled: false,
      note: "Nothing has been started yet.",
    });
  });

  test("a cancel that lost the race to the run finishing says so", async () => {
    const { call } = harness({ findByKey: async () => runs({}), cancel: async () => false });
    expect(await call("workflow_cancel")).toEqual({
      cancelled: false,
      note: "That one had already finished.",
    });
  });
});
