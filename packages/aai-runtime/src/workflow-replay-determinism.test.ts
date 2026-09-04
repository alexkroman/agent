// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.now()`, `ctx.random()` and `ctx.uuid()`, stated as the property they
 * exist for: **two walks of the same body see the same value.**
 *
 * Its own file rather than more of `workflow-replay.test.ts`, which sits under
 * the 700-line test cap with little room. Every case here drives the real
 * `replayRun` against the real memory journal, for the reason
 * `workflow-replay-divergence.test.ts` gives: the claims are about what the
 * ENGINE does with a journal, and a unit test of the factory alone would pass
 * while the wiring answered a fresh value on every delivery.
 *
 * Two walks of ONE run are produced the way that file produces them — a
 * `ctx.sleep` suspends the first delivery, `wakeSleeps` clears it, and the
 * second delivery re-walks the body from the top.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";
import {
  DETERMINISM_KINDS,
  type DeterminismKind,
  determinismKey,
  isDeterminismKey,
} from "./workflow-replay-determinism.ts";

type Body = (input: Record<string, unknown>, ctx: WorkflowContext) => Promise<unknown> | unknown;

async function seed(runId = "wrun_j"): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId,
    workflow: "billing",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  return journal;
}

function replay(journal: JournalStore, run: Body, runId = "wrun_j") {
  return replayRun({ runId, workflow: "billing", input: {}, run, journal });
}

type Outcome = Awaited<ReturnType<typeof replayRun>>;

/** The message, whichever arm produced it. */
function failure(outcome: Outcome): string {
  return outcome.kind === "failed" ? outcome.error.message : `not a failure: ${outcome.kind}`;
}

/**
 * A `Date.now` that advances one millisecond per read.
 *
 * Two things need it. `ctx.now()` returning a DIFFERENT number on a second run
 * is only observable if the clock moved, and an in-memory run takes well under a
 * millisecond. And `finishedAt` is what orders the divergence cursor, whose test
 * is a STRICT `>` — so entries settling inside one millisecond make the
 * healthy-resume case below vacuous rather than failing. `restoreMocks` takes the
 * spy back down.
 */
function tickingClock(start = 1_700_000_000_000): void {
  let at = start;
  vi.spyOn(Date, "now").mockImplementation(() => at++);
}

/**
 * Walk `body` twice over one run, the sleep in it suspending the first.
 *
 * Returns both outcomes rather than asserting on them: Biome's
 * `noMisplacedAssertion` matches the enclosing CALLEE, so an `expect` in a
 * helper is an error however plainly the helper is a test's own.
 */
async function twoWalks(
  journal: JournalStore,
  body: Body,
): Promise<{ first: Outcome; second: Outcome }> {
  const first = await replay(journal, body);
  await journal.wakeSleeps("wrun_j", undefined);
  const second = await replay(journal, body);
  return { first, second };
}

describe("a first reach", () => {
  test("reads the source once and journals the value under its own key", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => ctx.now());

    const steps = await journal.readSteps("wrun_j");
    expect(steps.map((step) => step.key)).toEqual(["now!0"]);
    expect(steps[0]?.name).toBe("now");
    // The journaled value IS what the body was handed — the whole mechanism.
    expect(outcome).toEqual({ kind: "completed", output: steps[0]?.output });
    expect(typeof steps[0]?.output).toBe("number");
  });

  test("counts each kind separately, so inserting one shifts no other", async () => {
    const journal = await seed();
    await replay(journal, async (_input, ctx) => {
      await ctx.uuid();
      await ctx.now();
      await ctx.random();
      await ctx.uuid();
    });

    // `uuid!0` and `uuid!1` although a `ctx.now()` and a `ctx.random()` sit
    // between them: one shared counter would have produced `…!0` through `…!3`,
    // and an inserted `ctx.now()` would then move every later uuid's key.
    //
    // A SET, not a list in reach order: `readSteps` orders by `finishedAt` and
    // four in-memory appends land inside one millisecond, so reach order is not
    // what this can assert. The claim is which keys exist.
    expect(new Set((await journal.readSteps("wrun_j")).map((step) => step.key))).toEqual(
      new Set(["now!0", "random!0", "uuid!0", "uuid!1"]),
    );
  });

  test("gives one call site in a loop a distinct key and value per iteration", async () => {
    const journal = await seed();
    const drawn = (await replay(journal, async (_input, ctx) => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) out.push(await ctx.random());
      return out;
    })) as { output: number[] };

    expect((await journal.readSteps("wrun_j")).map((step) => step.key)).toEqual([
      "random!0",
      "random!1",
      "random!2",
    ]);
    // Three DRAWS, not one value re-read: a seeded sequence keyed once would be
    // the other design, and this is the observable difference.
    expect(new Set(drawn.output).size).toBe(3);
  });

  test("charges no step ATTEMPT, and records that it charged none", async () => {
    const journal = await seed();
    const claimed = vi.spyOn(journal, "claimAttempt");

    await replay(journal, async (_input, ctx) => {
      await ctx.now();
      await ctx.random();
      await ctx.uuid();
    });

    // These calls cannot fail, so there is no body to abandon and nothing for a
    // lease to be evidence of — see the module doc's decision 2.
    expect(claimed).not.toHaveBeenCalled();
    for (const step of await journal.readSteps("wrun_j")) expect(step.attempts).toBe(0);
  });
});

describe("a second walk of the same body", () => {
  test.each(DETERMINISM_KINDS)("sees the same value from ctx.%s()", async (kind) => {
    tickingClock();
    const journal = await seed();
    const seen: unknown[] = [];
    const body: Body = async (_input, ctx) => {
      seen.push(await ctx[kind]());
      await ctx.sleep("nap", 60_000);
      return "done";
    };

    const { first, second } = await twoWalks(journal, body);
    expect(first.kind, "the first delivery did not suspend").toBe("suspended");
    expect(second.kind, failure(second)).toBe("completed");

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    // One journal row, so the second walk really answered from it rather than
    // appending a second value that happened to match.
    expect((await journal.readSteps("wrun_j")).map((step) => step.key)).toEqual([
      determinismKey(kind, 0),
    ]);
  });

  /**
   * The `settled` read is a SECOND guarantee, and this is the only claim that
   * separates it from the first.
   *
   * `appendStep` is idempotent on the key and resolves the stored entry, so a
   * walk that skipped the snapshot entirely would still answer the first walk's
   * value — A/B'd: deleting the `settled` read leaves all fourteen other cases
   * green. What it would cost is a journal WRITE per read per delivery, and a
   * re-read of the source, on the path a long-running run walks most.
   */
  test("answers from the walk's snapshot without a journal write, or a second read", async () => {
    const journal = await seed();
    const appended = vi.spyOn(journal, "appendStep");
    const body: Body = async (_input, ctx) => {
      await ctx.random();
      await ctx.sleep("nap", 60_000);
    };

    const { first, second } = await twoWalks(journal, body);
    expect(first.kind, "the first delivery did not suspend").toBe("suspended");
    expect(second.kind, failure(second)).toBe("completed");

    // One append across BOTH deliveries: the first wrote it, the second read it.
    expect(appended).toHaveBeenCalledTimes(1);
  });

  test("still sees a DIFFERENT value in a different run, which is what makes that claim real", async () => {
    tickingClock();
    const body: Body = async (_input, ctx) => [
      await ctx.now(),
      await ctx.random(),
      await ctx.uuid(),
    ];

    const one = await replay(await seed("wrun_a"), body, "wrun_a");
    const two = await replay(await seed("wrun_b"), body, "wrun_b");

    expect(one.kind).toBe("completed");
    expect(two.kind).toBe("completed");
    expect(two).not.toEqual(one);
  });

  test("answers with the STORE's value, not its own, when a redelivery raced it", async () => {
    const journal = await seed();
    // `appendStep` is idempotent on the key and resolves the entry that is now
    // authoritative. Standing in for the racing delivery: something else got
    // there first, and both walks have to answer the same thing or they diverge
    // from here on.
    const real = journal.appendStep.bind(journal);
    vi.spyOn(journal, "appendStep").mockImplementation(async (runId, entry) => {
      if (isDeterminismKey(entry.key)) await real(runId, { ...entry, output: "from-the-race" });
      return real(runId, entry);
    });

    const outcome = await replay(journal, async (_input, ctx) => ctx.uuid());

    expect(outcome).toEqual({ kind: "completed", output: "from-the-race" });
  });
});

describe("a read inside a ctx.step", () => {
  test("is REFUSED, naming the step and the remedy", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("stamp", () => ctx.now()),
    );

    const message = failure(outcome);
    expect(message).toContain('ctx.now was called inside ctx.step("stamp")');
    // The remedy an author needs: nothing to fix inside a step, because a step's
    // internals are not replayed.
    expect(message).toContain("only its");
    // And the refusal really stopped the walk rather than being narrated.
    expect(outcome.kind).toBe("failed");
  });

  test("fails the run even when the body swallows the refusal", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        await ctx.step("stamp", () => ctx.uuid());
      } catch {
        // Exactly what one shipped template's saga does around its whole body.
      }
      return "looks fine";
    });

    // `completed` here would be the silence the held refusal exists to end.
    expect(outcome.kind).toBe("failed");
    expect(failure(outcome)).toContain('ctx.uuid was called inside ctx.step("stamp")');
  });

  test("leaves the key space untouched, so the failure names one cause", async () => {
    const journal = await seed();
    await replay(journal, async (_input, ctx) => {
      try {
        await ctx.step("stamp", () => ctx.now());
      } catch {
        // See above.
      }
    });

    // No `now!0` was appended, and no occurrence was consumed — the refusal is
    // checked BEFORE the counter advances.
    expect((await journal.readSteps("wrun_j")).some((step) => isDeterminismKey(step.key))).toBe(
      false,
    );
  });
});

describe("the divergence check", () => {
  /**
   * The reason every reach is recorded even though no refusal is raised.
   *
   * A determinism entry comes back out of `readSteps`, so a walk that did not
   * mark it read leaves it in the watch's unread set — and it settled AFTER the
   * step the walk answered, which is exactly what `displaced()` acts on. The
   * next first-reached step is then refused with the renamed-step message, on a
   * run nobody renamed anything in.
   *
   * A/B: deleting the `divergence.reach(…)` call in
   * `workflow-replay-determinism.ts` fails this with
   * "step billing reached `second#0`, which no earlier walk reached".
   */
  test("does not accuse a healthy resume that read the clock between two steps", async () => {
    tickingClock();
    const journal = await seed();
    let crash = true;
    const body: Body = async (_input, ctx) => {
      await ctx.step("first", () => 1);
      const at = await ctx.now();
      if (crash) throw new Error("the worker died here");
      await ctx.step("second", () => 2);
      return at;
    };

    expect((await replay(journal, body)).kind).toBe("failed");
    crash = false;
    const resumed = await replay(journal, body);

    expect(resumed.kind, failure(resumed)).toBe("completed");
  });

  test("still refuses a body whose step NAME moved, with a determinism read in it", async () => {
    tickingClock();
    const journal = await seed();
    const charge = vi.fn(() => "receipt");
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      await ctx.now();
      await ctx.step(`charge-${coin}`, charge);
      await ctx.sleep("nap", 60_000);
    };

    expect((await replay(journal, body)).kind).toBe("suspended");
    coin = "t";
    await journal.wakeSleeps("wrun_j", undefined);

    // Refused at the STEP rather than at the read, which is the documented
    // one-call-later miss — and the side effect is the assertion.
    expect((await replay(journal, body)).kind).toBe("failed");
    expect(charge).toHaveBeenCalledTimes(1);
  });
});

describe("the property, over bodies nobody wrote by hand", () => {
  /**
   * States are counted rather than assumed: an all-green property over a corpus
   * of one-read bodies that never suspended would prove nothing.
   */
  const reached = { suspends: 0, reads: 0, repeats: 0 };

  test("two walks of one body agree on every read, in every order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...DETERMINISM_KINDS), { minLength: 1, maxLength: 6 }),
        // WHERE the run suspends, so the split between the two walks falls at a
        // generated point rather than always before the first read.
        fc.nat(),
        async (kinds: readonly DeterminismKind[], rawSplit: number) => {
          const split = rawSplit % (kinds.length + 1);
          const journal = await seed();
          const walks: unknown[][] = [];
          const body: Body = async (_input, ctx) => {
            // Pushed on ENTRY, not on exit: the first walk unwinds at the sleep
            // and never reaches its own last line, so a list appended at the end
            // would only ever record the walk that COMPLETED — and the
            // comparison below would be an array against itself.
            const seen: unknown[] = [];
            walks.push(seen);
            for (const [index, kind] of kinds.entries()) {
              if (index === split) await ctx.sleep("mid", 60_000);
              seen.push(await ctx[kind]());
            }
            if (split === kinds.length) await ctx.sleep("tail", 60_000);
            return seen;
          };

          const first = await replay(journal, body);
          expect(first.kind).toBe("suspended");
          reached.suspends++;
          await journal.wakeSleeps("wrun_j", undefined);
          const second = await replay(journal, body);
          expect(second.kind, failure(second)).toBe("completed");

          // The first walk unwound at the sleep, so only the reads BEFORE it
          // were seen; the completed walk saw them all. Every read the first
          // walk did make must match the second walk's at the same position.
          expect(walks).toHaveLength(2);
          const before = walks[0] ?? [];
          const all = walks[1] ?? [];
          expect(all).toHaveLength(kinds.length);
          expect(all.slice(0, before.length)).toEqual(before);
          reached.reads += all.length;
          reached.repeats += before.length;
          // And one journal row per read, never two.
          const keys = (await journal.readSteps("wrun_j")).map((step) => step.key);
          expect(keys).toHaveLength(kinds.length);
          expect(new Set(keys).size).toBe(kinds.length);
        },
      ),
      { numRuns: 60 },
    );

    // Ranges over 20 runs, each floor under the OBSERVED MINIMUM. `repeats` is
    // the substantive one: it counts reads the SECOND walk had to answer from
    // the journal, which is the whole claim — a corpus whose sleeps all landed
    // FIRST would satisfy the equality above with nothing replayed at all, and
    // it was measured at exactly that (identical to `reads`) while the first
    // draft recorded the completed walk only.
    // measured 60 on all 20 — one per generated run, so this floor is only
    // there to catch a corpus in which nothing suspended at all.
    expect(reached.suspends, "nothing ever suspended").toBeGreaterThan(40);
    expect(reached.reads, "no read was ever made").toBeGreaterThan(120); // 174-218
    expect(reached.repeats, "no read was ever answered from the journal").toBeGreaterThan(40); // 70-124
  });
});
