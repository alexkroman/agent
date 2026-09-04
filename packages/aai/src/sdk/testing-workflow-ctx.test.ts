// Copyright 2026 the AAI authors. MIT license.
/**
 * The recorder's own spec.
 *
 * It is test infrastructure, so what matters is that it cannot LIE: a spec built
 * on it asserts what the body asked for, and a recorder that dropped an option
 * or ran a step it was told not to would make every such assertion vacuous.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createWorkflowContext, WORKFLOW_CONTEXT_NOW } from "./testing-workflow-ctx.ts";
import type { WorkflowContext } from "./workflow-ctx.ts";

/** A body exercising all three ctx methods, as a real `workflows/` module would. */
async function body(input: { topic: string }, ctx: WorkflowContext): Promise<unknown> {
  const notes = await ctx.step("research", () => `notes on ${input.topic}`, { maxAttempts: 6 });
  await ctx.sleep("settle", 10_000, { correlationId: "settle" });
  const approved = await ctx.waitFor<{ ok: boolean }>("tok_gate", { timeoutMs: 5000 });
  const filed = await ctx.step("file", () => "filed");
  return { notes, approved, filed };
}

describe("steps", () => {
  test("runs them by default and returns what they returned", async () => {
    const work = vi.fn(() => "done");
    const ctx = createWorkflowContext();
    await expect(ctx.step("research", work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
  });

  test("records the name and the attempts the body asked for", async () => {
    const ctx = createWorkflowContext({ hooks: { tok_gate: { ok: true } } });
    await body({ topic: "otters" }, ctx);
    expect(ctx.steps).toEqual([
      { name: "research", maxAttempts: 6 },
      // No options passed, so no budget claimed — which is the other half of an
      // assertion that one step's budget was RAISED.
      { name: "file", maxAttempts: undefined },
    ]);
  });

  test("records without running under `runSteps: false`", async () => {
    const work = vi.fn(() => "done");
    const ctx = createWorkflowContext({ runSteps: false });
    await expect(ctx.step("research", work)).resolves.toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(ctx.steps).toEqual([{ name: "research", maxAttempts: undefined }]);
  });

  test("a supplied result wins over running, so one expensive step can be stubbed", async () => {
    const work = vi.fn(() => "the real thing");
    const ctx = createWorkflowContext({ results: { research: "stubbed" } });
    await expect(ctx.step("research", work)).resolves.toBe("stubbed");
    expect(work).not.toHaveBeenCalled();
  });

  test("a supplied result answers under `runSteps: false` too", async () => {
    // This is what makes a body whose control flow READS its steps drivable at
    // all: without it `planAngles` resolves `undefined` and the fan-out below it
    // gets a missing list.
    const ctx = createWorkflowContext({ runSteps: false, results: { plan: ["a", "b"] } });
    await expect(ctx.step("plan", () => [])).resolves.toEqual(["a", "b"]);
  });

  test("does not answer a step named after an Object.prototype member", async () => {
    // `name in results` would find `Object.prototype.toString` and hand the body
    // a function instead of running the step — silently, in a helper whose whole
    // job is not to lie about what a body did.
    const work = vi.fn(() => "ran");
    const ctx = createWorkflowContext();
    await expect(ctx.step("toString", work)).resolves.toBe("ran");
    expect(work).toHaveBeenCalledTimes(1);
  });

  test("records a step reached twice as two entries", async () => {
    // A loop is one call site and N journal entries under the real engine, so a
    // recorder that de-duplicated by name would hide the iterations.
    const ctx = createWorkflowContext();
    await ctx.step("tick", () => 1);
    await ctx.step("tick", () => 2);
    expect(ctx.steps).toHaveLength(2);
  });
});

describe("sleeps", () => {
  test("are RECORDED rather than taken, so a schedule is assertable in milliseconds", async () => {
    const before = Date.now();
    const ctx = createWorkflowContext();
    await ctx.sleep("review-window", 6 * 60 * 60 * 1000);
    // Not waited out — the whole reason a case can assert a six-hour schedule.
    expect(Date.now() - before).toBeLessThan(1000);
    expect(ctx.slept).toEqual([
      { label: "review-window", until: 21_600_000, correlationId: undefined },
    ]);
  });

  test("carry the correlation id the body named", async () => {
    const ctx = createWorkflowContext();
    await ctx.sleep("cooldown", 10_000, { correlationId: "settle" });
    expect(ctx.slept[0]?.correlationId).toBe("settle");
    // Two different questions: `label` is which journal row the wait IS,
    // `correlationId` is which waits one `wakeUp` ends. Neither defaults
    // from the other.
    expect(ctx.slept[0]?.label).toBe("cooldown");
  });

  test("keep an absolute Date as given", async () => {
    const at = new Date("2030-01-01T00:00:00.000Z");
    const ctx = createWorkflowContext();
    await ctx.sleep("deadline", at);
    expect(ctx.slept[0]?.until).toEqual(at);
  });
});

describe("hooks", () => {
  test("answer from `hooks`, by token", async () => {
    const ctx = createWorkflowContext({ hooks: { tok_gate: { ok: true } } });
    await expect(ctx.waitFor("tok_gate")).resolves.toEqual({ ok: true });
    expect(ctx.waited).toEqual(["tok_gate"]);
  });

  test("a wait WITH a deadline and no payload resolves undefined", async () => {
    // The closed-window branch, which is what a retention gate's safe default
    // is — reached by simply not supplying an answer.
    const ctx = createWorkflowContext();
    await expect(ctx.waitFor("tok_gate", { timeoutMs: 1000 })).resolves.toBeUndefined();
  });

  test("a token named after an Object.prototype member is still unanswered", async () => {
    // Same trap as the step above, one method along: `token in hooks` would
    // resolve `valueOf` to an inherited function rather than raising.
    const ctx = createWorkflowContext();
    await expect(ctx.waitFor("valueOf")).rejects.toThrow(/no payload for hook "valueOf"/);
  });

  test("a wait with NO deadline and no payload throws, naming what to pass", async () => {
    // Rather than hanging: a spec that hangs reports a runner timeout instead of
    // the missing payload.
    const ctx = createWorkflowContext();
    await expect(ctx.waitFor("tok_gate")).rejects.toThrow(/no payload for hook "tok_gate"/);
  });
});

describe("the three journaled reads", () => {
  test("answer FIXED values by default, so a derived duration is a constant", async () => {
    const ctx = createWorkflowContext();

    // Against the real engine each of these is journaled, so the same value
    // comes back on every walk. There is one walk here and nothing to memoize,
    // which is why what matters is that the default not be a live clock: a spec
    // over a body that stamps a duration is otherwise unwritable.
    await expect(ctx.now()).resolves.toBe(WORKFLOW_CONTEXT_NOW);
    await expect(ctx.now()).resolves.toBe(WORKFLOW_CONTEXT_NOW);
    await expect(ctx.random()).resolves.toBe(0.5);
  });

  test("answer a DISTINCT uuid per reach, so two ids are not silently one", async () => {
    const ctx = createWorkflowContext();

    // A body minting two ids and getting one back is a bug a fixed default
    // would hide — which is the same failure the engine refuses inside a step.
    await expect(ctx.uuid()).resolves.toBe("uuid-0");
    await expect(ctx.uuid()).resolves.toBe("uuid-1");
  });

  test("take a value or a producer, and the producer runs once per reach", async () => {
    const fixed = createWorkflowContext({ now: 42, random: 0.25, uuid: "id_1" });
    await expect(fixed.now()).resolves.toBe(42);
    await expect(fixed.random()).resolves.toBe(0.25);
    await expect(fixed.uuid()).resolves.toBe("id_1");

    // A producer is what a body reading the clock at BOTH ends needs.
    let reach = 0;
    const walking = createWorkflowContext({ now: () => 1000 + reach++ * 3000 });
    await expect(walking.now()).resolves.toBe(1000);
    await expect(walking.now()).resolves.toBe(4000);
  });
});

describe("a declared schema", () => {
  const Count = z.object({ n: z.coerce.number() });

  test("checks a step's output, and hands back what the schema produced", async () => {
    // The same check the engine makes on the WRITE side, for the same reason:
    // a fixture that does not satisfy the body's own schema is one a deployed
    // run would refuse, and a recorder that handed it over would let a spec
    // pass on a value no real run can produce.
    const ctx = createWorkflowContext();
    await expect(ctx.step("count", () => ({ n: "3" }), { schema: Count })).resolves.toEqual({
      n: 3,
    });
    await expect(ctx.step("count", () => ({ n: "nope" }), { schema: Count })).rejects.toThrow(
      /the output of step count does not match the schema/,
    );
  });

  test("checks a `results` fixture too, which is the one a spec is most likely to get wrong", async () => {
    const ctx = createWorkflowContext({ results: { count: { n: "not a number" } } });
    await expect(ctx.step("count", () => ({ n: 1 }), { schema: Count })).rejects.toThrow(
      /the result for step count/,
    );
  });

  test("checks a hook payload, and a schema alone still leaves the wait unbounded", async () => {
    const ctx = createWorkflowContext({ hooks: { tok_gate: { approved: "yes" } } });
    await expect(
      ctx.waitFor("tok_gate", { schema: z.object({ approved: z.boolean() }) }),
    ).rejects.toThrow(/the payload for hook tok_gate/);
    // No `timeoutMs`, so an unanswered wait still has no honest answer — the
    // presence of a schema must not be read as a deadline.
    const bare = createWorkflowContext();
    await expect(bare.waitFor("tok_gate", { schema: z.object({}) })).rejects.toThrow(
      /no payload for hook "tok_gate"/,
    );
  });
});

describe("identity", () => {
  test("defaults the run id and workflow, and takes overrides", () => {
    expect(createWorkflowContext()).toMatchObject({ runId: "wrun_test", workflow: "test" });
    expect(createWorkflowContext({ runId: "wrun_9", workflow: "digest" })).toMatchObject({
      runId: "wrun_9",
      workflow: "digest",
    });
  });
});
