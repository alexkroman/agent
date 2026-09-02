// Copyright 2026 the AAI authors. MIT license.
/**
 * The two things every generated-program harness does identically.
 *
 * Three harnesses drive a `Program` (`_workflow-resume-program.ts`) through an
 * engine and then compare what the journal holds against what the program says
 * should have happened. Each is a DIFFERENT experiment — resume across crashes
 * and cancels, rebuild across fresh engines, two runs sharing one engine — and
 * each one's `Recorder.after` is where that difference lives. What is not
 * different is the tally the recorder keeps and the six fields the verdict is
 * read out of, both of which were written out per harness.
 *
 * Sharing them is not only line count. A harness whose counter and whose journal
 * read are its own can disagree with a sibling about what `total` counts or how
 * `keys` is ordered, and the failure that produces is an ORACLE reporting a
 * divergence between two experiments that ran the same program correctly — the
 * one failure mode a differential harness must not have.
 */

import type { Recorder } from "./_workflow-resume-program.ts";
import type { JournalStore, RunStatus } from "./workflow-journal-types.ts";

/**
 * Code-unit order, never `localeCompare`: with no explicit locale that answers
 * to the runtime's ICU default, so the same journal would sort two ways on two
 * machines and the oracle would report a divergence that is really a locale.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The invocation bookkeeping a {@link Recorder} keeps, minus its `after` hook. */
export type Tally = {
  /**
   * The two `Recorder` members this owns, to spread beside the harness's own
   * `after`. A nested object rather than the two methods on `Tally` itself,
   * because `total` below is a GETTER: `{ ...tally, after }` would evaluate it
   * once at spread time and leave a frozen `0` on the recorder.
   */
  readonly counted: Pick<Recorder, "count" | "runs">;
  /** Counted invocations across every step name. */
  readonly total: number;
  /** Step NAME to how many times its body really ran. */
  snapshot(): Record<string, number>;
};

/**
 * A fresh tally.
 *
 * `total` is a getter rather than a value because every caller reads it AFTER
 * the run — and two of them also read it DURING one, as the driver's "did this
 * delivery make progress" signal.
 */
export function createTally(): Tally {
  const counts = new Map<string, number>();
  let started = 0;
  return {
    counted: {
      count(name) {
        started++;
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return started;
      },
      runs(name) {
        return counts.get(name) ?? 0;
      },
    },
    get total() {
      return started;
    },
    snapshot: () => Object.fromEntries(counts),
  };
}

/** What the journal says happened, in the shape every harness's verdict starts with. */
export type JournalOutcome = {
  status: RunStatus | undefined;
  output: unknown;
  error: string | undefined;
  /** Journal keys, as a sorted list so two runs compare as sets. */
  keys: string[];
  counts: Record<string, number>;
  total: number;
};

/** Read one run's verdict off the journal, paired with the tally that drove it. */
export async function journalOutcome(
  journal: JournalStore,
  runId: string,
  tally: Tally,
): Promise<JournalOutcome> {
  const record = await journal.getRun(runId);
  return {
    status: record?.status,
    output: record?.output,
    error: record?.error?.message,
    keys: (await journal.readSteps(runId)).map((entry) => entry.key).sort(byCodeUnit),
    counts: tally.snapshot(),
    total: tally.total,
  };
}
