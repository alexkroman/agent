// Copyright 2026 the AAI authors. MIT license.
/**
 * The eval runner: one case, N times, every assertion RECORDED.
 *
 * ## Recording rather than throwing is the whole design
 *
 * A `expect()` that throws turns a behaviour run into a bisect — the first
 * failing turn ends the case and everything after it is unmeasured. A behaviour
 * eval wants the opposite: run the case to the end, then report which of the
 * eight things the agent was supposed to do it actually did. That is a PROFILE,
 * and it is the difference between "turn 3 failed" and "it called the right
 * tools in the wrong order and never said the confirmation".
 *
 * ## One number is not a result
 *
 * The instrument is noisy in a measured way: identical code has scored 0.56 and
 * 0.60 on the same tau2 tasks with 9 of 25 tasks flipping outcome. So a run
 * reports a SPREAD (`min`/`max`/`mean` over repeats) and, more usefully,
 * {@link EvalReport.unstable} — the assertion labels that were not unanimous
 * across repeats. That list is the instrument measuring itself: an assertion in
 * it cannot adjudicate a change until it is out of it.
 *
 * ## It does not gate, by default
 *
 * {@link runEval} never throws on a failed assertion. `AAI_EVAL_MIN_SCORE`
 * makes the tier assert, and it asserts the spread's LOWER bound (`score.min`),
 * because a mean over a flipping suite is a number that passes on a lucky
 * repeat. Unset — which is how `pnpm check` runs, and how it should stay until
 * the variance work exists — the tier reports and the suite is green. A flaky
 * required check that blocks merges is worse than an unreliable number nobody
 * is forced to believe.
 *
 * @module
 */

import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";

/** One recorded assertion: what was claimed, and whether it held. */
export type EvalCheck = {
  /** What the assertion claims, in the vocabulary's own words. */
  readonly label: string;
  readonly ok: boolean;
  /** What was seen instead. Present on failure; this is the profile's content. */
  readonly detail?: string;
};

/**
 * What a case body records into.
 *
 * `check` is the only primitive, deliberately: the event vocabulary
 * (`assertions.ts`) and the studio's source-grading expectations both go
 * through it, so the two assertion libraries share a runner rather than each
 * carrying a case loop. That sharing is the reason `scripts/starter-eval/`'s
 * 745-line second runner could be deleted.
 */
export type EvalRecorder = {
  check(ok: boolean, label: string, detail?: string): void;
  readonly checks: readonly EvalCheck[];
};

/** One pass of one case. */
export type EvalPass = {
  /** 1-based repeat number. */
  readonly repeat: number;
  readonly ms: number;
  readonly checks: readonly EvalCheck[];
  /** Fraction of this pass's assertions that held; 0 when it recorded none. */
  readonly score: number;
  /**
   * A HARNESS failure — the target never ran, so the pass measured nothing.
   * Kept apart from a failed assertion for the reason the starter eval's
   * failure taxonomy exists: "the agent got it wrong" and "the server was down"
   * want different fixes, and averaging them hides both.
   */
  readonly error?: string;
};

/** min/max/mean over the repeats, plus the width nobody should ignore. */
export type EvalSpread = {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  /** `max - min`. The number that decides whether a delta means anything. */
  readonly spread: number;
};

/** One case's whole result: every pass, the spread, and what flipped. */
export type EvalReport = {
  readonly name: string;
  readonly passes: readonly EvalPass[];
  readonly score: EvalSpread;
  readonly ms: EvalSpread;
  /**
   * Assertion labels that did not hold unanimously across repeats — the
   * suite's own flip list. Sorted, so a report diffs.
   */
  readonly unstable: readonly string[];
  readonly harnessErrors: number;
  /**
   * Passes that actually measured something — `passes.length - harnessErrors`.
   *
   * {@link EvalReport.score} and {@link EvalReport.ms} are over THESE, so a
   * `score` of 0 with `measuredPasses: 0` is "no measurement", not "the agent
   * failed everything". Read it before quoting a number from a run that has any
   * harness errors at all.
   */
  readonly measuredPasses: number;
};

/** What {@link runEval} is given. */
export type EvalSpec = {
  /** Stable across repeats and across runs: it is the key `unstable` reports. */
  readonly name: string;
  /** Repeats. Defaults to `AAI_EVAL_REPEAT`, else 1. */
  readonly repeat?: number;
  /** Drives the target and records assertions. Throwing means HARNESS failure. */
  readonly body: (t: EvalRecorder) => Promise<void>;
};

/**
 * An env var's value, or undefined when it is unset OR blank.
 *
 * Blank counts as unset in both readers below, which matters because
 * `AAI_EVAL_REPEAT= pnpm test:eval` is how a shell unsets one for a single
 * command — and a rule spelled out twice is one that can come to be spelled
 * differently.
 */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/** How many times each case runs, unless the spec says. */
export function evalRepeat(env: Record<string, string | undefined> = process.env): number {
  const raw = envValue(env, "AAI_EVAL_REPEAT");
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`AAI_EVAL_REPEAT must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * The score a case must clear for the tier to FAIL a run, or undefined when the
 * tier only reports. Compared against `score.min`, never the mean.
 */
export function evalMinScore(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = envValue(env, "AAI_EVAL_MIN_SCORE");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`AAI_EVAL_MIN_SCORE must be between 0 and 1, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * A recorder with no run around it — what {@link runEval} hands a case body, and
 * what a test of the assertion vocabulary asserts against.
 *
 * Exported because `assertions.test.ts` needs exactly this and had a byte-for-byte
 * copy of the `check` body: the detail-omission rule below is the shape those
 * tests assert (`{ label, ok }` for a pass, `detail` only on a failure), so a copy
 * lets the suite keep checking a recorder the runner no longer builds.
 */
export function createRecorder(): EvalRecorder & { readonly checks: EvalCheck[] } {
  const checks: EvalCheck[] = [];
  return {
    checks,
    check(ok, label, detail) {
      checks.push(ok || detail === undefined ? { label, ok } : { label, ok, detail });
    },
  };
}

function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function spreadOf(values: readonly number[]): EvalSpread {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, spread: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, mean, spread: max - min };
}

/**
 * Labels that were not unanimous across the passes that recorded them.
 *
 * A label a pass never reached (the run died before that assertion) is NOT
 * counted as a flip: an unreached assertion is missing data, and calling it
 * unstable would make every harness error look like agent nondeterminism.
 */
function unstableLabels(passes: readonly EvalPass[]): string[] {
  const seen = new Map<string, Set<boolean>>();
  for (const pass of passes) {
    for (const check of pass.checks) {
      const outcomes = seen.get(check.label) ?? new Set<boolean>();
      outcomes.add(check.ok);
      seen.set(check.label, outcomes);
    }
  }
  return (
    [...seen]
      .filter(([, outcomes]) => outcomes.size > 1)
      .map(([label]) => label)
      // Code-unit order, never `localeCompare`: with no explicit locale that
      // answers to the runtime's ICU default, so the same run would print a
      // different order on a different machine.
      .sort(byCodeUnit)
  );
}

/**
 * Run one case, `repeat` times, and report.
 *
 * Never throws for a failed assertion. It DOES let a harness failure through as
 * a recorded `error` on that pass rather than as a rejection, so one dead
 * sandbox does not cost the other repeats — that is the same "run every case,
 * report every result" property the assertions have, applied one level up.
 */
export async function runEval(spec: EvalSpec): Promise<EvalReport> {
  const repeat = spec.repeat ?? evalRepeat();
  const passes: EvalPass[] = [];
  for (let i = 0; i < repeat; i++) {
    const recorder = createRecorder();
    const started = Date.now();
    let error: string | undefined;
    try {
      await spec.body(recorder);
    } catch (err) {
      error = errorMessage(err);
    }
    const total = recorder.checks.length;
    const held = recorder.checks.filter((c) => c.ok).length;
    passes.push({
      repeat: i + 1,
      ms: Date.now() - started,
      checks: recorder.checks,
      score: total === 0 ? 0 : held / total,
      ...omitUndefined({ error }),
    });
  }
  // A pass that died is EXCLUDED from the score and the spread, for exactly the
  // reason `EvalPass.error` gives and `unstableLabels` already honoured: a dead
  // sandbox and a wrong tool call want different fixes, and averaging them hides
  // both. Unfiltered, a pass that threw after two passing checks scored 1.0 and
  // set `score.max` — so a harness failure could RAISE the reported number and
  // widen the spread, and `AAI_EVAL_MIN_SCORE` (which asserts `score.min`) would
  // be answering a question about the harness. `harnessErrors` is where that
  // fact belongs, and it is already reported.
  //
  // Every pass failing is not 0% either: it is no measurement. An empty
  // `spreadOf` returns zeros, which would read as a total failure of the agent,
  // so the report carries `measuredPasses: 0` beside it and a reader who
  // consults only the score has `harnessErrors` staring at them.
  const measured = passes.filter((p) => p.error === undefined);
  return {
    name: spec.name,
    passes,
    score: spreadOf(measured.map((p) => p.score)),
    // Timing stays over the measured passes too: a pass that died at its first
    // await is a fast one, and letting it into `ms.min` misreports latency.
    ms: spreadOf(measured.map((p) => p.ms)),
    unstable: unstableLabels(passes),
    harnessErrors: passes.length - measured.length,
    measuredPasses: measured.length,
  };
}
