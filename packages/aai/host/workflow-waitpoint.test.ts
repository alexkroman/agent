// Copyright 2026 the AAI authors. MIT license.
/**
 * Waitpoints — `ctx.waitFor`, the token, and the HTTP signal that releases a run.
 *
 * Its own file because `workflow-engine.test.ts` reached the 700-line test cap,
 * and this is the natural seam: every other suite there is about a run the ENGINE
 * drives to completion, while these are about a run deliberately parked with
 * nothing scheduled to wake it. The harness is shared through
 * `_workflow-engine-harness.ts`.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { workflow } from "../sdk/workflow.ts";
import { drain, makeEngine } from "./_workflow-engine-harness.ts";
import { asStatus, createMemoryWorkflowStore } from "./_workflow-test-utils.ts";

// Virtual time, like every other engine suite: these specs drive the run loop with
// `advanceTimersByTimeAsync` and one of them observes a wake TIMER, so they must
// not run against the wall clock.
beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

describe("ctx.waitFor — waitpoints", () => {
  test("parks the run, resumes on the token, and replays the payload once", async () => {
    // The shape `sleep` cannot express: an approval. Done with `sleep` it is a
    // poll — wake, check, sleep — and every cycle spends journal entries against
    // MAX_WORKFLOW_STEPS, so a wait measured in days is not expressible. A
    // waitpoint costs one entry however long it waits.
    const announced: string[] = [];
    const ran: string[] = [];
    const approval = workflow({
      input: z.object({}),
      async run(_input, ctx) {
        ran.push("before");
        const decision = await ctx.waitFor<{ approved: boolean }>("approval", {
          announce: (token) => {
            announced.push(token);
          },
        });
        ran.push("after");
        return decision;
      },
    });
    const store = createMemoryWorkflowStore();
    const { engine } = makeEngine({ approval }, store);

    const runId = await engine.start(approval, {});
    await drain(30);

    // Released, not held: a parked run is `sleeping` with no wake time, so every
    // consumer that already understands a sleeper renders it correctly.
    expect((await engine.get(runId))?.status).toBe("sleeping");
    expect(store.row(runId).wakeAt).toBeUndefined();
    expect(announced).toHaveLength(1);
    expect(ran).toEqual(["before"]);

    const token = announced[0] as string;
    await expect(engine.signal(token, { approved: true })).resolves.toBe(runId);
    await drain(30);

    expect(asStatus(await engine.get(runId), "completed").output).toEqual({ approved: true });
    // `before` twice — the replay re-runs the body from the top, which is the
    // whole design — and `announce` exactly once, because it is journaled.
    expect(ran).toEqual(["before", "before", "after"]);
    expect(announced).toHaveLength(1);
  });

  test("a token is single-use, so a retrying webhook resolves the wait once", async () => {
    const wf = workflow({
      input: z.object({}),
      run: (_input, ctx) => ctx.waitFor<string>("ping"),
    });
    const store = createMemoryWorkflowStore();
    const { engine } = makeEngine({ wf }, store);
    const runId = await engine.start(wf, {});
    await drain(30);
    const token = store.row(runId).waitToken as string;

    await expect(engine.signal(token, "first")).resolves.toBe(runId);
    await drain(30);
    // The token is cleared on resume, so the second delivery finds nothing parked
    // — an ANSWER, not an error, and it cannot overwrite the journaled payload.
    await expect(engine.signal(token, "second")).resolves.toBeUndefined();
    expect(asStatus(await engine.get(runId), "completed").output).toBe("first");
  });

  test("an unknown token resolves undefined rather than throwing", async () => {
    const { engine } = makeEngine({});
    await expect(engine.signal(crypto.randomUUID(), null)).resolves.toBeUndefined();
  });

  test("a timeout is an ordinary wake time, and the wait throws at it", async () => {
    // No second mechanism: a parked run with a deadline is due exactly like a
    // sleeper, so `runDue()` and the platform wake sweep recover it unchanged.
    const wf = workflow({
      input: z.object({}),
      run: (_input, ctx) => ctx.waitFor<string>("never", { timeoutMs: 1000 }),
    });
    const store = createMemoryWorkflowStore();
    const { engine } = makeEngine({ wf }, store);
    const runId = await engine.start(wf, {});
    await drain(30);
    expect(store.row(runId).wakeAt).toBeGreaterThan(Date.now());

    await vi.advanceTimersByTimeAsync(1500);
    await drain(30);

    expect(asStatus(await engine.get(runId), "failed").error).toContain("timed out");
  });
});
