// Copyright 2026 the AAI authors. MIT license.
/**
 * The two schema checks, and what each one is the ONLY thing standing between.
 *
 * **Every test here fails if the check it names is reverted**, which is the bar
 * this file is written to: a schema option whose absence changes nothing is
 * decoration, and both of these replace a cast that used to be silent. The A/B
 * for each is stated at the test, and all four were run:
 *
 * - Drop the wait's validation (`payloadOf` returning `payload as T`) and "a
 *   payload the schema rejects" reports `completed` carrying the stranger's own
 *   object.
 * - Journal the RAW value instead of the schema's (`checkedStepOutput`'s return)
 *   and "journals the value the schema produced" reads back `"3"` for a number.
 * - Drop the write check and "a body that returns the wrong shape" completes,
 *   with the bad value journaled as `ok` — which is the state the read check then
 *   finds days later.
 * - Drop the read check (`journaledStepOutput` returning `entry.output`) and "a
 *   journal that no longer matches the schema" completes, handing the body a
 *   value from a bundle that no longer exists.
 *
 * The other half of what is asserted here is the CLASSIFICATION, because that is
 * the part a message cannot show: a write-side rejection spends attempts and
 * settles the step `failed`, and a read-side one journals NOTHING — the step
 * succeeded, and "only a walk whose own body threw may write a `failed` entry"
 * is the rule the whole attempt lease rests on.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore, RunRecord } from "./workflow-journal-types.ts";
import { type ReplayOutcome, replayRun } from "./workflow-replay.ts";

const RUN_ID = "wrun_1";

/** A journal holding one `running` record, ready to replay. */
async function seed(journal: JournalStore = createMemoryJournal()): Promise<JournalStore> {
  const record: RunRecord = {
    runId: RUN_ID,
    workflow: "digest",
    status: "running",
    createdAt: Date.now(),
    input: {},
  };
  await journal.createRun(record);
  return journal;
}

/** Replay `run` against a journal, optionally as a run started under `startedUnder`. */
function replay(
  journal: JournalStore,
  run: (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown,
  startedUnder?: string,
) {
  return replayRun({ runId: RUN_ID, workflow: "digest", input: {}, run, journal, startedUnder });
}

/** The failure message, or a name for whatever else the outcome was. */
function failureMessage(outcome: ReplayOutcome): string {
  return outcome.kind === "failed" ? outcome.error.message : `not a failure: ${outcome.kind}`;
}

const Approval = z.object({ approved: z.boolean() });

describe("ctx.waitFor({ schema })", () => {
  /**
   * Register the wait, deliver `payload` to it, and walk again — the two
   * deliveries a real signal produces, since a payload can only reach a hook the
   * body has already reached once.
   */
  async function signalled(
    payload: unknown,
    body: (ctx: WorkflowCtx) => Promise<unknown>,
  ): Promise<{ journal: JournalStore; outcome: ReplayOutcome }> {
    const journal = await seed();
    const first = await replay(journal, async (_input, ctx) => body(ctx));
    // Plain throws rather than `expect`: this is SETUP, and an assertion outside
    // a test body is a lint error here (`noMisplacedAssertion`) precisely because
    // it would not be reported as the failure it is. Each names what went wrong.
    if (first.kind !== "suspended") {
      throw new Error(`the wait did not suspend before any signal: ${first.kind}`);
    }
    const woke = await journal.deliverHook("approval", payload);
    if (woke !== RUN_ID) throw new Error(`the signal reached no run: ${String(woke)}`);
    return { journal, outcome: await replay(journal, async (_input, ctx) => body(ctx)) };
  }

  test("hands the body the value the SCHEMA produced, not what arrived", async () => {
    // A/B: with the check reverted this reads back the extra key, because the
    // body would be handed the stranger's own object under a type that denies it.
    const { outcome } = await signalled(
      { approved: true, sneaked: "an unexpected key" },
      async (ctx) => await ctx.waitFor("approval", { schema: Approval }),
    );
    expect(outcome).toEqual({ kind: "completed", output: { approved: true } });
  });

  test("a payload the schema rejects FAILS the run, naming the workflow, the token and the issue", async () => {
    const { outcome } = await signalled({ approved: "yes" }, async (ctx) =>
      ctx.waitFor("approval", { schema: Approval }),
    );
    const message = failureMessage(outcome);
    expect(message).toContain('Workflow "digest"');
    expect(message).toContain('ctx.waitFor("approval")');
    expect(message).toContain("approved:");
    // The classification, in the message the author reads: not a retry.
    expect(message).toContain("the run fails here rather than retrying");
  });

  test("the refusal survives a body that catches everything", async () => {
    // The `refused` channel, not merely the throw — one shipped template wraps
    // its whole body in a try/catch, and a swallowed refusal would report
    // `completed` over a payload nothing verified.
    const { outcome } = await signalled({ approved: "yes" }, async (ctx) => {
      try {
        return await ctx.waitFor("approval", { schema: Approval });
      } catch {
        return { swallowed: true };
      }
    });
    expect(outcome.kind).toBe("failed");
  });

  test("a redelivery of the same bad payload refuses again, and the hook stays answered", async () => {
    // Why the refusal is FATAL. The payload is journaled, so there is nothing a
    // second delivery could read differently — and the window is left as the
    // delivery found it rather than reopened for a corrected signal.
    const { journal, outcome } = await signalled({ approved: "yes" }, async (ctx) =>
      ctx.waitFor("approval", { schema: Approval }),
    );
    expect(outcome.kind).toBe("failed");
    const again = await replay(journal, async (_input, ctx) =>
      ctx.waitFor("approval", { schema: Approval }),
    );
    expect(failureMessage(again)).toBe(failureMessage(outcome));
    // Reopened, a second signal would be taken; answered, it is refused.
    expect(await journal.deliverHook("approval", { approved: true })).toBeUndefined();
  });

  test("a window that CLOSES unanswered is not a validation failure", async () => {
    // The schema is never consulted on a timeout: there is no payload, and
    // running it over "nobody answered" would fail every timeout a validating
    // wait ever takes.
    const journal = await seed();
    const body = async (_input: Record<string, unknown>, ctx: WorkflowCtx) => {
      const approval = await ctx.waitFor("approval", { schema: Approval, timeoutMs: 50 });
      return { approval: approval ?? "expired" };
    };
    expect(
      (await replayRun({ runId: RUN_ID, workflow: "digest", input: {}, run: body, journal })).kind,
    ).toBe("suspended");
    vi.setSystemTime(Date.now() + 1000);
    const outcome = await replayRun({
      runId: RUN_ID,
      workflow: "digest",
      input: {},
      run: body,
      journal,
    });
    expect(outcome).toEqual({ kind: "completed", output: { approval: "expired" } });
    vi.useRealTimers();
  });
});

describe("ctx.step({ schema }) on the WRITE", () => {
  const Count = z.object({ n: z.coerce.number() });

  test("journals the value the schema produced, so every replay reads the same one", async () => {
    // A/B: journaling the raw value instead leaves `"3"` in the entry, and the
    // next walk is handed a string where this one saw a number.
    const journal = await seed();
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("count", () => ({ n: "3" }), { schema: Count }),
    );
    expect(outcome).toEqual({ kind: "completed", output: { n: 3 } });
    expect((await journal.readSteps(RUN_ID)).map((s) => s.output)).toEqual([{ n: 3 }]);
  });

  test("a body that returns the wrong shape SPENDS its attempts and settles `failed`", async () => {
    // The classification: this one is the step's own failure, so it takes the
    // ordinary retry path — a body that produced a bad value once may produce a
    // good one next time.
    const journal = await seed();
    const body = vi.fn(() => ({ n: "not a number" }));
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("count", body, { schema: Count, maxAttempts: 2 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(failureMessage(outcome)).toContain('Step "count" produced a value its schema rejects');
    expect(body, "a schema rejection must be retried like any step failure").toHaveBeenCalledTimes(
      2,
    );
    const [entry] = await journal.readSteps(RUN_ID);
    expect(entry?.status).toBe("failed");
    expect(entry?.attempts).toBe(2);
    // Nothing the schema refused is in the journal, which is the point of
    // checking before the append rather than after it.
    expect(entry?.output).toBeUndefined();
  });

  test("a schema that THROWS is a failed check, not an error escaping the engine", async () => {
    const journal = await seed();
    const exploding = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          throw new Error("vendor exploded");
        },
      },
    } as const;
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("count", () => ({ n: 1 }), { schema: exploding, maxAttempts: 1 }),
    );
    expect(failureMessage(outcome)).toContain("the schema itself threw: vendor exploded");
  });
});

describe("ctx.step({ schema }) on the READ", () => {
  /** A journal in which `count#0` settled `ok` with a value from another shape. */
  async function journalHolding(output: unknown): Promise<JournalStore> {
    const journal = await seed();
    await journal.appendStep(RUN_ID, {
      key: "count#0",
      name: "count",
      status: "ok",
      output,
      attempts: 1,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    });
    return journal;
  }

  const Count = z.object({ n: z.number() });

  test("a journal that no longer matches the schema REFUSES the run", async () => {
    // A/B: without the read check the body is handed `{ n: "3" }` under a type
    // that says `number` and the run reports `completed` — the redeploy case,
    // which the write check structurally cannot see.
    const journal = await journalHolding({ n: "3" });
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("count", () => ({ n: 1 }), { schema: Count }),
    );
    const message = failureMessage(outcome);
    expect(message).toContain('Workflow replay refused step "count"');
    expect(message).toContain("count#0");
    expect(message).toContain("That step SUCCEEDED");
  });

  test("and journals NOTHING over the step that succeeded", async () => {
    // "An attempt is a LEASE": only a walk whose own body threw may write a
    // `failed` entry. A/B: classify this as a step failure and the entry below
    // flips to `failed`, destroying the record of work that really happened.
    const journal = await journalHolding({ n: "3" });
    const body = vi.fn(() => ({ n: 1 }));
    await replay(journal, async (_input, ctx) => ctx.step("count", body, { schema: Count }));

    expect(
      body,
      "a settled step must not be re-run by the check that refuses it",
    ).not.toHaveBeenCalled();
    const [entry] = await journal.readSteps(RUN_ID);
    expect(entry?.status).toBe("ok");
    expect(entry?.output).toEqual({ n: "3" });
    expect(entry?.attempts).toBe(1);
  });

  test("the refusal survives a body that catches everything", async () => {
    const journal = await journalHolding({ n: "3" });
    const outcome = await replay(journal, async (_input, ctx) => {
      try {
        return await ctx.step("count", () => ({ n: 1 }), { schema: Count });
      } catch {
        return { swallowed: true };
      }
    });
    expect(outcome.kind).toBe("failed");
  });

  test("names what the run record says about the code", async () => {
    // The one reader `RunRecord.codeVersion` exists for. A redeploy mid-flight
    // is the likeliest cause of a journal that stopped matching, so the message
    // states it as a fact when the record settles it.
    vi.stubEnv("AAI_BUNDLE_SHA256", "bundle-b");
    const journal = await journalHolding({ n: "3" });
    const outcome = await replay(
      journal,
      async (_input, ctx) => ctx.step("count", () => ({ n: 1 }), { schema: Count }),
      "bundle-a",
    );
    const message = failureMessage(outcome);
    expect(message).toContain("STARTED against bundle bundle-a");
    expect(message).toContain("is being walked by bundle-b");
  });

  test("an entry the schema accepts is answered from the journal, coerced as this walk expects", async () => {
    // The check is invisible to a healthy replay, which is the other half of
    // "every legal program still works".
    const journal = await journalHolding({ n: 3 });
    const body = vi.fn(() => ({ n: 1 }));
    const outcome = await replay(journal, async (_input, ctx) =>
      ctx.step("count", body, { schema: Count }),
    );
    expect(outcome).toEqual({ kind: "completed", output: { n: 3 } });
    expect(body).not.toHaveBeenCalled();
  });
});
