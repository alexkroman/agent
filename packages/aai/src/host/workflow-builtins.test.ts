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

/**
 * A `findByKey` over `list` that honours `statuses` and `limit`, as the client's
 * does — the builtins now ask it a STATUS question, and a fake that answered
 * every call with the same list would hide exactly the bug the question fixes.
 */
function keyedOver(list: WorkflowRunSnapshot[]) {
  return vi.fn(async (_key: string, options?: { statuses?: readonly string[]; limit?: number }) => {
    const kept = options?.statuses
      ? list.filter((run) => options.statuses?.includes(run.status))
      : list;
    return kept.slice(0, options?.limit ?? kept.length);
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
  test("lists the session's runs across every workflow, live first, each with the author's line", async () => {
    const findByKey = keyedOver(runs({ status: "completed", output: 1 }, { workflow: "other" }));
    const { call } = harness({ findByKey });
    expect(await call("workflow_status")).toEqual({
      runs: [
        {
          runId: "wrun_1",
          workflow: "other",
          status: "running",
          line: "the other run is still in progress.",
        },
        { runId: "wrun_0", workflow: "digest", status: "completed", line: "Digest is completed." },
      ],
    });
    // Keyed by the SESSION, three at most, the outputs left unread — and the
    // live ones asked for by STATUS, not picked out of the newest few.
    expect(findByKey).toHaveBeenCalledWith("sess-1", {
      limit: 3,
      statuses: ["pending", "running"],
      withOutput: false,
    });
    expect(findByKey).toHaveBeenCalledWith("sess-1", { limit: 3, withOutput: false });
  });

  test("a live run older than the newest three is still listed, first", async () => {
    // Oldest last: the parked run was started before three quick ones finished.
    const findByKey = keyedOver(
      runs(
        { status: "completed", output: 1 },
        { status: "completed", output: 2 },
        { status: "completed", output: 3 },
        { runId: "wrun_old", status: "running" },
      ),
    );
    const { call } = harness({ findByKey });
    const result = (await call("workflow_status")) as { runs: { runId: string }[] };
    expect(result.runs.map((run) => run.runId)).toEqual(["wrun_old", "wrun_0", "wrun_1"]);
  });

  test("narrows to one workflow through `find` and `live`, and says when nothing was started", async () => {
    const find = vi.fn(async () => []);
    const live = vi.fn(async () => undefined);
    const { call } = harness({ find, live });
    expect(await call("workflow_status", { workflow: "digest" })).toEqual({
      runs: [],
      note: "Nothing has been started yet.",
    });
    expect(find).toHaveBeenCalledWith("digest", "sess-1", { limit: 3 });
    expect(live).toHaveBeenCalledWith("digest", "sess-1");
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

  test("across every workflow, a STATUS read finds the live run, and tells finished from never started", async () => {
    const findByKey = keyedOver(
      runs({ status: "completed", output: 1 }, { status: "failed", error: "x" }, {}),
    );
    const cancel = vi.fn(async () => true);
    const { call } = harness({ findByKey, cancel });
    expect(await call("workflow_cancel")).toMatchObject({ cancelled: true, runId: "wrun_2" });
    expect(findByKey).toHaveBeenCalledTimes(1);
    expect(findByKey).toHaveBeenCalledWith("sess-1", {
      limit: 1,
      statuses: ["pending", "running"],
      withOutput: false,
    });

    const finished = harness({
      findByKey: keyedOver(runs({ status: "completed", output: 1 })),
    });
    expect(await finished.call("workflow_cancel")).toEqual({
      cancelled: false,
      note: "That one had already finished.",
    });
    const nothing = harness({ findByKey: keyedOver([]) });
    expect(await nothing.call("workflow_cancel")).toEqual({
      cancelled: false,
      note: "Nothing has been started yet.",
    });
  });

  test("stops a live run older than the session's newest ten", async () => {
    const quick = Array.from({ length: 10 }, (_, i) => ({
      status: "completed" as const,
      output: i,
    }));
    const findByKey = keyedOver(runs(...quick, { runId: "wrun_old", status: "running" }));
    const cancel = vi.fn(async () => true);
    const { call } = harness({ findByKey, cancel });
    expect(await call("workflow_cancel")).toMatchObject({ cancelled: true, runId: "wrun_old" });
    expect(cancel).toHaveBeenCalledWith("wrun_old");
  });

  test("a cancel that lost the race to the run finishing says so", async () => {
    const { call } = harness({ findByKey: async () => runs({}), cancel: async () => false });
    expect(await call("workflow_cancel")).toEqual({
      cancelled: false,
      note: "That one had already finished.",
    });
  });
});
