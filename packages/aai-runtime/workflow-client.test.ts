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

import type { ToolInputSchema } from "@alexkroman1/aai";
import { workflow } from "@alexkroman1/aai";
import type { WorkflowBody, WorkflowDef } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { makeLogger } from "./_test-utils.ts";
import { createWorkflowClient, type WdkAdapter, type WdkRunRecord } from "./workflow-client.ts";
import { createMemoryKeyStore, type WorkflowKeyStore } from "./workflow-keys.ts";

/** A workflow body. Identity is the key it is declared under, so this carries none. */
function body<I, R>(result?: R): WorkflowBody<I, R> {
  return (() => Promise.resolve(result as R)) as WorkflowBody<I, R>;
}

/**
 * The name `digest` is declared under — and, since the DevKit removal, the only
 * identity it has.
 *
 * Still a constant because the fake has to answer with it, and the assertion it
 * guards is unchanged in spirit: a run record whose `workflowName` disagrees
 * with the declared key is what let `recent` and the snapshot's `workflow`
 * field both report the wrong string with every spec in this file green. What
 * changed is that the two strings can no longer differ BY DESIGN rather than by
 * a translation somebody has to remember.
 */
const DIGEST_ID = "digest";

const digest = workflow({
  description: "Research a topic",
  input: z.object({ topic: z.string() }),
  run: body<{ topic: string }, { ok: true }>(),
});

/** The `createdAt` every fake run carries — asserted by both spellings WDK reports. */
const CREATED_AT = Date.UTC(2026, 7, 12);

/** A workflow with no schema, to pin that validation is skipped rather than failed. */
const bare = workflow({ run: body() });

function record(over: Partial<WdkRunRecord> = {}): WdkRunRecord {
  return {
    runId: "wrun_1",
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

/**
 * A client and the collaborators it was built with.
 *
 * The logger is FRESH per call, not a module singleton: `restoreMocks`
 * restores `vi.spyOn` mocks and touches neither the history nor the
 * implementation of a plain `vi.fn()`, so a shared one accumulates calls
 * across the whole file — and the two `toHaveBeenCalled` assertions below
 * were then satisfied by a warning an EARLIER test logged. See the doc on
 * `silentLogger` in `_test-utils.ts`, which is built from plain no-ops for
 * exactly this reason and is not for asserting on.
 */
function makeClient(
  over: {
    workflows?: Record<string, WorkflowDef>;
    wdk?: Partial<WdkAdapter>;
    keys?: WorkflowKeyStore;
    publicUrl?: string;
  } = {},
) {
  const wdk = makeAdapter(over.wdk);
  const keys = over.keys ?? createMemoryKeyStore();
  const logger = makeLogger();
  const client = createWorkflowClient({
    workflows: over.workflows ?? { digest, bare },
    keys,
    wdk,
    publicUrl: over.publicUrl,
    logger,
  });
  return { client, wdk, keys, logger };
}

describe("starting a run", () => {
  test("resolves the declared name from the definition by identity", async () => {
    const { client, wdk, keys } = makeClient();
    await client.start(digest, { topic: "otters" }, { key: "sess-1" });
    // The workflowId reaches WDK; the NAME is what the key index records, so a
    // workflow moved between modules keeps its keys.
    expect(wdk.start).toHaveBeenCalledWith(DIGEST_ID, [{ topic: "otters" }]);
    expect(await keys.lookup("digest", "sess-1", 10)).toEqual(["wrun_1"]);
  });

  test("accepts the name as a string for a workflow that is data", async () => {
    const { client, wdk } = makeClient();
    await client.start("digest", { topic: "otters" });
    expect(wdk.start).toHaveBeenCalledWith(DIGEST_ID, [{ topic: "otters" }]);
  });

  test("rejects a workflow the agent does not declare, naming the declared set", async () => {
    const { client, wdk } = makeClient();
    await expect(client.start("nope")).rejects.toThrow(/not declared on this agent/);
    await expect(client.start("nope")).rejects.toThrow(/digest, bare/);
    expect(wdk.start).not.toHaveBeenCalled();
  });

  test("rejects a definition that was never wired into agent({ workflows })", async () => {
    const orphan = workflow({ run: body() });
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
    expect(wdk.start).toHaveBeenCalledWith("bare", [{}]);
  });

  test("a failed key write warns and still returns the runId", async () => {
    const keys: WorkflowKeyStore = {
      record: vi.fn(async () => {
        throw new Error("index unavailable");
      }),
      lookup: vi.fn(async () => []),
    };
    const { client, logger } = makeClient({ keys });
    // The run is already created at this point. Throwing would tell the caller
    // nothing started while the work proceeds with no handle to it.
    await expect(client.start(digest, { topic: "otters" }, { key: "k" })).resolves.toBe("wrun_1");
    expect(logger.warn).toHaveBeenCalledWith(
      "Workflow correlation key not recorded",
      expect.objectContaining({ error: "index unavailable" }),
    );
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
});

describe("reading a run", () => {
  test("a completed run narrows to a typed output", async () => {
    const { client } = makeClient({
      wdk: { getRun: async () => record({ status: "completed", output: { ok: true } }) },
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

  test("a completed run is ONE journal read, not two", async () => {
    // `readOutput` is `getRun(runId).output` in every implementation of this
    // seam, so calling it after `getRun` is a SECOND platform POST for a value
    // the record carried, on a terminal status that cannot have changed between
    // them. Every browser reload of a finished form paid it.
    let reads = 0;
    const stored = record({ status: "completed", output: { ok: true } });
    const readOutput = vi.fn(async () => {
      reads += 1;
      return stored.output;
    });
    const { client } = makeClient({
      wdk: {
        getRun: async () => {
          reads += 1;
          return stored;
        },
        readOutput,
      },
    });
    expect(await client.get("wrun_1")).toMatchObject({ status: "completed", output: { ok: true } });
    expect(reads).toBe(1);
    expect(readOutput).not.toHaveBeenCalled();
  });

  test("an adapter whose record carries no output falls back to readOutput", async () => {
    // `WdkRunRecord.output` is OPTIONAL and the RETAINED epoch 2 template carries
    // none — retained on the written grounds that such an adapter's callers "fall
    // back to `readOutput` exactly as they did". They had stopped.
    const readOutput = vi.fn(async () => ({ late: true }));
    const { client } = makeClient({
      wdk: { getRun: async () => record({ status: "completed" }), readOutput },
    });
    expect(await client.get("wrun_1")).toMatchObject({
      status: "completed",
      output: { late: true },
    });
    expect(readOutput).toHaveBeenCalledOnce();
  });

  test("a completed run that returned nothing costs no round trip", async () => {
    // PRESENCE, not definedness: a returning-nothing body is a completed run whose
    // output IS `undefined`; a read to learn that costs the common case.
    const readOutput = vi.fn(async () => "never");
    const { client } = makeClient({
      wdk: {
        getRun: async () => ({ ...record({ status: "completed" }), output: undefined }),
        readOutput,
      },
    });
    expect(await client.get("wrun_1")).toMatchObject({ status: "completed" });
    expect(readOutput).not.toHaveBeenCalled();
  });

  test("a non-terminal run reports no output, even when the record carries one", async () => {
    // The snapshot union carries `output` on `completed` alone, and the record
    // is now where that value comes from — so a stale one on a running run must
    // not leak onto a snapshot whose status says there is no answer yet.
    const { client } = makeClient({
      wdk: { getRun: async () => record({ status: "running", output: { half: true } }) },
    });
    const run = await client.get("wrun_1");
    expect(run).toMatchObject({ status: "running" });
    expect(run && "output" in run).toBe(false);
  });

  test("resolves undefined for a run that does not exist", async () => {
    const { client } = makeClient({ wdk: { getRun: async () => undefined } });
    expect(await client.get("wrun_missing")).toBeUndefined();
  });

  test.each([
    ["a Date", new Date(CREATED_AT)],
    ["epoch ms", CREATED_AT],
  ])("createdAt is epoch ms when WDK reports %s", async (_label, createdAt) => {
    const { client } = makeClient({ wdk: { getRun: async () => record({ createdAt }) } });
    expect((await client.get("wrun_1"))?.createdAt).toBe(CREATED_AT);
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

describe("reading the newest line of a run's stream", () => {
  /**
   * A progress channel as a run really has one: chunks, and then NO close.
   *
   * This is the whole hazard. `chunkStream` above closes, so a test built on it
   * cannot tell a correct bounded read from one that would hang in production.
   */
  function openStream(chunks: readonly unknown[]): ReadableStream<unknown> {
    return new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        // Deliberately never closed — no step knows it is the last one.
      },
    });
  }

  test("an empty channel resolves undefined instead of waiting forever", async () => {
    const readStream = vi.fn(() => openStream([]));
    const { client } = makeClient({ wdk: { readStream, streamTail: async () => -1 } });
    await expect(client.lastLine("wrun_1")).resolves.toBeUndefined();
    // The proof, and the reason the method exists: on an empty channel it never
    // opens a stream at all. A read here would not fail the test — it would
    // never return.
    expect(readStream).not.toHaveBeenCalled();
  });

  test("resolves the newest chunk of a channel that is never closed", async () => {
    const written = ["older", "newest"];
    const { client } = makeClient({
      wdk: {
        // Honours `startIndex` the way WDK's own reader does, so what this
        // asserts is the chunk a real run would hand back — the assertion is
        // meaningless against a fake that replays the whole log regardless.
        readStream: (_runId, options) => openStream(written.slice(options?.startIndex ?? 0)),
        streamTail: async () => written.length - 1,
      },
    });
    await expect(client.lastLine("wrun_1")).resolves.toBe("newest");
  });

  test("asks the stream for the last chunk alone rather than replaying the log", async () => {
    const readStream = vi.fn(() => openStream(["newest"]));
    const { client } = makeClient({ wdk: { readStream, streamTail: async () => 4 } });
    await client.lastLine("wrun_1", { namespace: "logs" });
    expect(readStream).toHaveBeenCalledWith("wrun_1", { namespace: "logs", startIndex: -1 });
  });

  test("the tail is read from the same namespace the chunk is", async () => {
    const streamTail = vi.fn(async () => 0);
    const { client } = makeClient({ wdk: { streamTail, readStream: () => openStream(["a"]) } });
    await client.lastLine("wrun_1", { namespace: "logs" });
    expect(streamTail).toHaveBeenCalledWith("wrun_1", { namespace: "logs", startIndex: undefined });
  });

  test("a non-negative startIndex is a floor the run has not reached yet", async () => {
    const readStream = vi.fn(() => openStream(["a"]));
    const { client } = makeClient({ wdk: { readStream, streamTail: async () => 2 } });
    await expect(client.lastLine("wrun_1", { startIndex: 5 })).resolves.toBeUndefined();
    expect(readStream).not.toHaveBeenCalled();
  });

  test("a floor the run has reached resolves the newest chunk", async () => {
    const { client } = makeClient({
      wdk: { readStream: () => openStream(["newest"]), streamTail: async () => 5 },
    });
    await expect(client.lastLine("wrun_1", { startIndex: 5 })).resolves.toBe("newest");
  });

  test("a negative startIndex already means the end, so it is not a floor", async () => {
    const { client } = makeClient({
      wdk: { readStream: () => openStream(["newest"]), streamTail: async () => 0 },
    });
    await expect(client.lastLine("wrun_1", { startIndex: -3 })).resolves.toBe("newest");
  });

  test("a tail that promises a chunk the stream does not hold resolves undefined", async () => {
    // A race rather than a contradiction: the tail was read, then the run's
    // stream was trimmed or the namespace answered empty. It must still end.
    const { client } = makeClient({
      wdk: { readStream: () => chunkStream([]), streamTail: async () => 3 },
    });
    await expect(client.lastLine("wrun_1")).resolves.toBeUndefined();
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

  /**
   * The FAILING observation: `safeJsonSchema` converted with zod's default
   * `io: "output"`, which describes the PARSED value — so every `.default()`
   * field came back `required`, and `WorkflowSummary.input` is documented as
   * "the input schema to render". Both `podcast-digest` (five defaulted fields)
   * and `redline` (two) therefore served a form marking as mandatory exactly the
   * fields their author had given a fallback, while `validate()` next door
   * accepts the same input WITHOUT them — the two halves of one schema
   * disagreeing about one submission.
   *
   * Same fix, and the same direction, as the tool-parameter surface:
   * `toToolJsonSchema(schema, "input")`.
   */
  test("a `.default()` field is OPTIONAL in the served schema, never required", () => {
    const scheduled = workflow({
      input: z.object({ topic: z.string(), everyDays: z.number().int().default(1) }),
      run: body(),
    });
    const { client } = makeClient({ workflows: { scheduled } });
    const [summary] = client.listing();
    expect(summary?.inputSchema).toMatchObject({
      // The default still RIDES on the property, which is what a form pre-fills
      // the control from — `WorkflowFields` reads `default` and `required`
      // separately, so this is the pair that has to move together.
      properties: { everyDays: { default: 1 } },
      required: ["topic"],
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
      run: body(),
      input: unconvertibleInput,
    };
    const { client, logger } = makeClient({ workflows: { unconvertible } });
    expect(() => client.listing()).not.toThrow();
    expect(client.listing()[0]?.inputSchema).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Workflow input schema could not be converted to JSON Schema",
      expect.objectContaining({ workflow: "unconvertible" }),
    );
  });
});

describe("minting a public webhook URL", () => {
  test("composes the agent's public base URL with the DevKit's webhook route", () => {
    const { client } = makeClient({ publicUrl: "https://aai.example/digest-desk" });
    expect(client.publicWebhookUrl("approval:sess-1")).toBe(
      "https://aai.example/digest-desk/.well-known/workflow/v1/webhook/approval%3Asess-1",
    );
  });

  test("encodes the token, because the route is ONE segment", () => {
    // `webhookToken` refuses a token containing a slash, so an unencoded one
    // would mint a URL nothing routes — and the two ends derive the path from
    // the same constant precisely so they cannot disagree about that.
    const { client } = makeClient({ publicUrl: "https://aai.example/x" });
    expect(client.publicWebhookUrl("a/b")).toBe(
      "https://aai.example/x/.well-known/workflow/v1/webhook/a%2Fb",
    );
  });

  test("tolerates a trailing slash on the configured base", () => {
    // The value arrives from a boot env var, a container's PUBLIC_URL, or an
    // author's own string — a copied-in origin ending in `/` is the ordinary
    // shape of all three, and doubling the slash would 404.
    const { client } = makeClient({ publicUrl: "https://aai.example/x/ " });
    expect(client.publicWebhookUrl("t")).toBe(
      "https://aai.example/x/.well-known/workflow/v1/webhook/t",
    );
  });

  test("THROWS naming the option when no public URL is configured", () => {
    // The whole point of the method: a localhost URL handed to a payment
    // provider is the same bug with the failure moved days into the future and
    // onto somebody else's server.
    const { client } = makeClient();
    expect(() => client.publicWebhookUrl("t")).toThrow(/does not know its own public URL/);
    expect(() => client.publicWebhookUrl("t")).toThrow(/AAI_PUBLIC_ORIGIN/);
  });

  test("a blank public URL is unconfigured, not a relative base", () => {
    // An exec env built from a template can carry an empty string, and
    // `""` would mint `/.well-known/…` — a relative URL nothing can call back on.
    const { client } = makeClient({ publicUrl: "   " });
    expect(() => client.publicWebhookUrl("t")).toThrow(/does not know its own public URL/);
  });

  test("an empty token is refused", () => {
    // `webhookToken` reads an empty trailing segment as "not a webhook path", so
    // a URL minted from one is unanswerable. This one IS the model's business —
    // a tool derived a token from something absent.
    const { client } = makeClient({ publicUrl: "https://aai.example/x" });
    expect(() => client.publicWebhookUrl("")).toThrow(/token cannot be empty/);
  });
});
