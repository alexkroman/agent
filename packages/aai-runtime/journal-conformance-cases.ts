// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link JournalStore} contract's first half: a run, its steps, its
 * attempts — "what has this run DONE".
 *
 * `journal-conformance.ts` is the entry point and carries the whole argument for
 * the pattern, the three arms and the rules for a new case. This file is the
 * shared VOCABULARY every arm and every other half needs ({@link JournalArm},
 * {@link journalIds}, {@link keysFor}) plus the cases that read and write a run.
 * The wait half is `journal-conformance-waits.ts`, the resume half
 * `journal-conformance-resume.ts` and the typed-JSON half
 * `journal-conformance-codec.ts`; each split is the file-length cap's doing and
 * lands on a seam the entry module names.
 *
 * The vocabulary lives HERE rather than in the entry module for one mechanical
 * reason: the entry module imports both halves, so a helper declared there and
 * imported back would be a cycle. This is the leaf.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import type { JournalStore, RunRecord, StepEntry } from "./workflow-journal-types.ts";

/**
 * One backend under test.
 *
 * `journal()` is called per case rather than once, so an arm may hand back a
 * fresh store (memory) or the one shared store its tier can afford (Postgres)
 * without any case knowing which.
 */
export type JournalArm = {
  /** What the reporter calls this backend. */
  label: string;
  /** The store one case runs against. */
  journal: () => JournalStore;
  /** A fresh, collision-proof identifier per call — see the arm-independence rule. */
  uid: () => string;
  /**
   * Does this backend DECLARE `resumableRuns`?
   *
   * The one part of this contract a backend may legitimately not have —
   * `workflow-journal-platform.ts` omits it because a deployed guest's recovery
   * is the platform queue's reconcile. So `journal-conformance-resume.ts`'s ten
   * cases are EXCLUDED on an arm that answers `false`, and the exclusion is
   * REPORTED: the field is required, read at collection time, and drives a
   * `describe` the reporter prints as skipped.
   *
   * It is a DECLARATION and not a probe, which is the whole point. The probe
   * (`isResumableJournal(arm.journal())`) cannot run at collection time — the
   * Postgres arm builds its store in `beforeAll` — so the ten cases used to
   * probe in their own BODIES and `return` when the answer was no. That reports
   * a green checkmark per case, at 0 ms, indistinguishable in the reporter from
   * the ten real passes of the memory arm printed directly above them: 10 of 69
   * shared cases silently checking nothing on both platform arms. A declaration
   * is available before collection, so the skip can be announced instead — and
   * `journal-conformance-resume.ts` pins the declaration against the probe in a
   * case that always runs, so a wrong `resumable` is a FAILURE rather than a
   * quieter version of the same silence.
   */
  resumable: boolean;
};

/**
 * A fresh id per call, unique across processes and across two runs of one file.
 *
 * The pid is in the PREFIX for the reason `CONFORMANCE_PREFIX` in
 * `aai-server/store-conformance.ts` puts it there. Here the scenario arm drops a
 * whole schema instead, so the pid is belt-and-braces — but the timestamp is
 * not: a re-run of one file against a database that survived it would otherwise
 * collide on `createRun`'s primary key and report a contract failure for a
 * housekeeping one.
 */
export function journalIds(label: string): () => string {
  let n = 0;
  return () => `${label}-${process.pid}-${Date.now().toString(36)}-${n++}`;
}

/** The three names one case owns, all minted from one id so they read together. */
export function keysFor(arm: JournalArm): { runId: string; workflow: string; token: string } {
  const id = arm.uid();
  return { runId: `wrun-${id}`, workflow: `wf-${id}`, token: `tok-${id}` };
}

/** A run record with everything defaulted, so a case names only what it is about. */
export function runOf(overrides: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    workflow: "conformance",
    status: "pending",
    createdAt: Date.now(),
    input: { topic: "otters" },
    ...overrides,
  };
}

/** A settled step with everything defaulted. */
export function stepOf(overrides: Partial<StepEntry> & { key: string }): StepEntry {
  return {
    name: overrides.key.split("#")[0] ?? overrides.key,
    status: "ok",
    output: { ok: true },
    attempts: 1,
    finishedAt: Date.now(),
    ...overrides,
  };
}

/**
 * The run/step/attempt half of the contract.
 *
 * @internal
 */
export function journalRunConformance(arm: JournalArm): void {
  describe(`journal conformance (runs): ${arm.label}`, () => {
    describe("a run is created once and read back whole", () => {
      test("createRun then getRun answers the record that was stored", async () => {
        const journal = arm.journal();
        const { runId, workflow } = keysFor(arm);
        const record = runOf({ runId, workflow, createdAt: 1_700_000_000_123 });
        await journal.createRun(record);
        expect(await journal.getRun(runId)).toEqual(record);
      });

      test("getRun answers undefined for a run nobody started", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        expect(await journal.getRun(runId)).toBeUndefined();
      });

      test("createRun REFUSES a second run on the same id", async () => {
        // The id is the CALLER's, so a collision means two starts raced and
        // exactly one may win. Silently keeping either one discards a run
        // somebody is already holding an id for.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        await expect(journal.createRun(runOf({ runId, workflow: "other" }))).rejects.toThrow();
      });

      test("listRuns is newest first, filtered to one workflow, capped at limit", async () => {
        const journal = arm.journal();
        const { runId, workflow } = keysFor(arm);
        const other = keysFor(arm);
        const base = 1_700_000_000_000;
        for (const [n, at] of [base, base + 1, base + 2].entries()) {
          await journal.createRun(runOf({ runId: `${runId}-${n}`, workflow, createdAt: at }));
        }
        // A run of a DIFFERENT workflow must not appear, however recent it is.
        await journal.createRun(
          runOf({ runId: other.runId, workflow: other.workflow, createdAt: base + 9 }),
        );
        const listed = await journal.listRuns(workflow, 2);
        expect(listed.map((r) => r.runId)).toEqual([`${runId}-2`, `${runId}-1`]);
      });

      test("listRuns answers an empty page for a workflow with no runs", async () => {
        const journal = arm.journal();
        const { workflow } = keysFor(arm);
        expect(await journal.listRuns(workflow, 10)).toEqual([]);
      });
    });

    describe("the absence matrix", () => {
      // Every drift a review of the three backends found was an edge case about
      // ABSENCE — `undefined` against `null` against `""` against missing — so
      // this section is where the contract is at its most explicit.

      test("a run started with NO input reads back with input absent", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, input: undefined }));
        const run = await journal.getRun(runId);
        expect(run?.input).toBeUndefined();
      });

      test("a run started with a NULL input reads back null, not absent", async () => {
        // `null` is a value an author can pass and `undefined` is the absence of
        // one; a backend that stores both as SQL NULL loses the difference and a
        // replay reads a different input than the run was started with.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, input: null }));
        const run = await journal.getRun(runId);
        expect(run?.input).toBeNull();
      });

      test("a run started under a bundle reads that version back", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const codeVersion = "a".repeat(64);
        await journal.createRun(runOf({ runId, codeVersion }));
        expect((await journal.getRun(runId))?.codeVersion).toBe(codeVersion);
      });

      test("a run started with NO bundle version reads back ABSENT, not empty", async () => {
        // The distinction the divergence message rests on. Off the platform
        // there is no bundle hash at all, so a backend answering `""` or `null`
        // here would compare unequal to every real version and have the message
        // report a redeploy on a run that never had one — asserting as a fact
        // the one cause it should have ruled out.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, codeVersion: undefined }));
        expect((await journal.getRun(runId))?.codeVersion).toBeUndefined();
      });

      test("listRuns carries the bundle version, not only getRun", async () => {
        // Its own case because the two reads are two SQL statements per backend
        // and only one of them is exercised by everything else here: a column
        // added to the `getRun` select and forgotten in `listRuns` reads back as
        // absent from the listing, which is indistinguishable from a run that
        // never had one. Caught exactly that way while writing this.
        const journal = arm.journal();
        const { runId, workflow } = keysFor(arm);
        const codeVersion = "b".repeat(64);
        await journal.createRun(runOf({ runId, workflow, codeVersion }));
        expect((await journal.listRuns(workflow, 10))[0]?.codeVersion).toBe(codeVersion);
      });

      test("a VOID workflow completes: an undefined output is not a driver error", async () => {
        // postgres.js refuses an undefined parameter outright, so a body that
        // returns nothing — ordinary, for one that exists to do side effects —
        // made `setStatus` throw from inside the driver and the run never left
        // `running`. The delivery then failed and was retried against the same
        // fault, forever.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        expect(await journal.setStatus(runId, "completed", { output: undefined })).toBe(true);
        const run = await journal.getRun(runId);
        expect(run?.status).toBe("completed");
        expect(run?.output).toBeUndefined();
      });

      test("a completed run with a NULL output reads back null", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.setStatus(runId, "completed", { output: null });
        expect((await journal.getRun(runId))?.output).toBeNull();
      });

      test("a run that never failed reads back with error absent", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.setStatus(runId, "completed", { output: 1 });
        expect((await journal.getRun(runId))?.error).toBeUndefined();
      });

      test("a failed run carries its message", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.setStatus(runId, "failed", { error: { message: "the otter escaped" } });
        const run = await journal.getRun(runId);
        expect(run?.status).toBe("failed");
        expect(run?.error).toEqual({ message: "the otter escaped" });
      });

      test("an ok step with no output has neither an output nor an error", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const stored = await journal.appendStep(
          runId,
          stepOf({ key: "notify#0", output: undefined }),
        );
        expect(stored.output).toBeUndefined();
        expect(stored.error).toBeUndefined();
      });

      test("a failed step carries its message and no output", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const stored = await journal.appendStep(
          runId,
          stepOf({
            key: "charge#0",
            status: "failed",
            output: undefined,
            error: { message: "card declined" },
          }),
        );
        expect(stored.status).toBe("failed");
        expect(stored.error).toEqual({ message: "card declined" });
        expect(stored.output).toBeUndefined();
      });

      test("a step's output that is NULL is not the same as one that is absent", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const stored = await journal.appendStep(runId, stepOf({ key: "lookup#0", output: null }));
        expect(stored.output).toBeNull();
      });
    });

    describe("setStatus is a COMPARE-AND-SET, and the answer is whether it moved", () => {
      test("it moves when the current status is in expect", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        expect(await journal.setStatus(runId, "completed", { output: 42 }, ["running"])).toBe(true);
        expect((await journal.getRun(runId))?.output).toBe(42);
      });

      test("it REFUSES when the run is not where the caller thought, and changes nothing", async () => {
        // The failure this prevents: a cancelled run marked `completed` by a
        // worker that had not noticed the cancel.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.setStatus(runId, "cancelled", undefined, ["pending", "running"]);
        expect(await journal.setStatus(runId, "completed", { output: 42 }, ["running"])).toBe(
          false,
        );
        const run = await journal.getRun(runId);
        expect(run?.status).toBe("cancelled");
        expect(run?.output).toBeUndefined();
      });

      test("an absent expect matches whatever the run is now", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "pending" }));
        expect(await journal.setStatus(runId, "running")).toBe(true);
        expect((await journal.getRun(runId))?.status).toBe("running");
      });

      test("a run nobody started answers false rather than throwing", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        expect(await journal.setStatus(runId, "completed", { output: 1 })).toBe(false);
      });

      test("only the FIRST of two deliveries completes the run", async () => {
        // Both racing workers ran the body; the compare-and-set is what decides
        // which one's answer the run reports.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        const verdicts = await Promise.all([
          journal.setStatus(runId, "completed", { output: "first" }, ["running"]),
          journal.setStatus(runId, "completed", { output: "second" }, ["running"]),
        ]);
        expect(verdicts.filter(Boolean)).toHaveLength(1);
      });

      test("a later status move with NO patch leaves the stored output alone", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.setStatus(runId, "completed", { output: { kept: true } });
        expect(await journal.setStatus(runId, "cancelled")).toBe(true);
        expect((await journal.getRun(runId))?.output).toEqual({ kept: true });
      });
    });
  });
}
