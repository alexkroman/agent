// Copyright 2026 the AAI authors. MIT license.
/**
 * The keyed conveniences and the signal conveniences on `ctx.workflows`:
 * `latest`, `live`, `signalRun`, a held `signal`, the run key reaching the
 * engine, and the timing a snapshot carries.
 */

import { workflow } from "@alexkroman1/aai";
import { DEFAULT_SIGNAL_HOLD_MS } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_logger-test-utils.ts";
import { createWorkflowClient, type WdkAdapter, type WdkRunRecord } from "./client.ts";
import { createMemoryKeyStore } from "./keys.ts";

const digest = workflow({ description: "digest", run: async () => ({ ok: true }) });

function record(over: Partial<WdkRunRecord>): WdkRunRecord {
  return { runId: "wrun_x", workflowName: "digest", status: "running", createdAt: 1, ...over };
}

/** A client over a key store seeded with `runs` for `(digest, key)`, newest first. */
function makeClient(runs: WdkRunRecord[] = [], over: Partial<WdkAdapter> = {}) {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const keys = createMemoryKeyStore();
  const wdk: WdkAdapter = {
    start: vi.fn(async () => "wrun_new"),
    getRun: vi.fn(async (id: string) => byId.get(id)),
    listRuns: vi.fn(async () => []),
    cancel: vi.fn(async () => true),
    wakeUp: vi.fn(async () => 0),
    signal: vi.fn(async () => true),
    readStream: vi.fn(() => ReadableStream.from<unknown>([])),
    streamTail: vi.fn(async () => -1),
    readOutput: vi.fn(async () => undefined),
    ...over,
  };
  const client = createWorkflowClient({
    workflows: { digest },
    keys,
    wdk,
    publicUrl: undefined,
    logger: silentLogger,
  });
  return { client, wdk, keys };
}

describe("start", () => {
  test("hands the key to the engine, which journals it for the body", async () => {
    const { client, wdk } = makeClient();
    await client.start(digest, {}, { key: "sess-1", label: "x" });
    expect(wdk.start).toHaveBeenCalledWith("digest", [{}], {
      label: "x",
      key: "sess-1",
      // The key-index write, run by the engine beside its own journaling.
      index: expect.any(Function),
    });
  });

  test("the literal `session` on the per-runtime client is NO key — nothing to resolve it to", async () => {
    const { client, wdk, keys } = makeClient();
    await client.start(digest, {}, { key: "session" });
    expect(wdk.start).toHaveBeenCalledWith("digest", [{}]);
    expect(await keys.lookup("digest", "session", 10)).toEqual([]);
  });
});

describe("latest / live", () => {
  async function seeded() {
    // Recorded oldest first; the index answers newest first.
    const runs = [
      record({ runId: "wrun_1", status: "completed", output: 1 }),
      record({ runId: "wrun_2", status: "running" }),
      record({ runId: "wrun_3", status: "failed", error: { message: "x" } }),
    ];
    const made = makeClient(runs);
    for (const r of runs) await made.keys.record("digest", "sess-1", r.runId);
    return made;
  }

  test("latest is the newest run for the key, whatever its status", async () => {
    const { client } = await seeded();
    expect(await client.latest(digest, "sess-1")).toMatchObject({
      runId: "wrun_3",
      status: "failed",
    });
    expect(await client.latest(digest, "nobody")).toBeUndefined();
  });

  test("live is the newest run still in flight, past a newer finished one", async () => {
    const { client } = await seeded();
    expect(await client.live(digest, "sess-1")).toMatchObject({
      runId: "wrun_2",
      status: "running",
    });
    expect(await client.live("digest", "nobody")).toBeUndefined();
  });

  test("a keyless call on the per-runtime client is refused: no session resolves `session`", async () => {
    const { client } = await seeded();
    // Not `undefined`: that read as "no such run" from every route, body and
    // script, which have no session for the default to mean.
    await expect(client.latest(digest)).rejects.toThrow(/this client has no session/);
    await expect(client.live(digest, "session")).rejects.toThrow(/this client has no session/);
    expect(await client.latest(digest, "sess-1")).toMatchObject({ runId: "wrun_3" });
  });
});

describe("signalRun / signal", () => {
  /** A client whose key index holds `runs` for `(digest, sess-1)`. */
  async function withRuns(runs: WdkRunRecord[]) {
    const made = makeClient(runs);
    for (const r of runs) await made.keys.record("digest", "sess-1", r.runId);
    return made;
  }

  test("signalRun derives the token and holds by default — for a run still going", async () => {
    const { client, wdk } = await withRuns([record({ runId: "wrun_1", status: "running" })]);
    await client.signalRun(digest, "sess-1", "approval", { approved: true });
    expect(wdk.signal).toHaveBeenCalledWith(
      "digest:sess-1:approval",
      { approved: true },
      { holdMs: DEFAULT_SIGNAL_HOLD_MS },
    );
  });

  test("signalRun holds NOTHING when no run under the key is live, and answers false", async () => {
    // A hold is keyed by the token alone and the token carries no run id, so a
    // hold for a run that finished or was cancelled was taken by the NEXT run
    // under the key as its own answer.
    const finished = await withRuns([
      record({ runId: "wrun_1", status: "cancelled" }),
      record({ runId: "wrun_2", status: "completed", output: 1 }),
    ]);
    finished.wdk.signal = vi.fn(async (_t, _p, o) => (o?.holdMs ?? 0) > 0);
    expect(await finished.client.signalRun(digest, "sess-1", "approval", { late: true })).toBe(
      false,
    );
    expect(finished.wdk.signal).toHaveBeenCalledWith(
      "digest:sess-1:approval",
      { late: true },
      { holdMs: 0 },
    );
    const never = makeClient();
    never.wdk.signal = vi.fn(async (_t, _p, o) => (o?.holdMs ?? 0) > 0);
    expect(await never.client.signalRun(digest, "sess-1", "approval")).toBe(false);
    expect(never.wdk.signal).toHaveBeenCalledWith("digest:sess-1:approval", {}, { holdMs: 0 });
  });

  test("a pending run counts as live: the ordinary caller signals a run it just started", async () => {
    const { client, wdk } = await withRuns([record({ runId: "wrun_1", status: "pending" })]);
    await client.signalRun(digest, "sess-1", "approval");
    expect(wdk.signal).toHaveBeenCalledWith(
      "digest:sess-1:approval",
      {},
      { holdMs: DEFAULT_SIGNAL_HOLD_MS },
    );
  });

  test("signalRun takes an explicit hold, and an empty payload for none", async () => {
    const { client, wdk } = await withRuns([record({ runId: "wrun_1", status: "running" })]);
    await client.signalRun("digest", "sess-1", "approval", undefined, { holdMs: 0 });
    expect(wdk.signal).toHaveBeenCalledWith("digest:sess-1:approval", {}, { holdMs: 0 });
  });

  test("signal passes a hold through only when asked", async () => {
    const { client, wdk } = makeClient();
    await client.signal("t", { a: 1 }, { holdMs: 5 });
    expect(wdk.signal).toHaveBeenCalledWith("t", { a: 1 }, { holdMs: 5 });
  });

  test("signalRun refuses an undeclared workflow, as `find` does — at the call", () => {
    const { client } = makeClient();
    expect(() => client.signalRun("nope", "k", "l")).toThrow(/not declared/);
  });
});

describe("a snapshot's timing", () => {
  test("carries startedAt and settledAt when the record has them, and omits them otherwise", async () => {
    const { client } = makeClient([
      record({ runId: "wrun_t", status: "completed", output: 1, startedAt: 10, settledAt: 20 }),
      record({ runId: "wrun_u" }),
    ]);
    expect(await client.get("wrun_t")).toMatchObject({ startedAt: 10, settledAt: 20 });
    const bare = await client.get("wrun_u");
    expect(bare).not.toHaveProperty("startedAt");
    expect(bare).not.toHaveProperty("settledAt");
  });
});
