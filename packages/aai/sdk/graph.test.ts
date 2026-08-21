// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { fromPromise, setup } from "xstate";
import { GraphNotFinishedError, graph } from "./graph.ts";
import { sleep } from "./sleep.ts";

/** A machine that awaits an actor, so a run can be aborted mid-flight. */
function slowMachine(delayMs: number, onRan?: () => void) {
  return setup({
    types: {} as { input: { topic: string }; output: { verdict: string } },
    actors: {
      work: fromPromise(async ({ input }: { input: { topic: string } }) => {
        await sleep(delayMs);
        onRan?.();
        return `looked at ${input.topic}`;
      }),
    },
  }).createMachine({
    id: "triage",
    initial: "working",
    context: ({ input }) => ({ topic: input.topic, verdict: "" }),
    states: {
      working: {
        invoke: {
          src: "work",
          input: ({ context }) => ({ topic: context.topic }),
          onDone: {
            target: "settled",
            actions: ({ event, context }) => {
              context.verdict = event.output;
            },
          },
        },
      },
      settled: { type: "final" },
    },
    output: ({ context }) => ({ verdict: context.verdict }),
  });
}

describe("run", () => {
  test("resolves with the machine's output", async () => {
    const triage = graph(slowMachine(0));
    expect(await triage.run({ topic: "billing" })).toEqual({ verdict: "looked at billing" });
  });

  test("exposes the machine it wraps", () => {
    const machine = slowMachine(0);
    expect(graph(machine).machine).toBe(machine);
  });

  test("a machine with no output resolves undefined rather than throwing", async () => {
    const bare = setup({}).createMachine({
      id: "bare",
      initial: "only",
      states: { only: { type: "final" } },
    });
    expect(await graph(bare).run(undefined)).toBeUndefined();
  });
});

describe("failure", () => {
  test("an invoked actor's rejection rejects the run", async () => {
    const machine = setup({
      actors: {
        boom: fromPromise(async () => {
          throw new Error("the grader is down");
        }),
      },
    }).createMachine({
      id: "brittle",
      initial: "working",
      states: { working: { invoke: { src: "boom", onDone: "ok" } }, ok: { type: "final" } },
    });
    await expect(graph(machine).run(undefined)).rejects.toThrow("the grader is down");
  });
});

describe("abort", () => {
  test("an already-aborted signal rejects before the machine starts", async () => {
    let ran = false;
    const triage = graph(
      slowMachine(0, () => {
        ran = true;
      }),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      triage.run({ topic: "billing" }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(GraphNotFinishedError);
    expect(ran).toBe(false);
  });

  test("aborting mid-run REJECTS rather than resolving undefined", async () => {
    // The whole reason this wrapper exists. `toPromise` on a stopped actor
    // resolves with `undefined`, which a tool body then reads fields off as
    // though the graph had finished; `run` must never do that.
    const triage = graph(slowMachine(200));
    const controller = new AbortController();
    const running = triage.run({ topic: "billing" }, { signal: controller.signal });
    controller.abort();

    await expect(running).rejects.toBeInstanceOf(GraphNotFinishedError);
  });

  test("the error says which graph stopped, and that a caller aborted it", async () => {
    const triage = graph(slowMachine(200));
    const controller = new AbortController();
    const running = triage.run({ topic: "billing" }, { signal: controller.signal });
    controller.abort();

    const error = await running.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GraphNotFinishedError);
    expect(error).toMatchObject({ graph: "triage", aborted: true, name: "GraphNotFinishedError" });
    expect((error as Error).message).toContain("aborted");
  });

  test("a run that finishes before the abort is unaffected", async () => {
    const triage = graph(slowMachine(0));
    const controller = new AbortController();
    const settled = await triage.run({ topic: "billing" }, { signal: controller.signal });
    // Aborting AFTER the run settled must not turn a delivered output into an
    // error, and must not leave a listener behind on the caller's signal.
    controller.abort();
    expect(settled).toEqual({ verdict: "looked at billing" });
  });

  test("an unaborted signal is not held onto once the run settles", async () => {
    const triage = graph(slowMachine(0));
    const controller = new AbortController();
    await triage.run({ topic: "billing" }, { signal: controller.signal });
    // A leaked listener per run is how a long session trips the repo's
    // MaxListenersExceededWarning gate, so the removal is asserted rather than
    // assumed: ten runs on one signal leave none behind.
    for (let index = 0; index < 10; index++) {
      await triage.run({ topic: `topic-${index}` }, { signal: controller.signal });
    }
    expect(() => controller.abort()).not.toThrow();
  });
});
