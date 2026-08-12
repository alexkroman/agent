// Copyright 2026 the AAI authors. MIT license.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { WorkflowDef } from "../sdk/workflow.ts";
import { MAX_WORKFLOW_STEPS, workflow } from "../sdk/workflow.ts";
import {
  asStatus,
  createMemoryWorkflowStore,
  type MemoryWorkflowStore,
} from "./_workflow-test-utils.ts";
import {
  createWorkflowEngine,
  MAX_DUE_RUNS,
  MAX_WAKE_TIMER_MS,
  WORKFLOW_LEASE_MS,
  type WorkflowEngine,
} from "./workflow-engine.ts";

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

describe("run lifecycle", () => {
  test("runs every step and completes with the run's return value", async () => {
    const { engine, store } = makeEngine({
      sum: workflow({
        async run(_input, ctx) {
          const a = await ctx.step("a", () => 1);
          const b = await ctx.step("b", () => a + 1);
          return b * 10;
        },
      }),
    });

    const runId = await engine.start("sum");
    await drain();

    expect(await engine.get(runId)).toEqual({
      runId,
      workflow: "sum",
      status: "completed",
      output: 20,
      stepsCompleted: 2,
    });
    expect([...store.row(runId).steps.keys()]).toEqual(["s:a#0", "s:b#0"]);
    engine.close();
  });

  test("passes the validated input to run and journals it", async () => {
    const seen = vi.fn();
    const { engine, store } = makeEngine({
      greet: workflow({
        input: z.object({ name: z.string() }),
        run(input, _ctx) {
          seen(input);
        },
      }),
    });

    const runId = await engine.start("greet", { name: "Ada" });
    await drain();

    expect(seen).toHaveBeenCalledWith({ name: "Ada" });
    expect(store.row(runId).input).toEqual({ name: "Ada" });
    engine.close();
  });

  test("a run whose body throws is failed with the message", async () => {
    const { engine } = makeEngine({
      boom: workflow({
        run() {
          throw new Error("nope");
        },
      }),
    });

    const runId = await engine.start("boom");
    await drain();

    const snapshot = asStatus(await engine.get(runId), "failed");
    expect(snapshot.error).toContain("nope");
    engine.close();
  });

  test("reuses one name across a loop as distinct journal entries", async () => {
    const fn = vi.fn((n: number) => n * 2);
    const { engine, store } = makeEngine({
      each: workflow({
        async run(_input, ctx) {
          const out: number[] = [];
          for (const n of [1, 2, 3]) out.push(await ctx.step("double", () => fn(n)));
          return out;
        },
      }),
    });

    const runId = await engine.start("each");
    await drain();

    expect(asStatus(await engine.get(runId), "completed").output).toEqual([2, 4, 6]);
    expect([...store.row(runId).steps.keys()]).toEqual(["s:double#0", "s:double#1", "s:double#2"]);
    engine.close();
  });
});

describe("start() rejections", () => {
  test("names the declared workflows when the name is unknown", async () => {
    const { engine } = makeEngine({ known: workflow({ run: () => undefined }) });
    await expect(engine.start("nope")).rejects.toThrow(/Unknown workflow "nope".*known/s);
    engine.close();
  });

  test("reports none when the agent declared no workflows", async () => {
    const { engine } = makeEngine({});
    await expect(engine.start("nope")).rejects.toThrow(/Declared workflows: none/);
    engine.close();
  });

  test("rejects input that fails the workflow's schema, before creating a run", async () => {
    const { engine, store } = makeEngine({
      greet: workflow({ input: z.object({ name: z.string() }), run: () => undefined }),
    });
    await expect(engine.start("greet", { name: 42 })).rejects.toThrow(
      /Invalid input for workflow "greet"/,
    );
    expect(store.runs.size).toBe(0);
    engine.close();
  });
});

describe("parallel steps", () => {
  test("Promise.all over ctx.step journals by CALL order, not completion order", async () => {
    // Concurrency needs no API of its own: `nextId` runs SYNCHRONOUSLY, before
    // `step`'s first await, so a `.map()` over the input numbers its steps in
    // map order however they settle. That is what the determinism rule really
    // asks for — the order steps are CALLED — and it is why the transcription
    // template can fan its chunks out. Nothing pinned it before.
    //
    // Deferreds rather than timers: the settle ORDER is the whole point here,
    // so it is controlled outright instead of inferred from a clock this suite
    // has faked anyway.
    const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const settled: string[] = [];
    const { engine, store } = makeEngine({
      fan: workflow({
        async run(_input, ctx) {
          const out = await Promise.all(
            [0, 1, 2].map((n) =>
              ctx.step("chunk", async () => {
                await gates[n]?.promise;
                settled.push(`c${n}`);
                return `t${n}`;
              }),
            ),
          );
          return out.join(" ");
        },
      }),
    });

    const runId = await engine.start("fan");
    await drain();
    // Release in REVERSE: were ordinals assigned on completion, both the
    // journal keys and the output would follow this instead, and a resume
    // would replay the wrong value for every chunk.
    for (const n of [2, 1, 0]) {
      gates[n]?.resolve();
      await drain();
    }

    expect(settled).toEqual(["c2", "c1", "c0"]);
    // The PAIRING is the invariant, not the Map's iteration order — entries are
    // inserted as each step records, so that order legitimately follows
    // completion. What must not drift is which ordinal holds which output.
    expect(Object.fromEntries(store.row(runId).steps)).toEqual({
      "s:chunk#0": "t0",
      "s:chunk#1": "t1",
      "s:chunk#2": "t2",
    });
    // And the payoff: the run's own result is in call order, so a caller can
    // join the chunks without sorting them.
    expect(asStatus(await engine.get(runId), "completed").output).toBe("t0 t1 t2");
    engine.close();
  });

  test("a failing branch leaves its siblings journaled, so a resume re-runs only it", async () => {
    // The half that makes fanning out safe: `Promise.all` rejects on the first
    // failure, but the siblings already recorded are FACTS. This is the
    // durability story the transcription template exists to show — one chunk's
    // 503 must not re-bill the other thirty-nine.
    let failures = 0;
    const { engine, store } = makeEngine({
      fan: workflow({
        run: (_input, ctx) =>
          Promise.all(
            [0, 1, 2].map((n) =>
              ctx.step(
                "chunk",
                () => {
                  if (n === 1 && failures++ === 0) throw new Error("503");
                  return `t${n}`;
                },
                { maxAttempts: 1 },
              ),
            ),
          ),
      }),
    });

    const runId = await engine.start("fan");
    await drain();
    expect((await engine.get(runId))?.status).toBe("failed");
    // The two that succeeded are journaled under their own ordinals; the gap at
    // #1 is exactly what a resume re-issues.
    expect([...store.row(runId).steps.keys()].sort()).toEqual(["s:chunk#0", "s:chunk#2"]);
    engine.close();
  });
});

describe("step retry", () => {
  test("retries a failing step and journals only the success", async () => {
    let attempts = 0;
    const { engine, store } = makeEngine({
      flaky: workflow({
        run: (_input, ctx) =>
          ctx.step("call", () => {
            attempts += 1;
            if (attempts < 3) throw new Error("503");
            return "ok";
          }),
      }),
    });

    const runId = await engine.start("flaky");
    // Two backoffs at 500ms and 1000ms.
    await vi.advanceTimersByTimeAsync(2000);
    await drain();

    expect(attempts).toBe(3);
    const snapshot = asStatus(await engine.get(runId), "completed");
    expect(snapshot.output).toBe("ok");
    expect(store.row(runId).steps.get("s:call#0")).toBe("ok");
    engine.close();
  });

  test("fails the run after the attempt cap, naming the step and the cause", async () => {
    const fn = vi.fn(() => {
      throw new Error("always");
    });
    const { engine } = makeEngine({
      doomed: workflow({
        run: (_input, ctx) => ctx.step("call", fn, { maxAttempts: 2, backoffMs: 10 }),
      }),
    });

    const runId = await engine.start("doomed");
    await vi.advanceTimersByTimeAsync(100);
    await drain();

    expect(fn).toHaveBeenCalledTimes(2);
    const snapshot = asStatus(await engine.get(runId), "failed");
    expect(snapshot.error).toMatch(/step "s:call#0" failed after 2 attempt\(s\).*always/s);
    engine.close();
  });
});

describe("durable sleep", () => {
  test("suspends with a wake time and resumes without re-running earlier steps", async () => {
    const before = vi.fn(() => "first");
    const after = vi.fn(() => "second");
    const { engine } = makeEngine({
      nap: workflow({
        async run(_input, ctx) {
          await ctx.step("before", before);
          await ctx.sleep(10_000);
          return await ctx.step("after", after);
        },
      }),
    });

    const runId = await engine.start("nap");
    await drain();

    const sleeping = asStatus(await engine.get(runId), "sleeping");
    expect(sleeping.wakeAt).toBe(Date.now() + 10_000);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();

    // The wake timer fires the resume, which replays from the top.
    await vi.advanceTimersByTimeAsync(10_000);
    await drain();

    const done = asStatus(await engine.get(runId), "completed");
    expect(done.output).toBe("second");
    // The whole point: the pre-sleep step is journaled, not repeated.
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    engine.close();
  });

  test("a sleep longer than the wake-timer cap waits for runDue", async () => {
    const { engine } = makeEngine({
      long: workflow({
        run: (_input, ctx) => ctx.sleep(MAX_WAKE_TIMER_MS + 60_000),
      }),
    });

    const runId = await engine.start("long");
    await drain();
    expect((await engine.get(runId))?.status).toBe("sleeping");

    // No in-process timer covers this, so time alone changes nothing...
    await vi.advanceTimersByTimeAsync(MAX_WAKE_TIMER_MS + 60_000);
    await drain();
    expect((await engine.get(runId))?.status).toBe("sleeping");

    // ...until recovery sweeps it up, which is what a later boot does.
    expect(await engine.runDue()).toBe(1);
    await drain();
    expect((await engine.get(runId))?.status).toBe("completed");
    engine.close();
  });

  test("a resumed sleep keeps its original deadline", async () => {
    const { engine, store } = makeEngine({
      nap: workflow({
        run: (_input, ctx) => ctx.sleep(5000),
      }),
    });

    const runId = await engine.start("nap");
    await drain();
    const deadline = store.row(runId).wakeAt;

    // A resume that lands early must suspend again on the SAME deadline rather
    // than adding another 5s from now.
    await vi.advanceTimersByTimeAsync(1000);
    store.row(runId).wakeAt = Date.now();
    await engine.runDue();
    await drain();

    expect(store.row(runId).status).toBe("sleeping");
    expect(store.row(runId).wakeAt).toBe(deadline);
    engine.close();
  });
});

describe("claiming and recovery", () => {
  test("does not re-execute a run that is already claimed and leased", async () => {
    const { engine, store } = makeEngine({
      nap: workflow({ run: (_input, ctx) => ctx.sleep(MAX_WAKE_TIMER_MS + 1000) }),
    });
    const runId = await engine.start("nap");
    await drain();
    // Force it back to a live claim, as a peer executor would hold it.
    const run = store.row(runId);
    run.status = "running";
    run.wakeAt = undefined;
    run.leaseUntil = Date.now() + WORKFLOW_LEASE_MS;

    expect(await engine.runDue()).toBe(0);
    engine.close();
  });

  test("recovers a run whose executor died holding an expired lease", async () => {
    const body = vi.fn(() => "done");
    const { engine, store } = makeEngine({ orphan: workflow({ run: body }) });
    await store.create("stranded", "orphan", null);
    const run = store.row("stranded");
    run.status = "running";
    run.leaseUntil = Date.now() - 1;

    expect(await engine.runDue()).toBe(1);
    await drain();

    expect(body).toHaveBeenCalledTimes(1);
    expect((await engine.get("stranded"))?.status).toBe("completed");
    engine.close();
  });

  test("fails a run whose workflow the current bundle no longer declares", async () => {
    const { engine, store } = makeEngine({ live: workflow({ run: () => undefined }) });
    await store.create("gone", "removed-by-redeploy", null);

    await engine.runDue();
    await drain();

    const snapshot = asStatus(await engine.get("gone"), "failed");
    expect(snapshot.error).toContain('unknown workflow "removed-by-redeploy"');
    engine.close();
  });

  test("drains a backlog larger than one due query, in one call", async () => {
    // `MAX_DUE_RUNS` bounds one QUERY, not the backlog. A single batch made
    // recovery depend on how often the agent happens to boot — 100 runs abandoned
    // by a redeploy needed five boots — and `runDue` answered 20, so nothing
    // reported the other 80.
    const body = vi.fn(() => "done");
    const { engine, store } = makeEngine({ orphan: workflow({ run: body }) });
    const backlog = MAX_DUE_RUNS * 2 + 3;
    for (let i = 0; i < backlog; i++) {
      await store.create(`stranded-${i}`, "orphan", null);
      const run = store.row(`stranded-${i}`);
      run.status = "running";
      run.leaseUntil = Date.now() - 1;
    }

    expect(await engine.runDue()).toBe(backlog);
    await drain();

    expect(body).toHaveBeenCalledTimes(backlog);
    for (let i = 0; i < backlog; i++) {
      expect(asStatus(await engine.get(`stranded-${i}`), "completed").output).toBe("done");
    }
    engine.close();
  });

  test("stops sweeping once a batch comes back short", async () => {
    // The loop's terminating condition is a SHORT batch, so a drained queue costs
    // exactly one extra query rather than `MAX_DUE_SWEEPS` of them.
    const { engine, store } = makeEngine({ orphan: workflow({ run: () => "done" }) });
    await store.create("only-one", "orphan", null);
    store.row("only-one").status = "pending";
    const due = vi.spyOn(store, "due");

    expect(await engine.runDue()).toBe(1);

    expect(due).toHaveBeenCalledTimes(1);
    engine.close();
  });

  test("runDue does nothing (and touches no storage) with no workflows declared", async () => {
    const { engine, store } = makeEngine({});
    expect(await engine.runDue()).toBe(0);
    expect(store.initCount).toBe(0);
    engine.close();
  });

  test("creates the journal tables once across many calls", async () => {
    const { engine, store } = makeEngine({ noop: workflow({ run: () => undefined }) });
    await engine.start("noop");
    await engine.start("noop");
    await engine.get("whatever");
    await drain();
    expect(store.initCount).toBe(1);
    engine.close();
  });

  test("fails a run that journals more steps than the cap allows", async () => {
    const { engine } = makeEngine({
      runaway: workflow({
        async run(_input, ctx) {
          for (let n = 0; n <= MAX_WORKFLOW_STEPS; n++) await ctx.step("tick", () => n);
        },
      }),
    });

    const runId = await engine.start("runaway");
    await drain(40);

    const snapshot = asStatus(await engine.get(runId), "failed");
    expect(snapshot.error).toMatch(/exceeded 500 journal entries.*child runs/s);
    engine.close();
  });

  test("get resolves undefined for a run id that does not exist", async () => {
    const { engine } = makeEngine({ noop: workflow({ run: () => undefined }) });
    await expect(engine.get("no-such-run")).resolves.toBeUndefined();
    engine.close();
  });
});

describe("shutdown", () => {
  test("abandons an in-flight run without failing it, leaving it claimable", async () => {
    const started = Promise.withResolvers<void>();
    const { engine, store } = makeEngine({
      slow: workflow({
        run: (_input, ctx) =>
          ctx.step(
            "hang",
            () =>
              new Promise((_resolve, reject) => {
                started.resolve();
                ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
              }),
            { maxAttempts: 1 },
          ),
      }),
    });

    const runId = await engine.start("slow");
    await started.promise;
    engine.close();
    await drain();

    // Still `running` — NOT failed. Its lease expires and a later boot resumes it.
    expect(store.row(runId).status).toBe("running");
    await vi.advanceTimersByTimeAsync(WORKFLOW_LEASE_MS + 1);
    expect(await store.due(10)).toEqual([runId]);
  });

  test("a closed engine starts nothing new", async () => {
    const body = vi.fn(() => undefined);
    const { engine, store } = makeEngine({ noop: workflow({ run: body }) });
    engine.close();

    const runId = await engine.start("noop");
    await drain();

    expect(body).not.toHaveBeenCalled();
    expect(store.row(runId).status).toBe("pending");
  });
});

/**
 * `busy()` is what stops a guest reclaiming itself out from under a live run.
 *
 * The guest's idle controller measures "does anybody need me" by the SESSION
 * count, and a `page: "static"` app has none by construction — so before this
 * existed, a five-minute timer killed every run longer than five minutes and
 * the journal then paid a 120s lease plus a visitor to continue. These assert
 * the two edges: true while work is really in flight, and false the moment
 * nothing is, so it cannot pin a sandbox open forever.
 */
describe("busy", () => {
  test("false with nothing running", () => {
    const { engine } = makeEngine({
      w: workflow({ input: z.object({}), run: () => Promise.resolve(1) }),
    });
    expect(engine.busy()).toBe(false);
  });

  test("true while a step is in flight, false once the run completes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine } = makeEngine({
      w: workflow({
        input: z.object({}),
        run: async (_input, ctx) => {
          await ctx.step("slow", async () => {
            await gate;
            return "done";
          });
          return "ok";
        },
      }),
    });

    await engine.start("w", {});
    await drain();
    // The step is parked on the gate — this is the window a five-minute idle
    // timer used to fire in.
    expect(engine.busy()).toBe(true);

    release?.();
    await drain();
    expect(engine.busy()).toBe(false);
  });

  test("true while a NEAR-term wake timer is armed, so a short sleep survives", async () => {
    const { engine } = makeEngine({
      w: workflow({
        input: z.object({}),
        run: async (_input, ctx) => {
          await ctx.step("before", () => 1);
          // Inside MAX_WAKE_TIMER_MS, so the engine holds a timer for it.
          await ctx.sleep(5000);
          await ctx.step("after", () => 2);
          return "ok";
        },
      }),
    });

    await engine.start("w", {});
    await drain();
    // Sleeping, not executing — but work is imminent and this host owns it.
    expect(engine.busy()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await drain();
    expect(engine.busy()).toBe(false);
  });

  test("false for a LONG sleeper — that case wants an external wake, not a pinned sandbox", async () => {
    const { engine } = makeEngine({
      w: workflow({
        input: z.object({}),
        run: async (_input, ctx) => {
          await ctx.step("before", () => 1);
          // Past MAX_WAKE_TIMER_MS: no timer is armed, so nothing here is
          // waiting on THIS host. Holding a billed container for six hours is
          // exactly what `sleep` releases the run to avoid.
          await ctx.sleep(6 * 60 * 60_000);
          return "ok";
        },
      }),
    });

    await engine.start("w", {});
    await drain();
    expect(engine.busy()).toBe(false);
  });
});
