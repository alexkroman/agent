// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link JournalStore} contract's third half: which runs does a local
 * dispatcher still OWE a delivery?
 *
 * Split from `journal-conformance-waits.ts` for the line cap, on a real seam. The
 * other two halves are per-RUN questions — "what has this run done", "may this
 * wait still be answered" — and every case there names one run. This one asks a
 * question about the STORE, so its cases have to be written differently (they
 * filter the answer to the ids they own; see {@link owed}) and they are the only
 * ones whose subject is a capability a backend may legitimately not have.
 *
 * What they cover is the fix for a data-loss bug: a run suspended on `ctx.sleep`
 * kept its deadline in the journal and its TIMER in the dispatcher's process, and
 * nothing re-read the journal at boot — so a restart, or an `aai dev` file save,
 * stranded the run at `running` forever on every backend, Postgres included.
 * `JournalStore.resumableRuns` is what a boot sweep enumerates.
 *
 * ## The capability is DECLARED, and the exclusion is REPORTED
 *
 * These are the only conditional cases in the table, and for a while they were
 * conditional the wrong way: each body probed `isResumableJournal(arm.journal())`
 * and `return`ed when the answer was no, so on both platform arms all ten
 * printed `✓ … 0ms` beside the memory arm's ten real passes. Ten of the 69
 * shared cases, checking nothing, indistinguishable from coverage in the
 * reporter, in the totals and in `check:test-assertions` (the `expect` is
 * there — it is just never reached).
 *
 * The decision moved to {@link JournalArm.resumable}, which collection can see,
 * so the ten sit in a `describe` that is SKIPPED with its reason in the title.
 * The probe stayed, as the check on the declaration: one case runs on every arm
 * and fails in both directions — a claimed capability the backend lacks, and a
 * denied one it has.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import { codeUnit } from "./_workflow-journal-order.ts";
import { type JournalArm, keysFor, runOf } from "./journal-conformance-cases.ts";
import {
  isResumableJournal,
  type ResumableJournal,
  type ResumableRun,
} from "./workflow-journal-types.ts";

/**
 * Bigger than any arm's live set, because `resumableRuns` is the one query in
 * this contract that is not scoped to a run — the Postgres arm shares one schema
 * across every case in the file, so a bound near a case's own run count would
 * drop it.
 */
const WIDE = 1000;

/** Far enough out that no case's wall-clock reads it as elapsed. */
const FAR = 60_000;

/**
 * This arm's journal, narrowed to the capability its arm DECLARED.
 *
 * Only ever reached on an arm whose `resumable` is `true` — the declaration
 * skips the whole `describe` otherwise — so an absent `resumableRuns` here is a
 * contract violation and not a state to route around. It THROWS, naming both
 * halves of the disagreement, because the two ways to get here are a backend
 * that lost the method and an arm whose declaration is wrong, and a reader
 * needs to know which.
 *
 * This used to be `ResumableJournal | undefined`, probed in each case's own
 * body, with `if (!journal) return;` above every assertion — the silent skip
 * {@link JournalArm.resumable} carries the argument against. Probing in a body
 * was itself correct and still is: the Postgres arm builds its store in
 * `beforeAll`, so `arm.journal()` answers `undefined` at collection time. What
 * changed is that the DECISION moved to the declaration, where collection can
 * see it, and the probe stayed here as the check on that declaration.
 */
function resumableOf(arm: JournalArm): ResumableJournal {
  const journal = arm.journal();
  if (!isResumableJournal(journal)) {
    throw new Error(
      `${arm.label} declares resumable: true, but its journal has no resumableRuns — ` +
        "either the backend lost the method or the arm's declaration is wrong",
    );
  }
  return journal;
}

/**
 * What this journal owes, narrowed to the runs one case OWNS.
 *
 * Every other case's rows are legitimately in the answer on the shared-schema
 * arm, so a case asserts about its own ids and never about the whole set. The
 * ORDER of the filtered list is preserved, which is what lets a case check the
 * contract's "earliest deadline first" without owning the store.
 */
async function owed(journal: ResumableJournal, ...runIds: string[]): Promise<ResumableRun[]> {
  const all = await journal.resumableRuns(WIDE);
  return all.filter((run) => runIds.includes(run.runId));
}

/**
 * `describe.skip` as a VALUE.
 *
 * Biome's `noSkippedTests` flags the `describe.skip(…)` CALL form, and this
 * exclusion is a declared property of an arm rather than a test somebody parked
 * — so it is referenced the way `aai-server/_pg-test-utils.ts`'s gates
 * reference it, rather than reaching for a suppression.
 */
const skipSuite = describe.skip;

/**
 * The excluded suite still gets a TITLE, and the title carries the reason.
 *
 * A skip the reporter prints without saying why is only half a fix: the reader
 * who notices ten skipped cases beside the memory arm's ten passes has to go
 * find out whether that is a decision or a breakage. Naming it in the title
 * means the answer is in the same line as the skip.
 */
function resumeTitle(arm: JournalArm): string {
  return arm.resumable
    ? "resumableRuns: which runs does a boot sweep still OWE"
    : "resumableRuns: EXCLUDED — this backend declares none, so a deployed run's " +
        "recovery is the platform queue's reconcile";
}

/**
 * The boot-sweep half of the contract.
 *
 * @internal
 */
export function journalResumeConformance(arm: JournalArm): void {
  describe(`journal conformance (resume): ${arm.label}`, () => {
    test("the arm's `resumable` declaration is what its journal really has", () => {
      // Runs on EVERY arm, including an excluded one, and it is what makes the
      // exclusion below an assertion rather than an omission. Two failures live
      // here: an arm claiming a capability its backend lost (the ten cases would
      // then throw out of `resumableOf`, but only if they RAN), and an arm
      // denying one its backend has — which is the direction that costs
      // coverage silently, because the exclusion looks exactly as deliberate
      // either way. Probed in a BODY, since the Postgres arm builds its store in
      // `beforeAll`; see {@link JournalArm.resumable}.
      const journal = arm.journal();
      expect(isResumableJournal(journal)).toBe(arm.resumable);
      // And the probe really is about the METHOD, not about the object being
      // there at all — an arm whose `journal()` answered nothing would otherwise
      // satisfy `resumable: false` for the wrong reason.
      expect(journal).toBeDefined();
    });

    (arm.resumable ? describe : skipSuite)(resumeTitle(arm), () => {
      test("a run waiting on NOTHING is owed a delivery, with no deadline", async () => {
        // A `pending` run whose start was never delivered, or one killed
        // mid-step. Absent `wakeAt` means "now" — `undefined` and not `null`,
        // which is one of the absence drifts this table exists to hammer.
        const journal = resumableOf(arm);
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "pending" }));
        expect(await owed(journal, runId)).toEqual([{ runId }]);
      });

      test("a run suspended on a sleep answers that sleep's deadline", async () => {
        const journal = resumableOf(arm);
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        const at = Date.now() + FAR;
        await journal.claimSleep(runId, "nap#0", at, undefined);
        expect(await owed(journal, runId)).toEqual([{ runId, wakeAt: at }]);
      });

      test("an ELAPSED deadline is still owed — that is the whole point", async () => {
        // The run this method exists for: its deadline passed while no process
        // held a timer for it, and `wakeSleeps` refuses an elapsed wait, so
        // nothing else in the system could reach it.
        const journal = resumableOf(arm);
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        const at = Date.now() - FAR;
        await journal.claimSleep(runId, "nap#0", at, undefined);
        expect(await owed(journal, runId)).toEqual([{ runId, wakeAt: at }]);
      });

      test("the EARLIEST outstanding deadline is the one answered", async () => {
        const journal = resumableOf(arm);
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        const at = Date.now() + FAR;
        await journal.claimSleep(runId, "late#0", at + FAR, undefined);
        await journal.claimSleep(runId, "soon#0", at, undefined);
        expect(await owed(journal, runId)).toEqual([{ runId, wakeAt: at }]);
      });

      test("a WOKEN sleep is not outstanding, so the run is owed one now", async () => {
        const journal = resumableOf(arm);
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.claimSleep(runId, "nap#0", Date.now() + FAR, undefined);
        expect(await journal.wakeSleeps(runId, undefined)).toBe(1);
        expect(await owed(journal, runId)).toEqual([{ runId }]);
      });

      test("a TERMINAL run is owed nothing", async () => {
        const journal = resumableOf(arm);
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.claimSleep(runId, "nap#0", Date.now() - FAR, undefined);
        await journal.setStatus(runId, "completed", { output: 1 });
        expect(await owed(journal, runId)).toEqual([]);
      });

      test("a run parked on an OPEN window with no deadline is excluded", async () => {
        // `await ctx.waitFor(token)` with no `timeoutMs` is the steady state of
        // the approval workflow the SDK documents, and `signal` is what ends it.
        // Re-delivering it costs a replay per parked run per boot and buys
        // nothing — the same park rule `workflow-queue-reconcile.ts` applies.
        const journal = resumableOf(arm);
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.claimHook(runId, "ask#0", token);
        expect(await owed(journal, runId)).toEqual([]);
      });

      test("a parked run WITH a deadline is owed one — the park rule's qualifier", async () => {
        // A `waitFor(token, { timeoutMs })` journals its deadline as a
        // `hookTimeout` sleep. Without this arm the exclusion above would hide
        // such a run forever once its delivery was lost.
        const journal = resumableOf(arm);
        const { runId, token } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "running" }));
        await journal.claimHook(runId, "ask#0", token);
        const at = Date.now() - FAR;
        await journal.claimSleep(runId, "ask!0", at, "review", "hookTimeout");
        expect(await owed(journal, runId)).toEqual([{ runId, wakeAt: at }]);
      });

      test("an ANSWERED window does not park a run, and neither does a closed one", async () => {
        const journal = resumableOf(arm);
        const answered = keysFor(arm);
        const shut = keysFor(arm);
        await journal.createRun(runOf({ runId: answered.runId, status: "running" }));
        await journal.claimHook(answered.runId, "ask#0", answered.token);
        await journal.deliverHook(answered.token, { ok: true });
        await journal.createRun(runOf({ runId: shut.runId, status: "running" }));
        await journal.claimHook(shut.runId, "ask#0", shut.token);
        await journal.closeHook(shut.runId, "ask#0");
        // As a SET: both are due NOW, so the contract's tie-break is the run id,
        // and these two ids differ only in a counter whose ordering is not the
        // claim under test.
        const both = await owed(journal, answered.runId, shut.runId);
        expect(both.map((run) => run.runId).sort(codeUnit)).toEqual(
          [answered.runId, shut.runId].sort(codeUnit),
        );
        expect(both.map((run) => run.wakeAt)).toEqual([undefined, undefined]);
      });

      test("limit BOUNDS the pass, so a boot sweep cannot stampede", async () => {
        const journal = resumableOf(arm);
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId, status: "pending" }));
        expect(await journal.resumableRuns(1)).toHaveLength(1);
        expect(await journal.resumableRuns(0)).toEqual([]);
      });
    });
  });
}
