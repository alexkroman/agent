// Copyright 2026 the AAI authors. MIT license.
/**
 * The `WorkflowClient` surface the engine implements — how a run is NAMED, found,
 * and stopped, plus the two diagnostics that make an authoring mistake visible.
 *
 * Split from `workflow-engine.test.ts`, which keeps the run LIFECYCLE (replay,
 * retry, durable sleep, lease recovery, the journal cap). The line is the same one
 * the source is split along: that file is about executing a run, this one is about
 * the API a caller reaches it through.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { WorkflowDef } from "../sdk/workflow.ts";
import { MAX_WORKFLOW_FIND_LIMIT, workflow } from "../sdk/workflow.ts";
import {
  asStatus,
  createMemoryWorkflowStore,
  type MemoryWorkflowStore,
} from "./_workflow-test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";

/**
 * Drain the microtask chain a run executes on, without spending wall-clock time.
 * `start()` deliberately does not await `execute`, so a spec has to pump the loop
 * to observe the outcome — see the note in `workflow-engine.test.ts`.
 */
async function drain(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0);
}

function makeEngine(
  workflows: Record<string, WorkflowDef>,
  store: MemoryWorkflowStore = createMemoryWorkflowStore(),
): {
  engine: WorkflowEngine;
  store: MemoryWorkflowStore;
  logger: { error: ReturnType<typeof vi.fn> };
} {
  // The logger is returned rather than discarded: the determinism-drift report has
  // no other observable effect — it deliberately does not fail the run — so the log
  // IS the behaviour under test.
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const engine = createWorkflowEngine({
    workflows,
    store,
    db: { query: () => Promise.resolve([]) },
    env: { API_KEY: "k" },
    generate: undefined,
    logger,
  });
  return { engine, store, logger };
}

/** Every message `logger.error` received, joined — for a substring assertion. */
function loggedErrors(logger: { error: ReturnType<typeof vi.fn> }): string {
  return logger.error.mock.calls.map((call) => String(call[0])).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

describe("naming a workflow by its definition", () => {
  test("resolves the declared name by identity and journals it", async () => {
    const digest = workflow({
      input: z.object({ topic: z.string() }),
      run: (input) => `on ${input.topic}`,
    });
    const { engine, store } = makeEngine({ digest });

    // The workflow itself, not the string "digest" — which is what makes the
    // input typed and a misspelling a compile error rather than a rejection.
    const runId = await engine.start(digest, { topic: "ai" });
    await drain();

    expect(asStatus(await engine.get(runId), "completed").output).toBe("on ai");
    // The name the journal records still comes from the declaration record, so a
    // rename stays a one-place edit.
    expect(store.row(runId).workflow).toBe("digest");
    engine.close();
  });

  test("rejects a workflow that was never declared, naming the ones that were", async () => {
    const declared = workflow({ run: () => 1 });
    const orphan = workflow({ run: () => 2 });
    const { engine } = makeEngine({ declared });

    await expect(engine.start(orphan, {})).rejects.toThrow(
      /not declared on this agent.*Declared workflows: declared/s,
    );
    engine.close();
  });

  test("refuses a workflow declared under two names rather than picking one", async () => {
    // One object, two keys: the journal records ONE name, so choosing either
    // would make which one arbitrary — and the run would then be unfindable
    // under the other.
    const shared = workflow({ run: () => 1 });
    const { engine } = makeEngine({ first: shared, second: shared });

    await expect(engine.start(shared, {})).rejects.toThrow(
      /declared under 2 names \(first, second\)/,
    );
    engine.close();
  });

  test("still accepts a name, for a workflow chosen at runtime", async () => {
    const { engine } = makeEngine({ digest: workflow({ run: () => "by name" }) });

    const runId = await engine.start("digest");
    await drain();

    expect(asStatus(await engine.get(runId), "completed").output).toBe("by name");
    engine.close();
  });
});

describe("correlation keys", () => {
  const noop = workflow({ run: () => "ok" });

  test("finds runs started with a key, newest first", async () => {
    const { engine } = makeEngine({ noop });

    const first = await engine.start(noop, {}, { key: "session-7" });
    const second = await engine.start(noop, {}, { key: "session-7" });
    await engine.start(noop, {}, { key: "session-8" });
    await drain();

    const mine = await engine.find(noop, "session-7");
    expect(mine.map((run) => run.runId)).toEqual([second, first]);
    // The key rides the snapshot, so a caller holding several can tell them apart.
    expect(mine[0]?.key).toBe("session-7");
    engine.close();
  });

  test("resolves an empty list for a key nothing used", async () => {
    const { engine } = makeEngine({ noop });
    await engine.start(noop, {}, { key: "session-7" });
    await drain();

    await expect(engine.find(noop, "session-9")).resolves.toEqual([]);
    engine.close();
  });

  test("a run started without a key is invisible to find", async () => {
    // Deliberate: an unkeyed run belongs to a page holding its own runId, not to
    // a conversation, so it must not surface in a session-scoped lookup.
    const { engine } = makeEngine({ noop });
    // `{}` rather than nothing: the definition overload REQUIRES an input, so a
    // workflow that declares a schema cannot be started without one by omission.
    await engine.start(noop, {});
    await drain();

    await expect(engine.find(noop, "session-7")).resolves.toEqual([]);
    engine.close();
  });

  test("clamps the limit instead of failing the caller", async () => {
    const store = createMemoryWorkflowStore();
    const findByKey = vi.spyOn(store, "findByKey");
    const { engine } = makeEngine({ noop }, store);

    await engine.find(noop, "k", { limit: 10_000 });
    await engine.find(noop, "k", { limit: 0 });

    // Reached from tool code answering "is it ready?", so a stray number costs
    // the ceiling rather than the turn.
    expect(findByKey.mock.calls.map((call) => call[2])).toEqual([MAX_WORKFLOW_FIND_LIMIT, 1]);
    engine.close();
  });
});

describe("cancel", () => {
  test("stops a pending run before it ever executes", async () => {
    const body = vi.fn(() => "ran");
    const store = createMemoryWorkflowStore();
    // Seeded through the store rather than `start`, so nothing claims it before
    // the cancel lands — `start` kicks off execution immediately by design.
    await store.create("r1", "slow", null);
    const { engine } = makeEngine({ slow: workflow({ run: body }) }, store);

    await expect(engine.cancel("r1")).resolves.toBe(true);
    // A cancelled run is not claimable, so recovery must not pick it up either.
    await engine.runDue();
    await drain();

    expect(body).not.toHaveBeenCalled();
    expect(asStatus(await engine.get("r1"), "cancelled").runId).toBe("r1");
    engine.close();
  });

  test("aborts ctx.signal for a run executing here, and the status stays cancelled", async () => {
    const gate = Promise.withResolvers<string>();
    let abortedInStep: boolean | undefined;
    const { engine } = makeEngine({
      slow: workflow({
        run: (_input, ctx) =>
          ctx.step("wait", async () => {
            await gate.promise;
            abortedInStep = ctx.signal.aborted;
            return "late";
          }),
      }),
    });

    const runId = await engine.start("slow");
    await drain();
    await expect(engine.cancel(runId)).resolves.toBe(true);
    gate.resolve("late");
    await drain();

    expect(abortedInStep).toBe(true);
    // The step finished and the run returned, so `complete` was attempted — and
    // refused, because a cancelled run is terminal. That refusal is the whole
    // cross-replica story: work may be wasted, the status is never overwritten.
    expect(asStatus(await engine.get(runId), "cancelled").runId).toBe(runId);
    engine.close();
  });

  test("a step that throws after a cancel is not recorded as a failure", async () => {
    const gate = Promise.withResolvers<never>();
    const { engine, logger } = makeEngine({
      slow: workflow({
        run: (_input, ctx) => ctx.step("wait", () => gate.promise, { maxAttempts: 1 }),
      }),
    });

    const runId = await engine.start("slow");
    await drain();
    await engine.cancel(runId);
    gate.reject(new Error("aborted mid-flight"));
    await drain();

    // `failed` would lose the distinction the caller asked for by cancelling.
    expect(asStatus(await engine.get(runId), "cancelled").runId).toBe(runId);
    expect(loggedErrors(logger)).toContain("cancelled mid-step");
    engine.close();
  });

  test("resolves false for a run that already finished", async () => {
    const { engine } = makeEngine({ quick: workflow({ run: () => "done" }) });

    const runId = await engine.start("quick");
    await drain();

    // Not an error: two tabs pressing Stop is ordinary, and the run is terminal
    // either way.
    await expect(engine.cancel(runId)).resolves.toBe(false);
    expect(asStatus(await engine.get(runId), "completed").output).toBe("done");
    engine.close();
  });
});

describe("determinism", () => {
  test("reports journaled steps a replay never re-claimed", async () => {
    let pass = 0;
    const { engine, logger } = makeEngine({
      drifty: workflow({
        async run(_input, ctx) {
          pass += 1;
          // A body that branches on state outside the journal — the mistake the
          // report exists to name. On the replay this step is skipped, so its
          // journal entry is orphaned and the work it recorded is lost.
          if (pass === 1) await ctx.step("only-on-first", () => 1);
          await ctx.step("always", () => 2);
          await ctx.sleep(10_000);
          return "done";
        },
      }),
    });

    const runId = await engine.start("drifty");
    await drain();
    // First life claimed everything it journaled, so nothing is reported yet.
    expect(loggedErrors(logger)).not.toContain("did not replay");

    await vi.advanceTimersByTimeAsync(10_000);
    await drain();

    expect(asStatus(await engine.get(runId), "completed").output).toBe("done");
    const logged = loggedErrors(logger);
    expect(logged).toContain("did not replay 1 journaled step(s)");
    expect(logged).toContain("s:only-on-first#0");
    expect(logged).toContain("Date.now()");
    engine.close();
  });

  test("a step whose result cannot be journaled fails the run, naming the path", async () => {
    const { engine } = makeEngine({
      dated: workflow({ run: (_input, ctx) => ctx.step("when", () => ({ at: new Date() })) }),
    });

    const runId = await engine.start("dated");
    await drain();

    // Fails on the FIRST execution rather than returning a string on the resume,
    // which is the whole point of checking at the boundary.
    const snapshot = asStatus(await engine.get(runId), "failed");
    expect(snapshot.error).toContain("a Date at the result.at");
    expect(snapshot.error).toContain("read back on the next");
    engine.close();
  });
});
