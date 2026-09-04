// Copyright 2026 the AAI authors. MIT license.
/**
 * The author-facing durable test surface, against the properties it claims.
 *
 * Each case here is one sentence from `runWorkflow`'s own doc — it slept, it
 * resumed off the journal, it retried, it was answered, it survived a dead
 * worker — because the whole value of the surface is that a template spec can
 * assert those, and a helper that quietly stopped exercising one would leave
 * every template asserting nothing.
 *
 * Two negatives are pinned as well, both of them limits rather than bugs: the
 * driver refuses a body woken in a loop rather than hanging, and it validates
 * the input the way `ctx.workflows.start` does rather than handing a body a
 * shape it could never receive.
 */

import { type WorkflowContext, workflow } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "../workflow-journal-memory.ts";
import { runWorkflow } from "./run-workflow.ts";

/** A day, which is the point: no spec may wait one and none has to. */
const A_DAY = 86_400_000;

describe("a run that finishes on the first delivery", () => {
  test("reports its output and its journaled steps", async () => {
    const digest = workflow({
      description: "digest",
      run: async (input: Record<string, unknown>, ctx: WorkflowContext) => ({
        headline: await ctx.step("summarize", () => `all about ${String(input.topic)}`),
      }),
    });

    const run = await runWorkflow(digest, { topic: "otters" }, { name: "digest" });
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ headline: "all about otters" });
    expect(run.deliveries).toBe(1);
    expect(run.steps).toEqual([
      {
        key: "summarize#0",
        name: "summarize",
        status: "ok",
        output: "all about otters",
        attempts: 1,
      },
    ]);
    await run.close();
  });

  test("fails the run when the body throws, and says why", async () => {
    const boom = workflow({
      description: "boom",
      run: () => {
        throw new Error("the gateway is down");
      },
    });

    const run = await runWorkflow(boom, {});
    expect(run.status).toBe("failed");
    expect(run.error).toBe("the gateway is down");
    expect(run.output).toBeUndefined();
  });
});

describe("a run that SLEEPS", () => {
  /** A body that files a report a day after writing it. */
  const review = workflow({
    description: "review",
    run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      const written = await ctx.step("write", () => "the draft");
      await ctx.sleep("settle", A_DAY);
      return { written, filed: await ctx.step("file", () => "filed") };
    },
  });

  test("parks without blocking, and says what deadline it asked for", async () => {
    const started = Date.now();
    const run = await runWorkflow(review, {});

    // `running` is the PARKED state: the run is in progress, it is just not
    // executing. That distinction is the one a caller polling it sees.
    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThanOrEqual(started + A_DAY);
    // And the work BEFORE the wait is already durable.
    expect(run.steps.map((step) => step.name)).toEqual(["write"]);
  });

  test("resumes past the wait, on a SECOND delivery, without redoing the first half", async () => {
    const write = vi.fn(() => "the draft");
    const parked = await runWorkflow(
      workflow({
        description: "review",
        run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
          const written = await ctx.step("write", write);
          await ctx.sleep("settle", A_DAY);
          return { written, filed: await ctx.step("file", () => "filed") };
        },
      }),
      {},
    );
    expect(write).toHaveBeenCalledTimes(1);

    await parked.advanceSleep();
    expect(parked.status).toBe("completed");
    expect(parked.output).toEqual({ written: "the draft", filed: "filed" });
    expect(parked.deliveries).toBe(2);
    // The whole claim, in one assertion: the body was walked twice and the
    // journaled step ran once.
    expect(write).toHaveBeenCalledTimes(1);
    expect(parked.wakeAt).toBeUndefined();
  });
});

describe("a run parked on somebody else's ANSWER", () => {
  const approve = workflow({
    description: "approve",
    run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      const answer = await ctx.waitFor<{ approved: boolean }>("approval:1");
      return { approved: answer?.approved ?? false };
    },
  });

  test("parks with NO deadline, because nothing but a signal ends it", async () => {
    const run = await runWorkflow(approve, {});
    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeUndefined();
  });

  test("a signal delivers the payload and the run completes", async () => {
    const run = await runWorkflow(approve, {});
    await run.signal("approval:1", { approved: true });
    expect(run.signalled).toBe(true);
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ approved: true });
  });

  test("reports a signal nobody was holding, rather than throwing", async () => {
    const run = await runWorkflow(approve, {});
    await run.signal("approval:elsewhere", { approved: true });
    expect(run.signalled).toBe(false);
    expect(run.status).toBe("running");
  });
});

describe("a wait whose WINDOW closes unanswered", () => {
  /** A gate whose safe default is to refuse — the shape an approval has. */
  const gate = workflow({
    description: "gate",
    run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      const answer = await ctx.waitFor<{ approved: boolean }>("approval:1", {
        timeoutMs: 120_000,
      });
      return { approved: answer?.approved ?? false, answered: answer !== undefined };
    },
  });

  test("parks first, because the window is still open", async () => {
    const run = await runWorkflow(gate, {});
    expect(run.status).toBe("running");
    // A hook's deadline is scheduled, unlike a bare `waitFor` — an unanswered
    // window still has to end.
    expect(run.wakeAt).toBeGreaterThan(Date.now());
  });

  test("takes the TIMEOUT branch once it is expired, which is the safe default", async () => {
    const run = await runWorkflow(gate, {});
    await run.expireWaits();

    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ approved: false, answered: false });
  });

  test("an answer that landed FIRST still wins, because the close is a compare-and-set", async () => {
    const run = await runWorkflow(gate, {});
    await run.signal("approval:1", { approved: true });
    // Already completed — this is the belt-and-braces half: expiring a window
    // that was answered must not rewrite the outcome.
    expect(run.output).toEqual({ approved: true, answered: true });
    await run.expireWaits();
    expect(run.output).toEqual({ approved: true, answered: true });
  });

  test("does not touch an ordinary ctx.sleep", async () => {
    // The distinction `SleepRecord.kind` exists for, from the other side: a
    // schedule is `advanceSleep`'s and an approval window is this one's.
    const scheduled = workflow({
      description: "scheduled",
      run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
        await ctx.sleep("schedule", A_DAY);
        return "later";
      },
    });
    const run = await runWorkflow(scheduled, {});
    await run.expireWaits();
    expect(run.status).toBe("running");
    await run.advanceSleep();
    expect(run.status).toBe("completed");
  });
});

describe("a step that RETRIES", () => {
  test("settles once, and the entry records what it cost", async () => {
    let tries = 0;
    const flaky = workflow({
      description: "flaky",
      run: (_input: Record<string, unknown>, ctx: WorkflowContext) =>
        ctx.step("fetch", () => {
          tries += 1;
          // A plain `Error` is retryable with NO backoff, so the case costs
          // microseconds rather than the two seconds a `RetryableError` would.
          if (tries < 3) throw new Error("rate limited");
          return "the page";
        }),
    });

    const run = await runWorkflow(flaky, {});
    expect(run.status).toBe("completed");
    expect(run.output).toBe("the page");
    // Three tries, ONE journal entry — and `attempts` is what says so.
    expect(tries).toBe(3);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.attempts).toBe(3);
  });
});

describe("a worker that DIES mid-run", () => {
  test("loses the step it was on, keeps everything already journaled, and resumes", async () => {
    const first = vi.fn(() => "one");
    const second = vi.fn(() => "two");
    const pipeline = workflow({
      description: "pipeline",
      run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => [
        await ctx.step("first", first),
        await ctx.step("second", second),
      ],
    });

    const run = await runWorkflow(pipeline, {}, { crashAt: "second" });
    expect(run.crashed).toBe(true);
    expect(run.status).toBe("running");
    // The first step is durable; the second never settled.
    expect(run.steps.map((step) => step.name)).toEqual(["first"]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output).toEqual(["one", "two"]);
    // The exactly-once claim, from a body's own side: the survivor of the crash
    // was replayed off the journal and only the lost step ran.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("does not charge the dead attempt to the resuming walk's retry budget", async () => {
    const pipeline = workflow({
      description: "pipeline",
      run: (_input: Record<string, unknown>, ctx: WorkflowContext) =>
        ctx.step("only", () => "done"),
    });

    const journal = createMemoryJournal();
    const run = await runWorkflow(pipeline, {}, { crashAt: "only", journal });
    expect(run.crashed).toBe(true);
    await run.restart();

    expect(run.status).toBe("completed");
    // ONE, not two — and the distinction is a durable-execution defect this repo
    // has already paid for. The dead worker's charge is still in the journal: a
    // charge is a LEASE nobody released, and it is the only evidence the attempt
    // happened, which is what bounds ABANDONMENT. What a step entry records is
    // the settling WALK's own tries, so a resume starts its author-facing
    // `maxAttempts` budget over. Sharing one number between the two is exactly
    // what journaled `failed` over a step that then succeeded — see
    // `workflow-replay-step.ts`, "An attempt is a lease".
    expect(run.steps[0]?.attempts).toBe(1);
  });
});

describe("what the journal holds, as a spec reads it", () => {
  /** A body that steps in a loop and reads the clock at both ends. */
  const audited = workflow({
    description: "audited",
    run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
      const startedAt = await ctx.now();
      // Eleven, so the occurrence has to be compared as a NUMBER: `poll#10`
      // sorts before `poll#2` as a string.
      for (let i = 0; i < 11; i++) await ctx.step("poll", () => i);
      await ctx.step("file", () => "filed");
      return { elapsed: (await ctx.now()) - startedAt };
    },
  });

  test("orders steps by call SITE, so a same-millisecond walk is not a coin flip", async () => {
    const run = await runWorkflow(audited, {});

    expect(run.status).toBe("completed");
    // `file` before every `poll`, and `poll#2` before `poll#10`. Under the
    // journal's own order — `finishedAt`, key breaking a tie — this whole list
    // would depend on how fast the machine is.
    expect(run.steps.map((step) => step.key)).toEqual([
      "file#0",
      "poll#0",
      "poll#1",
      "poll#2",
      "poll#3",
      "poll#4",
      "poll#5",
      "poll#6",
      "poll#7",
      "poll#8",
      "poll#9",
      "poll#10",
    ]);
  });

  test("keeps ctx.now() OUT of the steps and in `reads`", async () => {
    const run = await runWorkflow(audited, {});

    // The engine journals a determinism read through the same `appendStep` a
    // step goes through, into a reserved key space — `now!0`, not `now#0`. A
    // spec asserting which call sites a body reached must not see it.
    expect(run.steps.map((step) => step.name)).not.toContain("now");
    expect(run.reads.map((read) => read.key)).toEqual(["now!0", "now!1"]);
    expect(run.reads.every((read) => read.kind === "now")).toBe(true);
    expect(typeof run.reads[0]?.value).toBe("number");
  });

  test("a read is the same value on the walk after a crash", async () => {
    // Which is the whole point of journaling it: `elapsed` is measured from the
    // instant the RUN began, not the instant the resuming walk did.
    const run = await runWorkflow(audited, {}, { crashAt: "file" });
    expect(run.crashed).toBe(true);
    const first = run.reads[0]?.value;
    expect(typeof first).toBe("number");

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.reads[0]?.value).toBe(first);
  });
});

describe("the driver's own limits", () => {
  test("validates the input the way ctx.workflows.start does", async () => {
    const typed = workflow({
      description: "typed",
      input: {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (value: unknown) =>
            isRecord(value) && "topic" in value
              ? { value }
              : { issues: [{ message: "topic is required" }] },
        },
      },
      run: (input: Record<string, unknown>) => input.topic,
    });

    await expect(runWorkflow(typed, {}, { name: "typed" })).rejects.toThrow(
      /workflow typed refused that input/,
    );
    const ok = await runWorkflow(typed, { topic: "otters" }, { name: "typed" });
    expect(ok.output).toBe("otters");
  });

  test("refuses a run that never settles, naming the bound", async () => {
    // A body that sleeps forever, woken forever. Without the bound this is a
    // spec that hangs and reports the RUNNER's timeout.
    const looping = workflow({
      description: "looping",
      run: async (_input: Record<string, unknown>, ctx: WorkflowContext) => {
        for (let i = 0; i < 100; i++) await ctx.sleep("poll", A_DAY);
        return "never";
      },
    });

    const run = await runWorkflow(looping, {}, { maxDeliveries: 3 });
    await expect(
      (async () => {
        for (let i = 0; i < 10; i++) await run.advanceSleep();
      })(),
    ).rejects.toThrow(/took 3 deliveries without settling/);
  });

  test("shares a journal, so a second run reads the world the first left", async () => {
    const journal = createMemoryJournal();
    const counter = workflow({
      description: "counter",
      run: (input: Record<string, unknown>) => input.n,
    });

    const one = await runWorkflow(counter, { n: 1 }, { name: "counter", journal });
    const two = await runWorkflow(counter, { n: 2 }, { name: "counter", journal });
    expect(one.runId).not.toBe(two.runId);
    // As a SET: `listRuns` orders by `createdAt` with the id breaking a tie, and
    // two runs started in the same millisecond carry ids minted from a uuid.
    const outputs = (await journal.listRuns("counter", 10)).map((record) => record.output);
    expect(new Set(outputs)).toEqual(new Set([1, 2]));
  });
});
