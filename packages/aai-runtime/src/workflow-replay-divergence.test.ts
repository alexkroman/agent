// Copyright 2026 the AAI authors. MIT license.
/**
 * The divergence check, stated as the bug it exists for and the four legitimate
 * shapes it must not accuse.
 *
 * Its own file rather than more of `workflow-replay.test.ts`, which sits 26
 * lines under the 700-line test cap. Every case drives the real `replayRun`
 * against the real memory journal: the interesting claims are about what the
 * ENGINE does with a journal, and a unit test of the watch alone would pass
 * while the wiring answered `completed`.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

const RUN = "wrun_d";

type Body = (input: Record<string, unknown>, ctx: WorkflowContext) => Promise<unknown> | unknown;

async function seed(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: RUN,
    workflow: "billing",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  return journal;
}

function replay(journal: JournalStore, run: Body) {
  return replayRun({ runId: RUN, workflow: "billing", input: {}, run, journal });
}

/** The message, whichever arm produced it. */
function failure(outcome: Awaited<ReturnType<typeof replayRun>>): string {
  return outcome.kind === "failed" ? outcome.error.message : `not a failure: ${outcome.kind}`;
}

describe("a body whose non-determinism reaches a step NAME", () => {
  /**
   * The measured defect, made deterministic.
   *
   * Live, the name came from `Math.random() < 0.5 ? "h" : "t"` and **7 of 10
   * runs charged twice while all 10 reported `completed`**. A coin is not a
   * regression test, so the same non-determinism is spelled as a variable the
   * spec moves between the two deliveries — the engine cannot tell the
   * difference, which is the whole point of the bug.
   */
  test("is REFUSED on the second walk instead of executing a second time", async () => {
    const journal = await seed();
    const charge = vi.fn(() => "receipt");
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      await ctx.step(`charge-${coin}`, charge);
      await ctx.sleep("nap", 1000);
      return "done";
    };

    const first = await replay(journal, body);
    expect(first.kind).toBe("suspended");
    expect(charge).toHaveBeenCalledTimes(1);

    coin = "t";
    await journal.wakeSleeps(RUN, undefined);
    const second = await replay(journal, body);

    expect(second.kind).toBe("failed");
    // The side effect is the assertion. Before the check, this was 2.
    expect(charge).toHaveBeenCalledTimes(1);
  });

  test("names BOTH keys, so the reader can tell a rename from a computed name", async () => {
    const journal = await seed();
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      await ctx.step(`charge-${coin}`, () => "receipt");
      await ctx.sleep("nap", 1000);
    };
    await replay(journal, body);
    coin = "t";
    await journal.wakeSleeps(RUN, undefined);
    const message = failure(await replay(journal, body));

    expect(message).toContain("charge-t#0");
    expect(message).toContain("charge-h#0");
    // The two causes, each with its own remedy — see `divergedMessage`.
    expect(message).toContain("CODE changed");
    expect(message).toContain("BODY is non-deterministic");
  });

  /**
   * The quieter half, and the one the live reproduction actually took: a body
   * that catches broadly swallows the refusal and carries on to an answer.
   * `recap-workflow`'s saga is the shipped shape.
   */
  test("still fails the run when the body SWALLOWS the refusal", async () => {
    const journal = await seed();
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      try {
        await ctx.step(`charge-${coin}`, () => "receipt");
      } catch {
        return "recovered";
      }
      await ctx.sleep("nap", 1000);
      return "done";
    };
    await replay(journal, body);
    coin = "t";
    await journal.wakeSleeps(RUN, undefined);

    const outcome = await replay(journal, body);
    expect(outcome.kind).toBe("failed");
    expect(failure(outcome)).toContain("Workflow replay diverged");
  });
});

/**
 * The half the RUN RECORD settles.
 *
 * The message above states two causes and hands the reader a test to run against
 * their own source, because a journal holds what a value WAS and never how it
 * was produced. `RunRecord.codeVersion` closes half of that: recorded at `start`
 * and compared here, it says whether the code moved. Each case asserts the
 * verdict AND that the two-cause fork survives — the fork is what tells a reader
 * what to look for, so eliminating a cause must not delete it.
 */
describe("what the run record says about the CODE", () => {
  /** The same divergence every time; only the two versions differ. */
  async function divergeUnder(startedUnder: string | undefined): Promise<string> {
    const journal = await seed();
    let coin = "h";
    const body: Body = async (_input, ctx) => {
      await ctx.step(`charge-${coin}`, () => "receipt");
      await ctx.sleep("nap", 1000);
    };
    const walk = () =>
      replayRun({ runId: RUN, workflow: "billing", input: {}, run: body, journal, startedUnder });
    await walk();
    coin = "t";
    await journal.wakeSleeps(RUN, undefined);
    return failure(await walk());
  }

  const A = "a".repeat(64);
  const B = "b".repeat(64);

  test("a version that MOVED states the redeploy as a fact, naming both bundles", async () => {
    vi.stubEnv("AAI_BUNDLE_SHA256", B);
    const message = await divergeUnder(A);

    expect(message).toContain("settles which cause this is");
    expect(message).toContain(`STARTED against bundle ${A}`);
    expect(message).toContain(`walked by ${B}`);
    // The fork stays: it is what names the thing to look for.
    expect(message).toContain("BODY is non-deterministic");
  });

  test("a version that did NOT move rules the redeploy out", async () => {
    vi.stubEnv("AAI_BUNDLE_SHA256", A);
    const message = await divergeUnder(A);

    expect(message).toContain("RULES OUT a redeploy");
    expect(message).toContain("Look for the computed name");
    expect(message).not.toContain("settles which cause this is");
  });

  test("a walk with no bundle hash says it cannot tell, rather than agreeing", async () => {
    // `aai dev` and a self-hosted server have no hash. An absent current version
    // must not read as "unchanged": that would rule out the cause that, on a
    // server whose code changes on every file save, is the likeliest one.
    vi.stubEnv("AAI_BUNDLE_SHA256", undefined);
    const message = await divergeUnder(A);

    expect(message).toContain("cannot say which cause this is");
    expect(message).not.toContain("RULES OUT");
  });

  test("a run started before the field existed says the same", async () => {
    vi.stubEnv("AAI_BUNDLE_SHA256", B);
    const message = await divergeUnder(undefined);

    expect(message).toContain("cannot say which cause this is");
    expect(message).not.toContain(`walked by ${B}`);
  });
});

describe("what the check must NOT accuse", () => {
  test("a FIRST walk, whose journal is empty, however many steps it mints", async () => {
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) => {
      // `as const` keeps these LITERALS, which is what `ctx.step` now
      // constrains its name to — a bare `string[]` element is refused.
      for (const name of ["a", "b", "c"] as const) await ctx.step(name, () => name);
      return "ok";
    });
    expect(outcome).toEqual({ kind: "completed", output: "ok" });
  });

  test("new work appended past the end of a fully-read journal", async () => {
    const journal = await seed();
    let tail = false;
    const body: Body = async (_input, ctx) => {
      await ctx.step("head", () => 1);
      if (!tail) {
        await ctx.sleep("nap", 1000);
        return "waited";
      }
      return await ctx.step("tail", () => 2);
    };
    expect((await replay(journal, body)).kind).toBe("suspended");
    tail = true;
    await journal.wakeSleeps(RUN, undefined);
    expect(await replay(journal, body)).toEqual({ kind: "completed", output: 2 });
  });

  /**
   * A crash mid-fan-out leaves GAPS: `segment#1` settled while `segment#0` was
   * still in flight. Unseen on its own would accuse the resume — the attempt
   * claim is what exonerates it, and this is the case that pays for reading it.
   */
  test("a fan-out gap, where the missing key was REACHED and lost", async () => {
    const journal = await seed();
    // `segment#0` was reached and never settled; `segment#1` landed.
    await journal.claimAttempt(RUN, "segment#0", "earlier-walk", 60 * 60 * 1000);
    await journal.appendStep(RUN, {
      key: "segment#1",
      name: "segment",
      status: "ok",
      output: "one",
      attempts: 1,
      finishedAt: Date.now(),
    });

    const ran = vi.fn((n: number) => `re-${n}`);
    const outcome = await replay(journal, async (_input, ctx) =>
      Promise.all([0, 1].map((n) => ctx.step("segment", () => ran(n)))),
    );

    expect(outcome).toEqual({ kind: "completed", output: ["re-0", "one"] });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  /**
   * Every fresh key in a fan-out is judged, not just the first one reached.
   *
   * A fan-out issues its keys SYNCHRONOUSLY, so `displaced()` is asked once per
   * sibling before any of them settles — and the displaced entry it answers has
   * to be the same one every time. That is a property of the scan rather than of
   * the check, and it is what makes the cursor over the journal (which is what
   * keeps this from re-reading every journaled step per fresh step, see
   * `watchDivergence`) safe: it may only ever step past an entry that can never
   * qualify again.
   *
   * A/B'd against a cursor that advances past the entry it ANSWERED: the second
   * sibling is then judged against an exhausted scan, answers `undefined`, and
   * the run reports `completed` having executed the very side effect the check
   * exists to refuse.
   */
  test("judges the SECOND fresh key of a fan-out on the same displaced entry", async () => {
    const journal = await seed();
    // `segment#0` was reached and lost, so its claim exonerates it — this walk
    // may legitimately re-run it, and it is NOT what gets refused.
    await journal.claimAttempt(RUN, "segment#0", "earlier-walk", 60 * 60 * 1000);
    // A journaled step this walk never reads, finished after everything it has
    // answered: the displaced entry.
    await journal.appendStep(RUN, {
      key: "other#0",
      name: "other",
      status: "ok",
      output: "kept",
      attempts: 1,
      finishedAt: Date.now(),
    });

    const ran = vi.fn((n: number) => `re-${n}`);
    const outcome = await replay(journal, async (_input, ctx) =>
      Promise.all([0, 1].map((n) => ctx.step("segment", () => ran(n)))),
    );

    // `segment#1` is the fresh key — never claimed by any walk — so it is the
    // one refused, and the message names it against the displaced entry.
    expect(failure(outcome)).toContain('reached step "segment" as journal key segment#1');
    expect(failure(outcome)).toContain("the first being other#0");
    // The exonerated sibling ran; the refused one never did.
    expect(ran.mock.calls.flat()).toEqual([0]);
  });

  /**
   * The shape that broke the naive check, found by
   * `workflow-resume-equivalence.test.ts` rather than by anyone's imagination.
   *
   * A replay answers the OUTER step from the journal and never runs its
   * callback, so the INNER key is journaled, never re-read, and stays unread for
   * the life of the walk. Treated as evidence, it accuses every later
   * first-reached step — a resumable run turned into a failed one, with no
   * author mistake anywhere in it. `displaced()`'s `finishedAt` test is what
   * excuses it: a child settles at or before its parent.
   */
  test("an orphaned INNER key, which a replay legitimately never re-reads", async () => {
    const journal = await seed();
    const inner = vi.fn(() => "in");
    const tail = vi.fn(() => "tail");
    let reachedTail = false;
    const body: Body = async (_input, ctx) => {
      await ctx.step("outer", () => ctx.step("inner", inner));
      await ctx.sleep("nap", 1000);
      reachedTail = true;
      return await ctx.step("tail", tail);
    };

    expect((await replay(journal, body)).kind).toBe("suspended");
    expect(inner).toHaveBeenCalledTimes(1);

    await journal.wakeSleeps(RUN, undefined);
    const outcome = await replay(journal, body);

    expect(reachedTail).toBe(true);
    expect(outcome).toEqual({ kind: "completed", output: "tail" });
    // The inner step is answered by its parent's entry, so it never re-runs.
    expect(inner).toHaveBeenCalledTimes(1);
    expect(tail).toHaveBeenCalledTimes(1);
  });
});

/**
 * The wait half, which is a different claim from every case above.
 *
 * A step's refusal is INFERRED — an unreached key plus unread work, two facts
 * neither of which is proof on its own. A wait's is stated by the journal: the
 * record carries the token of whichever `ctx.waitFor` registered it, so a
 * mismatch is the store saying outright that this walk is reading somebody
 * else's answer.
 *
 * The keys name their token, so `replayRun` cannot be driven into this through
 * its own `ctx` — which is the assertion, and why the check is exercised through
 * a journal that answers the way a POSITIONAL key space did. See
 * `waitTokenDiverged`.
 */
describe("a wait whose journaled record belongs to a DIFFERENT wait", () => {
  /** A journal that answers every `claimHook` with `token`, whatever was asked. */
  function withHookToken(journal: JournalStore, token: string): JournalStore {
    return {
      ...journal,
      claimHook: async (runId, key, asked) => ({
        ...(await journal.claimHook(runId, key, asked)),
        token,
      }),
    };
  }

  test("fails the run rather than handing the body the other wait's payload", async () => {
    const journal = await seed();
    const paid = vi.fn();
    const body: Body = async (_input, ctx) => {
      const answer = await ctx.waitFor<{ ok: boolean }>("final");
      paid(answer);
      return answer;
    };

    const outcome = await replay(withHookToken(journal, "late"), body);

    expect(outcome.kind).toBe("failed");
    // The body never ran past the wait, so nothing acted on the wrong payload.
    expect(paid).not.toHaveBeenCalled();
  });

  /**
   * Both tokens, for `divergedMessage`'s reason: the reader recognises the two
   * names in their own source, where the key alone (`hook!…`) says nothing.
   */
  test("names the token it reached AND the token that holds the record", async () => {
    const journal = await seed();
    const body: Body = async (_input, ctx) => ctx.waitFor("final");

    const message = failure(await replay(withHookToken(journal, "late"), body));

    expect(message).toContain('ctx.waitFor("final")');
    expect(message).toContain('ctx.waitFor("late")');
    expect(message).toContain("another wait's record");
  });

  /**
   * The refusal is a verdict about the WALK, so a body that catches broadly must
   * not be able to turn it into `completed` — the same property every other
   * refusal on `replayRun`'s `refused` channel has.
   */
  test("still fails the run when the body SWALLOWS the refusal", async () => {
    const journal = await seed();
    const body: Body = async (_input, ctx) => {
      try {
        await ctx.waitFor("final");
      } catch {
        return "swallowed";
      }
      return "answered";
    };

    expect((await replay(withHookToken(journal, "late"), body)).kind).toBe("failed");
  });

  test("passes a wait whose record is its own, which is every correctly-keyed wait", async () => {
    const journal = await seed();
    const body: Body = async (_input, ctx) => ctx.waitFor("final");

    // No wrapper: the real journal answers the token the key names.
    expect((await replay(journal, body)).kind).toBe("suspended");
  });
});
