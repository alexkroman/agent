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
import { cancelAllByKey, findByKeyAcross, type KeyedReadScope, keyedFind } from "./client-keyed.ts";
import { createWorkflowEngine } from "./engine.ts";
import { createMemoryJournal } from "./journal/backends/memory.ts";
import {
  createMemoryKeyStore,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_FIND_LIMIT,
} from "./keys.ts";
import { createMemoryStreams } from "./streams.ts";
import type { WdkAdapter, WdkRunRecord } from "./wdk-types.ts";

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
    expect(find).toHaveBeenCalledWith(
      "remind",
      "speaker-1",
      DEFAULT_WORKFLOW_FIND_LIMIT,
      expect.objectContaining({ withOutput: true }),
    );
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
    expect(find).toHaveBeenLastCalledWith(
      "remind",
      "k",
      MAX_WORKFLOW_FIND_LIMIT,
      expect.anything(),
    );
  });

  test("breaks a createdAt tie by run id, newest id first", async () => {
    const tie = vi.fn(async () => [
      createRunSnapshot({ runId: "a", createdAt: 1 }),
      createRunSnapshot({ runId: "b", createdAt: 1 }),
    ]);
    expect((await findByKeyAcross(["w"], tie, "k")).map((r) => r.runId)).toEqual(["b", "a"]);
  });
});

describe("findByKeyAcross's read scope", () => {
  const raw = (over: Partial<WdkRunRecord>): WdkRunRecord => ({
    runId: "r",
    workflowName: "remind",
    status: "completed",
    createdAt: 0,
    ...over,
  });

  test("hands find the since/statuses filters as a RAW-record predicate", async () => {
    let scope: KeyedReadScope | undefined;
    const spy = vi.fn(async (_w: string, _k: string, _l: number, s?: KeyedReadScope) => {
      scope = s;
      return [];
    });
    await findByKeyAcross(["remind"], spy, "k", { since: new Date(200), statuses: ["running"] });
    const keep = scope?.keep ?? (() => true);
    expect(keep(raw({ status: "running", createdAt: new Date(250) }))).toBe(true);
    expect(keep(raw({ status: "running", createdAt: 150 }))).toBe(false);
    expect(keep(raw({ status: "completed", createdAt: 300 }))).toBe(false);
  });

  test("withOutput: false reaches find; omitted, output is read", async () => {
    await findByKeyAcross(["remind"], find, "k", { withOutput: false });
    expect(find).toHaveBeenLastCalledWith(
      "remind",
      "k",
      DEFAULT_WORKFLOW_FIND_LIMIT,
      expect.objectContaining({ withOutput: false }),
    );
  });
});

describe("keyedFind", () => {
  const records: Record<string, WdkRunRecord> = {
    old: { runId: "old", workflowName: "remind", status: "completed", createdAt: 100 },
    now: { runId: "now", workflowName: "remind", status: "completed", createdAt: 300 },
  };

  function build() {
    const keys = createMemoryKeyStore();
    const getRun = vi.fn(async (id: string) => records[id]);
    const toSnapshot = vi.fn(async (r: WdkRunRecord, key: string, withOutput?: boolean) =>
      createRunSnapshot({
        runId: r.runId,
        key,
        status: "completed",
        output: withOutput === false ? undefined : "read",
      }),
    );
    return {
      keys,
      getRun,
      toSnapshot,
      find: keyedFind({ keys, wdk: { getRun }, toSnapshot, concurrency: 2 }),
    };
  }

  test("drops a record the scope rejects BEFORE it is snapshotted", async () => {
    const { keys, toSnapshot, find: findOne } = build();
    await keys.record("remind", "k", "old");
    await keys.record("remind", "k", "now");
    await keys.record("remind", "k", "gone");
    const found = await findOne("remind", "k", 10, {
      keep: (r) => Number(r.createdAt) >= 200,
      withOutput: false,
    });
    expect(found.map((r) => r.runId)).toEqual(["now"]);
    expect(toSnapshot).toHaveBeenCalledTimes(1);
    expect(toSnapshot).toHaveBeenCalledWith(records.now, "k", false);
  });

  test("with no scope, every record that exists is snapshotted with its output", async () => {
    const { keys, toSnapshot, find: findOne } = build();
    await keys.record("remind", "k", "old");
    await keys.record("remind", "k", "gone");
    expect((await findOne("remind", "k", 10)).map((r) => r.runId)).toEqual(["old"]);
    expect(toSnapshot).toHaveBeenCalledWith(records.old, "k", undefined);
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

  test("findByKey withOutput: false leaves a completed run's output unread", async () => {
    // An adapter whose record carries no `output`, so reading one is a
    // `readOutput` round trip — the cost the option exists to skip.
    const readOutput = vi.fn(async () => "said");
    const getRun = vi.fn(
      async (runId: string): Promise<WdkRunRecord> => ({
        runId,
        workflowName: "remind",
        status: runId === "done" ? "completed" : "running",
        createdAt: runId === "done" ? 100 : 200,
      }),
    );
    const keys = createMemoryKeyStore();
    await keys.record("remind", "speaker-1", "done");
    await keys.record("remind", "speaker-1", "live");
    const workflows = createWorkflowClient({
      workflows: { remind, research },
      keys,
      wdk: { getRun, readOutput } as Partial<WdkAdapter> as WdkAdapter,
      logger: silentLogger,
    });
    const full = await workflows.findByKey("speaker-1");
    expect(readOutput).toHaveBeenCalledOnce();
    const lean = await workflows.findByKey("speaker-1", { withOutput: false });
    expect(readOutput).toHaveBeenCalledOnce();
    expect(lean).toEqual(
      full.map((r) => (r.status === "completed" ? { ...r, output: undefined } : r)),
    );
    // A filter that rejects the completed run keeps its output unread even by default.
    readOutput.mockClear();
    const running = await workflows.findByKey("speaker-1", { statuses: ["running"] });
    expect(running.map((r) => r.runId)).toEqual(["live"]);
    expect(readOutput).not.toHaveBeenCalled();
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
