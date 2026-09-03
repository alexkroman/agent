// Copyright 2026 the AAI authors. MIT license.
/**
 * The STEP and ATTEMPT half of the journal contract, as one case list every
 * backend answers.
 *
 * Split from `journal-conformance-cases.ts` along the seam that file's own
 * `describe` blocks already drew — a run is created and moved, a step is
 * APPENDED and never changed — when `StepEntry.startedAt`'s three cases pushed
 * it past the 500-line cap. Same shape as `journal-conformance-waits.ts` beside
 * it, and `journal-conformance.ts` composes all of them.
 *
 * The two claims worth knowing before adding a case: `appendStep` is idempotent
 * on `key` and answers the STORED entry, which is what makes a double execution
 * deterministic; and `claimAttempt` is monotonic per `(runId, key)`, charged
 * BEFORE the body, which is what makes a crash count against the ceiling.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import { type JournalArm, keysFor, runOf, stepOf } from "./journal-conformance-cases.ts";

/**
 * The step/attempt half of the contract.
 *
 * @internal
 */
export function journalStepConformance(arm: JournalArm): void {
  describe(`journal conformance (steps): ${arm.label}`, () => {
    describe("the journal is APPEND-ONLY and idempotent on a step's key", () => {
      test("the loser of a double execution adopts the WINNER's value", async () => {
        // The whole reason `appendStep` answers with the stored entry rather than
        // with what it was handed: two executions that both ran the step have to
        // agree on what it returned, or the two replays diverge.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const first = await journal.appendStep(
          runId,
          stepOf({ key: "charge#0", output: "first", attempts: 1, finishedAt: 1000 }),
        );
        const second = await journal.appendStep(
          runId,
          stepOf({ key: "charge#0", output: "second", attempts: 4, finishedAt: 2000 }),
        );
        expect(first.output).toBe("first");
        expect(second).toEqual(first);
        expect(await journal.readSteps(runId)).toHaveLength(1);
      });

      test("two concurrent appends of one key agree on one entry", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const [a, b] = await Promise.all([
          journal.appendStep(runId, stepOf({ key: "ship#0", output: "a", finishedAt: 1000 })),
          journal.appendStep(runId, stepOf({ key: "ship#0", output: "b", finishedAt: 1001 })),
        ]);
        expect(a).toEqual(b);
        expect(await journal.readSteps(runId)).toHaveLength(1);
      });

      test("readSteps answers every settled step, in the order they settled", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        for (const [n, key] of ["one#0", "two#0", "three#0"].entries()) {
          await journal.appendStep(runId, stepOf({ key, finishedAt: 1000 + n }));
        }
        expect((await journal.readSteps(runId)).map((s) => s.key)).toEqual([
          "one#0",
          "two#0",
          "three#0",
        ]);
      });

      test("readSteps is empty for a run with no steps, and for one nobody started", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const missing = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        expect(await journal.readSteps(runId)).toEqual([]);
        expect(await journal.readSteps(missing.runId)).toEqual([]);
      });

      test("readStep answers ONE settled step by key, and undefined for anything else", async () => {
        // The keyed read `settledSince` asks with. Its three misses matter as much
        // as its hit: a key nobody settled, a key on the WRONG run, and a run
        // nobody started all mean "not settled" rather than raising — the answer
        // only ever SKIPS work, so reading it wrongly re-runs a step, which
        // at-least-once already permits.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const missing = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.createRun(runOf({ runId: missing.runId }));
        const entry = stepOf({ key: "poll#1", name: "poll", finishedAt: 4242 });
        await journal.appendStep(runId, entry);
        expect(await journal.readStep(runId, "poll#1")).toEqual(entry);
        expect(await journal.readStep(runId, "poll#0")).toBeUndefined();
        expect(await journal.readStep(missing.runId, "poll#1")).toBeUndefined();
        expect(await journal.readStep(keysFor(arm).runId, "poll#1")).toBeUndefined();
      });

      test("readStep and readSteps agree on every entry, so neither can drift", async () => {
        // Two statements over one table, and the interesting failure is a column
        // one of them forgot — which is invisible to a case that only ever asks
        // one of them. `startedAt` is the live instance: it was added by an
        // `alter table`, so a read that omitted it would answer a step with no
        // derivable cost and nothing else would notice.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        for (const [n, key] of ["a#0", "b#0", "c#0"].entries()) {
          await journal.appendStep(
            runId,
            stepOf({ key, name: key.slice(0, 1), startedAt: 900 + n, finishedAt: 1000 + n }),
          );
        }
        for (const entry of await journal.readSteps(runId)) {
          expect(await journal.readStep(runId, entry.key)).toEqual(entry);
        }
      });

      test("a step's name and attempt count are what was stored", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const entry = stepOf({ key: "poll#3", name: "poll", attempts: 4, finishedAt: 1234 });
        expect(await journal.appendStep(runId, entry)).toEqual(entry);
      });

      test("a step's START survives the round trip, so its cost is derivable", async () => {
        // The whole point of the column: `finishedAt - startedAt` is what the
        // step cost, and an arm that dropped the value would report every step
        // as unknown-duration while every other arm reported a real one.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const entry = stepOf({ key: "convert#0", startedAt: 1000, finishedAt: 4500 });

        expect(await journal.appendStep(runId, entry)).toMatchObject({
          startedAt: 1000,
          finishedAt: 4500,
        });
        const read = await journal.readSteps(runId);
        expect(read.find((step) => step.key === "convert#0")).toMatchObject({ startedAt: 1000 });
      });

      test("an ABSENT start reads back absent, never as zero", async () => {
        // A row written before the column existed has no start, and `0` reads
        // as the epoch — so a step that took two seconds would report as having
        // taken fifty-five years. Every arm must answer `undefined`, which is
        // what `StepEntry.startedAt` obliges a reader to render as unknown.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const entry = stepOf({ key: "legacy#0", finishedAt: 2000 });
        // `stepOf` defaults no start, so this is the pre-column shape exactly.
        expect(entry.startedAt).toBeUndefined();

        expect((await journal.appendStep(runId, entry)).startedAt).toBeUndefined();
        const read = await journal.readSteps(runId);
        expect(read.find((step) => step.key === "legacy#0")?.startedAt).toBeUndefined();
      });

      test("a start of 0 is kept, because the epoch is a legal instant", async () => {
        // The other side of the absence rule: `0` must not be COERCED to absent
        // either, or an arm reading `startedAt ?? undefined` would look correct
        // against the case above while silently dropping a real value. Nothing
        // produces an epoch start in practice; the point is that the two
        // conditions are distinguished rather than conflated.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const entry = stepOf({ key: "epoch#0", startedAt: 0, finishedAt: 5 });

        expect((await journal.appendStep(runId, entry)).startedAt).toBe(0);
      });
    });

    describe("claimAttempt is MONOTONIC, per run and per key", () => {
      test("the first claim is 1 and every later one is the next number", async () => {
        // Claimed BEFORE the body runs, so a process that dies mid-step has
        // already burned the attempt and a step that wedges the guest cannot be
        // redelivered forever.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        expect(await journal.claimAttempt(runId, "charge#0")).toBe(1);
        expect(await journal.claimAttempt(runId, "charge#0")).toBe(2);
        expect(await journal.claimAttempt(runId, "charge#0")).toBe(3);
      });

      test("two keys on one run are counted independently", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimAttempt(runId, "charge#0");
        await journal.claimAttempt(runId, "charge#0");
        expect(await journal.claimAttempt(runId, "ship#0")).toBe(1);
        expect(await journal.claimAttempt(runId, "charge#0")).toBe(3);
      });

      test("two runs sharing a key are counted independently", async () => {
        const journal = arm.journal();
        const one = keysFor(arm);
        const two = keysFor(arm);
        await journal.createRun(runOf({ runId: one.runId }));
        await journal.createRun(runOf({ runId: two.runId }));
        await journal.claimAttempt(one.runId, "charge#0");
        expect(await journal.claimAttempt(two.runId, "charge#0")).toBe(1);
      });

      test("two concurrent claims never hand out the same number", async () => {
        // Anything that READS then WRITES gives both deliveries the same number
        // and lets a step exceed its ceiling. One statement is the remedy, and
        // this is the assertion that can tell the two apart.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const claimed = await Promise.all([
          journal.claimAttempt(runId, "charge#0"),
          journal.claimAttempt(runId, "charge#0"),
          journal.claimAttempt(runId, "charge#0"),
        ]);
        expect([...claimed].sort((a, b) => a - b)).toEqual([1, 2, 3]);
      });

      test("a release gives one back, and the next claim re-takes it", async () => {
        // A charge is a LEASE — see `JournalStore.releaseAttempt`. Only an
        // attempt that never ENDED keeps one, which is what makes the ceiling a
        // bound on abandonment rather than on reaches.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.claimAttempt(runId, "charge#0");
        expect(await journal.claimAttempt(runId, "charge#0")).toBe(2);
        await journal.releaseAttempt(runId, "charge#0");
        expect(await journal.claimAttempt(runId, "charge#0")).toBe(2);
      });

      test("a release can never take the count below zero", async () => {
        // Floored, so a release that lands twice may only under-charge a budget
        // the next claim re-takes — where a negative count is an unbounded budget
        // for a step that wedges the guest.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await journal.releaseAttempt(runId, "charge#0");
        await journal.releaseAttempt(runId, "charge#0");
        expect(await journal.claimAttempt(runId, "charge#0")).toBe(1);
      });
    });
  });
}
