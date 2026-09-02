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
 * @internal
 */

import { describe, expect, test } from "vitest";
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
 * This arm's journal, when it declares the capability.
 *
 * Probed in a test BODY and never in a `describe.skipIf`: the Postgres arm builds
 * its store in `beforeAll`, so `arm.journal()` answers `undefined` at collection
 * time. The absence is legitimate — `workflow-journal-platform.ts` omits the
 * method because a deployed guest's recovery is the platform queue's reconcile —
 * so a case that cannot run returns rather than failing, and WHICH backend
 * declares it is pinned per backend in
 * `workflow-journal-{memory,postgres,platform}.test.ts`. Those three pins are
 * what stop a backend silently losing the method and passing this whole table
 * through the empty branch.
 */
function resumableOf(arm: JournalArm): ResumableJournal | undefined {
  const journal = arm.journal();
  return isResumableJournal(journal) ? journal : undefined;
}

/**
 * Code-unit order, and never `localeCompare`, for the reason `newestFirst` in the
 * memory journal gives: with no explicit locale that answers to the runtime's ICU
 * default, so two ids would order differently on two machines.
 */
function codeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
 * The boot-sweep half of the contract.
 *
 * @internal
 */
export function journalResumeConformance(arm: JournalArm): void {
  describe(`journal conformance (resume): ${arm.label}`, () => {
    test("a run waiting on NOTHING is owed a delivery, with no deadline", async () => {
      // A `pending` run whose start was never delivered, or one killed
      // mid-step. Absent `wakeAt` means "now" — `undefined` and not `null`,
      // which is one of the absence drifts this table exists to hammer.
      const journal = resumableOf(arm);
      if (!journal) return;
      const { runId } = keysFor(arm);
      await journal.createRun(runOf({ runId, status: "pending" }));
      expect(await owed(journal, runId)).toEqual([{ runId }]);
    });

    test("a run suspended on a sleep answers that sleep's deadline", async () => {
      const journal = resumableOf(arm);
      if (!journal) return;
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
      if (!journal) return;
      const { runId } = keysFor(arm);
      await journal.createRun(runOf({ runId, status: "running" }));
      const at = Date.now() - FAR;
      await journal.claimSleep(runId, "nap#0", at, undefined);
      expect(await owed(journal, runId)).toEqual([{ runId, wakeAt: at }]);
    });

    test("the EARLIEST outstanding deadline is the one answered", async () => {
      const journal = resumableOf(arm);
      if (!journal) return;
      const { runId } = keysFor(arm);
      await journal.createRun(runOf({ runId, status: "running" }));
      const at = Date.now() + FAR;
      await journal.claimSleep(runId, "late#0", at + FAR, undefined);
      await journal.claimSleep(runId, "soon#0", at, undefined);
      expect(await owed(journal, runId)).toEqual([{ runId, wakeAt: at }]);
    });

    test("a WOKEN sleep is not outstanding, so the run is owed one now", async () => {
      const journal = resumableOf(arm);
      if (!journal) return;
      const { runId } = keysFor(arm);
      await journal.createRun(runOf({ runId, status: "running" }));
      await journal.claimSleep(runId, "nap#0", Date.now() + FAR, undefined);
      expect(await journal.wakeSleeps(runId, undefined)).toBe(1);
      expect(await owed(journal, runId)).toEqual([{ runId }]);
    });

    test("a TERMINAL run is owed nothing", async () => {
      const journal = resumableOf(arm);
      if (!journal) return;
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
      if (!journal) return;
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
      if (!journal) return;
      const { runId, token } = keysFor(arm);
      await journal.createRun(runOf({ runId, status: "running" }));
      await journal.claimHook(runId, "ask#0", token);
      const at = Date.now() - FAR;
      await journal.claimSleep(runId, "ask!0", at, "review", "hookTimeout");
      expect(await owed(journal, runId)).toEqual([{ runId, wakeAt: at }]);
    });

    test("an ANSWERED window does not park a run, and neither does a closed one", async () => {
      const journal = resumableOf(arm);
      if (!journal) return;
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
      if (!journal) return;
      const { runId } = keysFor(arm);
      await journal.createRun(runOf({ runId, status: "pending" }));
      expect(await journal.resumableRuns(1)).toHaveLength(1);
      expect(await journal.resumableRuns(0)).toEqual([]);
    });
  });
}
