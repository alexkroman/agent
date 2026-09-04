// Copyright 2026 the AAI authors. MIT license.
/**
 * The in-process engine, driven directly.
 *
 * Two things here are worth asserting rather than assuming, and both are places
 * the engine could be quietly wrong while every case looking at it passed. The
 * NARRATION is attributed by async context, so a fan-out narrating from two
 * steps at once is exactly where lines would land on the wrong run — and a
 * single-run spec cannot see that. And the four methods with no honest answer
 * (`cancel`, `wakeUp`, `signal`, plus a `start` of an unknown id) are pinned so a
 * later "improvement" that made one of them lie has to change a test that says
 * why it must not.
 */

import { workflow } from "@alexkroman1/aai";
import { stepEmit, stepEnv, stepReport } from "@alexkroman1/aai/step";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createEvalWorkflowEngine, type EvalWorkflowEngine } from "./workflow-engine.ts";

/** Released after every test — the slots this publishes are process-global. */
let engine: EvalWorkflowEngine | undefined;

afterEach(async () => {
  await engine?.release();
  engine = undefined;
});

/** How long `narrator` asks to wait. Recorded, never taken — see `EvalSleep`. */
const SLEEP_MS = 10_000;

/** A body that narrates, emits, sleeps and returns — one of each. */
const narrator = workflow({
  input: z.object({ topic: z.string() }),
  run: async (input: { topic: string }, ctx) => {
    await stepReport(`reading ${input.topic}`);
    await stepEmit("results", { topic: input.topic });
    await ctx.sleep("nap", SLEEP_MS);
    await stepReport("done");
    return { topic: input.topic, key: stepEnv("FIXTURE_KEY") };
  },
});

const thrower = workflow({
  run: async () => {
    await stepReport("about to fail");
    throw new Error("the page returned no readable text");
  },
});

/** Two steps narrating concurrently, which is what a real fan-out does. */
const fanOut = workflow({
  input: z.object({ items: z.array(z.string()) }),
  run: async (input: { items: string[] }) =>
    await Promise.all(
      input.items.map(async (item) => {
        await stepReport(`handling ${item}`);
        return item.toUpperCase();
      }),
    ),
});

function open(
  workflows: Record<string, Parameters<typeof createEvalWorkflowEngine>[0]["workflows"][string]>,
  env: Record<string, string> = { FIXTURE_KEY: "from-the-agent-env" },
): EvalWorkflowEngine {
  engine = createEvalWorkflowEngine({ workflows, env });
  return engine;
}

describe("createEvalWorkflowEngine", () => {
  test("runs the body and records what it returned, narrated, emitted and slept", async () => {
    const active = open({ narrator });
    const runId = await active.adapter.start("narrator", [{ topic: "otters" }]);
    const record = active.record(runId);
    if (record === undefined) expect.fail("the engine did not record the run it started");
    await record.settled;

    expect(record.status).toBe("completed");
    // The env came through the PUBLISHED slot, which is the seam a step reads —
    // not `process.env`.
    expect(record.output).toEqual({ topic: "otters", key: "from-the-agent-env" });
    expect(record.reported).toEqual(["reading otters", "done"]);
    expect(record.emitted).toEqual([{ namespace: "results", chunk: { topic: "otters" } }]);
    // RECORDED, not taken: a ten-second wait in a unit test would be the harness
    // pretending it can suspend.
    expect(record.slept).toEqual([{ label: "nap", duration: SLEEP_MS }]);
    expect(record.elapsedMs).toBeTypeOf("number");
  });

  test("a body that throws fails the run with its message, and keeps the narration", async () => {
    const active = open({ thrower });
    const runId = await active.adapter.start("thrower", [{}]);
    const record = active.record(runId);
    if (record === undefined) expect.fail("no record");
    await record.settled;

    expect(record.status).toBe("failed");
    expect(record.error?.message).toContain("no readable text");
    // The lines a failing run wrote are the ones worth reading.
    expect(record.reported).toEqual(["about to fail"]);
  });

  test("attributes each run's narration to that run, with two running at once", async () => {
    const active = open({ narrator });
    const first = await active.adapter.start("narrator", [{ topic: "otters" }]);
    const second = await active.adapter.start("narrator", [{ topic: "badgers" }]);
    await Promise.all([active.record(first)?.settled, active.record(second)?.settled]);

    expect(active.record(first)?.reported).toEqual(["reading otters", "done"]);
    expect(active.record(second)?.reported).toEqual(["reading badgers", "done"]);
  });

  test("keeps a fan-out's concurrent lines on their own run", async () => {
    const active = open({ fanOut });
    const runId = await active.adapter.start("fanOut", [{ items: ["a", "b", "c"] }]);
    const record = active.record(runId);
    if (record === undefined) expect.fail("no record");
    await record.settled;

    expect(record.output).toEqual(["A", "B", "C"]);
    // Order is completion order, which is what a real fan-out's log is too.
    expect([...record.reported].sort()).toEqual(["handling a", "handling b", "handling c"]);
  });

  test("lists a workflow's own runs, newest first", async () => {
    const active = open({ narrator, thrower });
    const first = await active.adapter.start("narrator", [{ topic: "one" }]);
    await active.adapter.start("thrower", [{}]);
    const third = await active.adapter.start("narrator", [{ topic: "two" }]);
    await Promise.all(active.records().map((record) => record.settled));

    const listed = await active.adapter.listRuns("narrator", 10);
    expect(listed.map((one) => one.runId)).toEqual([third, first]);
    expect(await active.adapter.listRuns("narrator", 1)).toHaveLength(1);
  });

  test("serves the report lines as the run's stream, tail included", async () => {
    const active = open({ narrator });
    const runId = await active.adapter.start("narrator", [{ topic: "otters" }]);
    await active.record(runId)?.settled;

    expect(await active.adapter.streamTail(runId, {})).toBe(1);
    expect(await drain(active.adapter.readStream(runId, {}))).toEqual(["reading otters", "done"]);
    // `-1` is what `lastLine` asks for, and it must be the last chunk ALONE
    // rather than the whole log.
    expect(await drain(active.adapter.readStream(runId, { startIndex: -1 }))).toEqual(["done"]);
    // A NON-NEGATIVE `startIndex` is an INCLUSIVE floor — the first index the
    // reader wants — which is `workflow-streams.ts`'s reading and so the contract
    // this adapter is a second implementation of. Read exclusively, a default
    // poll never delivered chunk 0.
    expect(await drain(active.adapter.readStream(runId, { startIndex: 0 }))).toEqual([
      "reading otters",
      "done",
    ]);
    expect(await drain(active.adapter.readStream(runId, { startIndex: 1 }))).toEqual(["done"]);
    expect(await drain(active.adapter.readStream(runId, { startIndex: 2 }))).toEqual([]);
    // A named stream is `stepEmit`'s, kept apart from the sentences.
    expect(await active.adapter.streamTail(runId, { namespace: "results" })).toBe(0);
    expect(await drain(active.adapter.readStream(runId, { namespace: "results" }))).toEqual([
      { topic: "otters" },
    ]);
  });

  test("reports -1 for a run it never started, rather than pretending to have one", async () => {
    const active = open({ narrator });
    expect(await active.adapter.streamTail("nope", {})).toBe(-1);
    expect(await active.adapter.getRun("nope")).toBeUndefined();
  });

  test("refuses a workflow name it does not serve, naming what it does", async () => {
    const active = open({ narrator });
    await expect(active.adapter.start("nobody-else", [{}])).rejects.toThrow(
      /has no workflow named "nobody-else"; it serves narrator/,
    );
  });

  test("cancel marks the run and says so, but cannot stop a running function", async () => {
    const active = open({ narrator });
    const runId = await active.adapter.start("narrator", [{ topic: "otters" }]);
    expect(await active.adapter.cancel(runId)).toBe(true);
    await active.record(runId)?.settled;
    // The STATUS is cancelled and the body ran to the end anyway — which is why
    // the module doc says a case must not read `true` as "the work stopped".
    expect(active.record(runId)?.status).toBe("cancelled");
    expect(active.record(runId)?.reported).toEqual(["reading otters", "done"]);
    // Already terminal, so a second cancel is an answer rather than an error.
    expect(await active.adapter.cancel(runId)).toBe(false);
  });

  test("wakeUp and signal answer rather than lying about a suspension", async () => {
    const active = open({ narrator });
    const runId = await active.adapter.start("narrator", [{ topic: "otters" }]);
    await active.record(runId)?.settled;
    // A sleep is skipped, so nothing was ever asleep; `createHook()` throws
    // untransformed, so nothing can be listening on a token.
    expect(await active.adapter.wakeUp(runId, undefined)).toBe(0);
    expect(await active.adapter.signal("any-token", {})).toBe(false);
  });

  test("release unpublishes the slots, so the next file's steps read their own", async () => {
    const active = open({ narrator });
    const runId = await active.adapter.start("narrator", [{ topic: "otters" }]);
    await active.record(runId)?.settled;
    await active.release();
    engine = undefined;

    // An unpublished env slot falls back to `process.env`, which is what makes an
    // exported step callable from an ordinary spec.
    vi.stubEnv("FIXTURE_KEY", "from-the-shell");
    expect(stepEnv("FIXTURE_KEY")).toBe("from-the-shell");
    // There is no sleep GLOBAL any more: a body's waits are `ctx.sleep`, which
    // `evalCtx` answers, so releasing the engine leaves nothing behind to unset.
  });
});

/** Every chunk of a stream, which is what an assertion wants. */
async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
