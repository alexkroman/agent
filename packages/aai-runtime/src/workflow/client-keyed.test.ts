// Copyright 2026 the AAI authors. MIT license.
/**
 * `findByKey` and `cancelAll` — the merge and the count, over a `find` and a
 * `cancel` given as plain functions.
 */

import { workflow } from "@alexkroman1/aai";
import { createRunSnapshot } from "@alexkroman1/aai/testing";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import { createWorkflowClient } from "./client.ts";
import { cancelAllByKey, findByKeyAcross } from "./client-keyed.ts";
import { createWorkflowEngine } from "./engine.ts";
import { createMemoryJournal } from "./journal/backends/memory.ts";
import {
  createMemoryKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
} from "./keys.ts";
import { createMemoryStreams } from "./streams.ts";

const runs: Record<string, WorkflowRunSnapshot[]> = {
  remind: [
    createRunSnapshot({ runId: "r2", workflow: "remind", createdAt: 300, status: "running" }),
    createRunSnapshot({ runId: "r1", workflow: "remind", createdAt: 100, status: "cancelled" }),
  ],
  research: [
    createRunSnapshot({
      runId: "s1",
      workflow: "research",
      createdAt: 200,
      status: "completed",
      output: "report",
    }),
  ],
  call: [],
};

const find = vi.fn(async (workflow: string, _key: string, limit: number) =>
  (runs[workflow] ?? []).slice(0, limit),
);

describe("findByKeyAcross", () => {
  test("merges every workflow's runs for the key, newest first", async () => {
    const merged = await findByKeyAcross(Object.keys(runs), find, "speaker-1");
    expect(merged.map((r) => r.runId)).toEqual(["r2", "s1", "r1"]);
    expect(find).toHaveBeenCalledWith("remind", "speaker-1", DEFAULT_WORKFLOW_FIND_LIMIT);
  });

  test("filters by since (number or Date) and by statuses", async () => {
    const names = Object.keys(runs);
    expect((await findByKeyAcross(names, find, "k", { since: 200 })).map((r) => r.runId)).toEqual([
      "r2",
      "s1",
    ]);
    expect(
      (await findByKeyAcross(names, find, "k", { since: new Date(250) })).map((r) => r.runId),
    ).toEqual(["r2"]);
    expect(
      (await findByKeyAcross(names, find, "k", { statuses: ["completed", "cancelled"] })).map(
        (r) => r.runId,
      ),
    ).toEqual(["s1", "r1"]);
  });

  test("caps the merged list at the clamped limit", async () => {
    const merged = await findByKeyAcross(Object.keys(runs), find, "k", { limit: 2 });
    expect(merged.map((r) => r.runId)).toEqual(["r2", "s1"]);
    await findByKeyAcross(["remind"], find, "k", { limit: 10_000 });
    expect(find).toHaveBeenLastCalledWith("remind", "k", MAX_WORKFLOW_FIND_LIMIT);
  });

  test("breaks a createdAt tie by run id, newest id first", async () => {
    const tie = vi.fn(async () => [
      createRunSnapshot({ runId: "a", createdAt: 1 }),
      createRunSnapshot({ runId: "b", createdAt: 1 }),
    ]);
    expect((await findByKeyAcross(["w"], tie, "k")).map((r) => r.runId)).toEqual(["b", "a"]);
  });
});

describe("cancelAllByKey", () => {
  test("cancels only unfinished runs and counts the cancels that ended one", async () => {
    const pending = [
      createRunSnapshot({ runId: "p1", status: "pending" }),
      createRunSnapshot({ runId: "p2", status: "running" }),
      createRunSnapshot({ runId: "p3", status: "running" }),
      createRunSnapshot({ runId: "done", status: "completed", output: null }),
    ];
    // p3 finished between the read and its cancel.
    const cancel = vi.fn(async (runId: string) => runId !== "p3");
    const count = await cancelAllByKey("remind", async () => pending, cancel, "speaker-1");
    expect(count).toBe(2);
    expect(cancel.mock.calls.map(([id]) => id)).toEqual(["p1", "p2", "p3"]);
  });

  test("reads the widest page one key lookup allows", async () => {
    const lookup = vi.fn(async () => []);
    expect(await cancelAllByKey("remind", lookup, vi.fn(), "k")).toBe(0);
    expect(lookup).toHaveBeenCalledWith("remind", "k", MAX_WORKFLOW_FIND_LIMIT);
  });
});

describe("ctx.workflows over a real engine", () => {
  const remind = workflow({ run: () => "said" });
  const research = workflow({ run: () => "report" });

  function client() {
    const workflows = { remind, research };
    let n = 0;
    const wdk = createWorkflowEngine({
      workflows,
      journal: createMemoryJournal(),
      streams: createMemoryStreams(),
      dispatch: () => undefined,
      newRunId: () => `wrun_${String(++n).padStart(3, "0")}`,
      logger: silentLogger,
    });
    return createWorkflowClient({
      workflows,
      keys: createMemoryKeyStore(),
      wdk,
      logger: silentLogger,
    });
  }

  test("findByKey finds a key's runs across every declared workflow", async () => {
    const workflows = client();
    const a = await workflows.start(remind, {}, { key: "speaker-1" });
    const b = await workflows.start(research, {}, { key: "speaker-1" });
    await workflows.start(research, {}, { key: "speaker-2" });
    const found = await workflows.findByKey("speaker-1");
    expect(new Set(found.map((r) => r.runId))).toEqual(new Set([a, b]));
    expect(found.every((r) => r.key === "speaker-1")).toBe(true);
    expect(await workflows.findByKey("speaker-1", { statuses: ["completed"] })).toEqual([]);
  });

  test("cancelAll cancels the key's unfinished runs of one workflow and counts them", async () => {
    const workflows = client();
    await workflows.start(remind, {}, { key: "speaker-1" });
    await workflows.start(remind, {}, { key: "speaker-1" });
    const other = await workflows.start(research, {}, { key: "speaker-1" });
    expect(await workflows.cancelAll(remind, "speaker-1")).toBe(2);
    expect(await workflows.cancelAll("remind", "speaker-1")).toBe(0);
    expect((await workflows.get(other))?.status).toBe("pending");
  });

  test("start with a dedupeKey answers the first run, and still records the key", async () => {
    const workflows = client();
    const first = await workflows.start(remind, {}, { key: "speaker-1", dedupeKey: "evt_9" });
    const again = await workflows.start(remind, {}, { key: "speaker-1", dedupeKey: "evt_9" });
    expect(again).toBe(first);
    expect((await workflows.find(remind, "speaker-1")).map((r) => r.runId)).toEqual([first]);
  });
});
