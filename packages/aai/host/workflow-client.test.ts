// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `ctx.workflows`.
 *
 * The Workflow DevKit is behind a `WdkAdapter` here, which is the point of that
 * seam: what these assert is the TRANSLATION — name resolution, input validation
 * before a run exists, the snapshot's discriminated shape, and the two failure
 * decisions that are easy to get backwards (a key write that fails must not fail
 * the start; a `find` result whose run has aged out must not fail the lookup).
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { ToolInputSchema } from "../sdk/schema.ts";
import { type WorkflowBody, type WorkflowDef, workflow } from "../sdk/workflow.ts";
import { createWorkflowClient, type WdkAdapter, type WdkRunRecord } from "./workflow-client.ts";
import { createMemoryKeyStore, type WorkflowKeyStore } from "./workflow-keys.ts";

/** A `"use workflow"` body as the compiler leaves it — the id is what start reads. */
function body<I, R>(id: string, result?: R): WorkflowBody<I, R> {
  const fn = (() => Promise.resolve(result as R)) as WorkflowBody<I, R>;
  fn.workflowId = id;
  return fn;
}

/**
 * The compiler's identifier for `digest` — what WDK stores as `workflowName`.
 *
 * Spelled out as a constant because the fake below has to answer with it: a
 * record carrying the DECLARED name instead is the shape that let `recent` and
 * the snapshot's `workflow` field both report the wrong string with every spec
 * in this file green.
 */
const DIGEST_ID = "workflow//./workflows/digest//digestFlow";

const digest = workflow({
  description: "Research a topic",
  input: z.object({ topic: z.string() }),
  run: body<{ topic: string }, { ok: true }>(DIGEST_ID),
});

/** A workflow with no schema, to pin that validation is skipped rather than failed. */
const bare = workflow({ run: body("workflow//./workflows/bare//bareFlow") });

const silentLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

function record(over: Partial<WdkRunRecord> = {}): WdkRunRecord {
  return {
    runId: "wrun_1",
    // WDK's own vocabulary: the compiler id, not the declared key.
    workflowName: DIGEST_ID,
    status: "pending",
    createdAt: new Date("2026-08-12T00:00:00Z"),
    ...over,
  };
}

function makeAdapter(over: Partial<WdkAdapter> = {}): WdkAdapter {
  return {
    start: vi.fn(async () => "wrun_1"),
    getRun: vi.fn(async () => record()),
    listRuns: vi.fn(async () => []),
    cancel: vi.fn(async () => true),
    wakeUp: vi.fn(async () => 1),
    signal: vi.fn(async () => true),
    readStream: vi.fn(() => chunkStream([{ step: 1 }])),
    streamTail: vi.fn(async () => 0),
    readOutput: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

/** A run's written stream, as WDK's `getReadable()` hands one back. */
function chunkStream(chunks: readonly unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function makeClient(
  over: {
    workflows?: Record<string, WorkflowDef>;
    wdk?: Partial<WdkAdapter>;
    keys?: WorkflowKeyStore;
  } = {},
) {
  const wdk = makeAdapter(over.wdk);
  const keys = over.keys ?? createMemoryKeyStore();
  const client = createWorkflowClient({
    workflows: over.workflows ?? { digest, bare },
    keys,
    wdk,
    logger: silentLogger,
  });
  return { client, wdk, keys };
}

describe("starting a run", () => {
  test("resolves the declared name from the definition by identity", async () => {
    const { client, wdk, keys } = makeClient();
    await client.start(digest, { topic: "otters" }, { key: "sess-1" });
    // The workflowId reaches WDK; the NAME is what the key index records, so a
    // workflow moved between modules keeps its keys.
    expect(wdk.start).toHaveBeenCalledWith("workflow//./workflows/digest//digestFlow", [
      { topic: "otters" },
    ]);
    expect(await keys.lookup("digest", "sess-1", 10)).toEqual(["wrun_1"]);
  });

  test("accepts the name as a string for a workflow that is data", async () => {
    const { client, wdk } = makeClient();
    await client.start("digest", { topic: "otters" });
    expect(wdk.start).toHaveBeenCalledWith("workflow//./workflows/digest//digestFlow", [
      { topic: "otters" },
    ]);
  });

  test("rejects a workflow the agent does not declare, naming the declared set", async () => {
    const { client, wdk } = makeClient();
    await expect(client.start("nope")).rejects.toThrow(/not declared on this agent/);
    await expect(client.start("nope")).rejects.toThrow(/digest, bare/);
    expect(wdk.start).not.toHaveBeenCalled();
  });

  test("rejects a definition that was never wired into agent({ workflows })", async () => {
    const orphan = workflow({ run: body("workflow//./workflows/orphan//orphanFlow") });
    const { client, wdk } = makeClient();
    await expect(client.start(orphan, {})).rejects.toThrow(/not declared on this agent/);
    expect(wdk.start).not.toHaveBeenCalled();
  });

  test("validates the input BEFORE a run exists", async () => {
    const { client, wdk } = makeClient();
    // The whole reason validation is here and not in the body: a schema failure
    // inside a queued body is a failed run found later.
    await expect(client.start("digest", { topic: 42 })).rejects.toThrow(/Invalid input/);
    expect(wdk.start).not.toHaveBeenCalled();
  });

  test("passes input through unvalidated for a workflow with no schema", async () => {
    const { client, wdk } = makeClient();
    await client.start(bare, {});
    expect(wdk.start).toHaveBeenCalledWith("workflow//./workflows/bare//bareFlow", [{}]);
  });

  test("a failed key write warns and still returns the runId", async () => {
    const keys: WorkflowKeyStore = {
      record: vi.fn(async () => {
        throw new Error("index unavailable");
      }),
      lookup: vi.fn(async () => []),
    };
    const { client } = makeClient({ keys });
    // The run is already created at this point. Throwing would tell the caller
    // nothing started while the work proceeds with no handle to it.
    await expect(client.start(digest, { topic: "otters" }, { key: "k" })).resolves.toBe("wrun_1");
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  test("records no key when the caller passed none", async () => {
    const keys: WorkflowKeyStore = {
      record: vi.fn(async (): Promise<void> => undefined),
      lookup: vi.fn(async () => []),
    };
    const { client } = makeClient({ keys });
    await client.start(digest, { topic: "otters" });
    expect(keys.record).not.toHaveBeenCalled();
  });

  test("rejects a body the WDK compiler never transformed, naming the build", async () => {
    // `workflow()` guards this at declaration time, so reaching the client with
    // one means the def was built by hand — which the studio's generated code
    // could plausibly do.
    const untransformed = { run: (() => Promise.resolve()) as WorkflowBody } as WorkflowDef;
    const { client } = makeClient({ workflows: { untransformed } });
    await expect(client.start("untransformed", {})).rejects.toThrow(/use workflow/);
  });
});

describe("reading a run", () => {
  test("a completed run narrows to a typed output", async () => {
    const { client } = makeClient({
      wdk: { getRun: async () => record({ status: "completed" }) },
    });
    const run = await client.get("wrun_1", digest);
    expect(run?.status).toBe("completed");
    if (run?.status === "completed") expect(run.output).toEqual({ ok: true });
  });

  test("a failed run carries the failure message", async () => {
    const { client } = makeClient({
      wdk: { getRun: async () => record({ status: "failed", error: { message: "boom" } }) },
    });
    const run = await client.get("wrun_1");
    expect(run).toMatchObject({ status: "failed", error: "boom" });
  });

  test("a failed run with no message names the status rather than reading as empty", async () => {
    const { client } = makeClient({
      wdk: { getRun: async () => record({ status: "failed" }) },
    });
    const run = await client.get("wrun_1");
    expect(run).toMatchObject({ status: "failed", error: "Workflow run failed" });
  });

  test("a non-terminal run does not read its output", async () => {
    const readOutput = vi.fn(async () => ({ ok: true }));
    const { client } = makeClient({ wdk: { readOutput } });
    await client.get("wrun_1");
    // `readOutput` polls a live run at 1s intervals with no ceiling, so a
    // speculative read turns a snapshot into a wait for the whole run.
    expect(readOutput).not.toHaveBeenCalled();
  });

  test("resolves undefined for a run that does not exist", async () => {
    const { client } = makeClient({ wdk: { getRun: async () => undefined } });
    expect(await client.get("wrun_missing")).toBeUndefined();
  });

  test("createdAt is epoch ms whether WDK reports a Date or a number", async () => {
    const at = Date.UTC(2026, 7, 12);
    for (const createdAt of [new Date(at), at]) {
      const { client } = makeClient({ wdk: { getRun: async () => record({ createdAt }) } });
      expect((await client.get("wrun_1"))?.createdAt).toBe(at);
    }
  });
});

describe("finding runs by correlation key", () => {
  test("returns the keyed runs newest first, carrying the key", async () => {
    const keys = createMemoryKeyStore();
    await keys.record("digest", "caller-1", "wrun_old");
    await keys.record("digest", "caller-1", "wrun_new");
    const { client } = makeClient({
      keys,
      wdk: { getRun: async (runId) => record({ runId }) },
    });
    const runs = await client.find(digest, "caller-1");
    expect(runs.map((r) => r.runId)).toEqual(["wrun_new", "wrun_old"]);
    expect(runs.every((r) => r.key === "caller-1")).toBe(true);
  });

  test("drops an indexed run that has aged out rather than failing the lookup", async () => {
    const keys = createMemoryKeyStore();
    await keys.record("digest", "caller-1", "wrun_gone");
    await keys.record("digest", "caller-1", "wrun_live");
    const { client } = makeClient({
      keys,
      wdk: { getRun: async (runId) => (runId === "wrun_gone" ? undefined : record({ runId })) },
    });
    expect((await client.find(digest, "caller-1")).map((r) => r.runId)).toEqual(["wrun_live"]);
  });

  test("resolves empty for a key nothing was started with", async () => {
    const { client } = makeClient();
    expect(await client.find(digest, "never-used")).toEqual([]);
  });

  test("clamps the limit so one lookup cannot scan a whole history", async () => {
    const keys = {
      record: vi.fn(async (): Promise<void> => undefined),
      lookup: vi.fn(async () => []),
    };
    const { client } = makeClient({ keys });
    await client.find(digest, "k", { limit: 10_000 });
    expect(keys.lookup).toHaveBeenCalledWith("digest", "k", 100);
    await client.find(digest, "k", { limit: 0 });
    expect(keys.lookup).toHaveBeenCalledWith("digest", "k", 1);
  });
});

describe("recent runs", () => {
  test("lists by the COMPILER's id, which is what WDK stores runs under", async () => {
    const listRuns = vi.fn(async () => [record({ runId: "wrun_a" })]);
    const { client } = makeClient({ wdk: { listRuns } });
    const runs = await client.recent(digest, { limit: 5 });
    // The declared name matches no stored run, so passing it here reports zero
    // runs for every workflow — with nothing logged, since an empty list is
    // exactly what a workflow nobody has run yet looks like.
    expect(listRuns).toHaveBeenCalledWith(DIGEST_ID, 5);
    // No key: a keyless listing is not a lookup that matched every key, so it
    // must not present runs as if they were correlated to anything.
    expect(runs[0]?.key).toBeUndefined();
  });

  test("reports a run that a filtering store really would return", async () => {
    // The fake filters the way the world does, so a client passing the declared
    // name resolves empty here rather than being handed a run regardless.
    const stored = [record({ runId: "wrun_a" }), record({ runId: "wrun_b" })];
    const { client } = makeClient({
      wdk: { listRuns: async (id) => stored.filter((r) => r.workflowName === id) },
    });
    expect((await client.recent(digest)).map((r) => r.runId)).toEqual(["wrun_a", "wrun_b"]);
  });

  test("rejects a workflow whose body the compiler never transformed", async () => {
    // Same failure `start` reports, for the same reason: with no id there is
    // nothing to filter by, and answering "no runs" would read as an empty
    // history rather than as an untransformed build.
    const untransformed = { run: (() => Promise.resolve()) as WorkflowBody } as WorkflowDef;
    const { client } = makeClient({ workflows: { untransformed } });
    await expect(client.recent("untransformed")).rejects.toThrow(/use workflow/);
  });
});

describe("the name a snapshot reports", () => {
  test("is the key the workflow is declared under, not the compiler's id", async () => {
    // `WorkflowRunBase.workflow` says "key the workflow is declared under", and
    // agents read it aloud: `research-workflow`'s status tool puts it in a sentence
    // spoken down the phone.
    const { client } = makeClient();
    expect((await client.get("wrun_1"))?.workflow).toBe("digest");
  });

  test("is translated on every read, not just the one", async () => {
    const keys = createMemoryKeyStore();
    await keys.record("digest", "caller-1", "wrun_1");
    const { client } = makeClient({
      keys,
      wdk: { listRuns: async () => [record()] },
    });
    expect((await client.find(digest, "caller-1"))[0]?.workflow).toBe("digest");
    expect((await client.recent(digest))[0]?.workflow).toBe("digest");
  });

  test("falls back to the raw identifier for a workflow this agent no longer declares", async () => {
    // A renamed or removed workflow still has runs, and a run id can be read
    // from anywhere. The machine id is the only true thing left to say about it.
    const foreign = "workflow//./workflows/gone//goneFlow";
    const { client } = makeClient({
      wdk: { getRun: async () => record({ workflowName: foreign }) },
    });
    expect((await client.get("wrun_1"))?.workflow).toBe(foreign);
  });
});

describe("cancelling", () => {
  test("reports whether this call is what ended the run", async () => {
    const { client } = makeClient({ wdk: { cancel: async () => false } });
    expect(await client.cancel("wrun_1")).toBe(false);
  });
});

describe("signalling a parked run", () => {
  test("reports whether a hook was listening on the token", async () => {
    // `false` is the ORDINARY answer, not a failure: the run moved past its
    // hook, finished, or was never started. A voice tool says so out loud.
    const { client } = makeClient({ wdk: { signal: async () => false } });
    expect(await client.signal("retention:s_1")).toBe(false);
  });

  test("forwards the payload the caller sent", async () => {
    const signal = vi.fn(async () => true);
    const { client } = makeClient({ wdk: { signal } });
    await client.signal("retention:s_1", { keep: true });
    expect(signal).toHaveBeenCalledWith("retention:s_1", { keep: true });
  });

  test("substitutes an EMPTY OBJECT for an omitted payload, not undefined", async () => {
    // A hook resolves WITH its payload, so a body reading a field off one would
    // throw on a signal sent for its arrival alone — and `undefined` does not
    // survive the serialization a payload crosses either.
    const signal = vi.fn(async () => true);
    const { client } = makeClient({ wdk: { signal } });
    await client.signal("stop:s_1");
    expect(signal).toHaveBeenCalledWith("stop:s_1", {});
  });
});

describe("waking a sleeping run", () => {
  test("reports how many pending sleeps were interrupted", async () => {
    const { client } = makeClient({ wdk: { wakeUp: async () => 3 } });
    expect(await client.wakeUp("wrun_1")).toBe(3);
  });

  test("names no correlation ids when the caller passed none", async () => {
    const wakeUp = vi.fn(async () => 1);
    const { client } = makeClient({ wdk: { wakeUp } });
    await client.wakeUp("wrun_1");
    expect(wakeUp).toHaveBeenCalledWith("wrun_1", undefined);
  });

  test("forwards the correlation ids it was given", async () => {
    const wakeUp = vi.fn(async () => 1);
    const { client } = makeClient({ wdk: { wakeUp } });
    await client.wakeUp("wrun_1", { correlationIds: ["review"] });
    expect(wakeUp).toHaveBeenCalledWith("wrun_1", ["review"]);
  });

  test("an EMPTY id list means 'none named', not 'target nothing'", async () => {
    // WDK reads a present-but-empty list as a filter matching no sleep, so a
    // caller building the array from a filter that happened to yield nothing
    // would wake nothing while reading as "wake everything".
    const wakeUp = vi.fn(async () => 1);
    const { client } = makeClient({ wdk: { wakeUp } });
    await client.wakeUp("wrun_1", { correlationIds: [] });
    expect(wakeUp).toHaveBeenCalledWith("wrun_1", undefined);
  });
});

describe("reading a run's written stream", () => {
  test("resolves the chunks the run wrote", async () => {
    const { client } = makeClient({ wdk: { readStream: () => chunkStream(["a", "b"]) } });
    const stream = await client.stream("wrun_1");
    const seen: unknown[] = [];
    for await (const chunk of stream) seen.push(chunk);
    expect(seen).toEqual(["a", "b"]);
  });

  test("forwards namespace and startIndex", async () => {
    const readStream = vi.fn(() => chunkStream([]));
    const { client } = makeClient({ wdk: { readStream } });
    await client.stream("wrun_1", { namespace: "logs", startIndex: -2 });
    expect(readStream).toHaveBeenCalledWith("wrun_1", { namespace: "logs", startIndex: -2 });
  });

  test("passes undefined for options the caller omitted", async () => {
    const readStream = vi.fn(() => chunkStream([]));
    const { client } = makeClient({ wdk: { readStream } });
    await client.stream("wrun_1");
    expect(readStream).toHaveBeenCalledWith("wrun_1", {
      namespace: undefined,
      startIndex: undefined,
    });
  });
});

describe("listing declared workflows", () => {
  test("names each workflow with its description and a JSON Schema for its input", () => {
    const { client } = makeClient();
    const listing = client.listing();
    expect(listing).toHaveLength(2);
    const [first] = listing;
    expect(first?.name).toBe("digest");
    expect(first?.description).toBe("Research a topic");
    expect(first?.inputSchema).toMatchObject({
      type: "object",
      properties: { topic: { type: "string" } },
    });
  });

  test("omits the schema for a workflow that declares none", () => {
    const { client } = makeClient();
    const bareSummary = client.listing().find((w) => w.name === "bare");
    expect(bareSummary).toEqual({ name: "bare" });
  });

  test("a schema that cannot convert warns rather than taking the listing down", () => {
    // The listing feeds `workflow_status` as well as a page's form, so an
    // unconvertible schema must not make the status tool unusable.
    // A REAL Standard Schema that simply cannot convert: zod converts natively
    // and other vendors need a `toJsonSchema()`, so one with neither validates
    // fine and fails the JSON Schema step. Built type-safely rather than cast,
    // which is what keeps the escape-hatch ratchet where it is.
    const unconvertibleInput: ToolInputSchema = {
      "~standard": {
        version: 1,
        vendor: "no-json-schema",
        validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
      },
    };
    const unconvertible: WorkflowDef = {
      run: body("workflow//./workflows/x//x"),
      input: unconvertibleInput,
    };
    const { client } = makeClient({ workflows: { unconvertible } });
    expect(() => client.listing()).not.toThrow();
    expect(client.listing()[0]?.inputSchema).toBeUndefined();
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});
