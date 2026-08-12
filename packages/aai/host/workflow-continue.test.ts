// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.continueAs` — ending a run and handing its work to a successor.
 *
 * Its own file because `workflow-engine.test.ts` reached the 700-line cap, and
 * this is one coherent behaviour: the handoff, what the successor inherits, and
 * the two ways it can go wrong (a bad successor input, and a chain with no
 * termination condition).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { WorkflowDef } from "../sdk/workflow.ts";
import { workflow } from "../sdk/workflow.ts";
import { MAX_CONTINUATIONS } from "../sdk/workflow-limits.ts";
import {
  asStatus,
  createMemoryWorkflowStore,
  type MemoryWorkflowStore,
} from "./_workflow-test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";

/**
 * Drain the microtask chain a run executes on, without spending wall-clock
 * time. `start()` deliberately does not await `execute` (that is the whole
 * point of it), so a spec has to pump the loop to observe the outcome —
 * `vi.waitFor` would poll in REAL time against fake timers, which is the one
 * thing the repo's timer guidance says not to do.
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
  // Returned rather than discarded: the determinism-drift report has no other
  // observable effect — it deliberately does not fail the run — so the log IS the
  // behaviour under test.
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
function _loggedErrors(logger: { error: ReturnType<typeof vi.fn> }): string {
  return logger.error.mock.calls.map((call) => String(call[0])).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

describe("continueAs", () => {
  test("completes this run pointing at a successor that starts fresh", async () => {
    // `MAX_WORKFLOW_STEPS` is a hard cap sized under the row limit replay reads
    // the journal through, so a long loop is not expressible as ONE run at all.
    // Splitting it at a checkpoint is, and the successor's empty journal is the
    // whole point.
    const windows: number[] = [];
    const { engine, store } = makeEngine({
      reindex: workflow({
        async run(input: unknown, ctx) {
          const from = (input as { from?: number }).from ?? 0;
          windows.push(from);
          await ctx.step("page", () => from);
          if (from >= 2) return { finished: from };
          return ctx.continueAs({ from: from + 1 });
        },
      }),
    });

    const first = await engine.start("reindex", { from: 0 });
    await drain(40);

    // Three runs, one window each, and each with its own single-entry journal.
    expect(windows).toEqual([0, 1, 2]);
    expect(store.runs.size).toBe(3);
    const firstRun = asStatus(await engine.get(first), "completed");
    const successor = (firstRun.output as { continuedAs: string }).continuedAs;
    // A caller polling the OLD id can follow the chain rather than seeing a run
    // that stopped for no visible reason.
    expect(typeof successor).toBe("string");
    expect(store.row(successor).steps.size).toBe(1);
    engine.close();
  });

  test("the successor inherits the correlation key, so find still answers", async () => {
    const { engine } = makeEngine({
      chain: workflow({
        run(input: unknown, ctx) {
          const done = (input as { done?: boolean }).done ?? false;
          return done ? "end" : ctx.continueAs({ done: true });
        },
      }),
    });

    await engine.start("chain", { done: false }, { key: "session-3" });
    await drain(30);

    // Both runs under one key: the whole reason `workflow_status` keeps working
    // across a continuation without the caller re-keying anything.
    const found = await engine.find("chain", "session-3");
    expect(found).toHaveLength(2);
    expect(found.every((run) => run.key === "session-3")).toBe(true);
    engine.close();
  });

  test("validates the successor's input against the workflow's own schema", async () => {
    const { engine } = makeEngine({
      typed: workflow({
        input: z.object({ n: z.number() }),
        run: (_input, ctx) => ctx.continueAs({ n: "not a number" }),
      }),
    });

    const runId = await engine.start("typed", { n: 1 });
    await drain(20);

    // Caught at the handoff rather than on the successor's first replay, which
    // would be a run that exists and can never make progress.
    const snapshot = asStatus(await engine.get(runId), "failed");
    expect(snapshot.error).toContain("Invalid input");
    engine.close();
  });

  test("fails an UNCONDITIONAL continueAs rather than chaining forever", async () => {
    // An infinite chain of runs that bills forever, and it is easy to write —
    // this suite's own first draft did it and hung. Failed rather than silently
    // stopped, because a chain that just ended would look like success.
    const { engine, store } = makeEngine({
      forever: workflow({ run: (_input, ctx) => ctx.continueAs({}) }),
    });

    const runId = await engine.start("forever", {});
    // Enough turns to run well past the cap if nothing stopped it.
    await drain(MAX_CONTINUATIONS * 4);

    const chain = [...store.runs.values()];
    expect(chain.length).toBeLessThanOrEqual(MAX_CONTINUATIONS + 1);
    const failed = chain.filter((run) => run.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("needs a termination condition");
    // The first run still handed off normally — the cap bites at the END of the
    // chain, not at its start.
    expect(asStatus(await engine.get(runId), "completed").output).toHaveProperty("continuedAs");
    engine.close();
  });
});
