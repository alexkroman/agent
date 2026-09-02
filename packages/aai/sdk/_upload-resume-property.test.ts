// Copyright 2026 the AAI authors. MIT license.
/**
 * `withResumes` as a machine walk: how many rounds, carrying what, waiting how long.
 *
 * `_upload-resume.test.ts` beside this pins the CLASSIFICATION — which statuses
 * are an outage and which are an answer — one case per entry, which is the right
 * shape for a table of decisions. What a case list cannot state is the thing the
 * loop is: a counter over a SEQUENCE of answers, where the sequence is what
 * decides how many times somebody's 600 MB recording is re-entered.
 *
 * ## The oracle
 *
 * A model written from the module's own prose rather than from its loop —
 * "rounds in total, the first included", "the caller's own value on the first
 * round and `true` on every round after it", "throws the LAST failure", "an
 * abort ends the loop rather than being waited out". It walks the same generated
 * script and predicts three things independently: the exact list of
 * `ResumeRound`s handed to `attempt`, whether the call resolves or rejects, and
 * which error it rejects with.
 *
 * The FOURTH prediction is the backoff, and it is why `Math.random` is stubbed
 * from the generated world rather than merely silenced. `resumeDelay` doubles a
 * window and jitters over its lower half, so with the draws generated the whole
 * schedule is a function of the script and can be asserted to the millisecond —
 * including that the window CLAMPS at {@link UPLOAD_RESUME_MAX_MS}, which the
 * default four-round budget never reaches. A property whose runs are not
 * independently replayable converges the shrinker on the wrong counterexample,
 * so every per-run stub and every pending timer is torn down in a `finally`.
 *
 * Virtual time throughout, per the root guide: the real schedule is ~30 seconds
 * of waiting, and a spec that sits through it is a spec that flakes on a busy
 * runner while measuring nothing about the delay. The clock is read through
 * `Date.now()`, which vitest's fake timers move along with the timers, so the
 * gap between two `attempt` calls IS the delay that was taken.
 */

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ResumeRound, withResumes } from "./_upload-resume.ts";
import { UPLOAD_RESUME_BASE_MS, UPLOAD_RESUME_MAX_MS } from "./upload-constants.ts";
import { UploadNotRecordedError } from "./workflow-upload-parts.ts";

/**
 * What one round's request is answered with.
 *
 * `abortSignal` is the PAUSE, and it is a separate kind rather than a variant of
 * `abort`: the failure it produces looks like an outage (a dropped connection
 * with no status), and what ends the loop is the signal beside it. A model that
 * only read the error would keep going.
 */
type Outcome = "ok" | "drop" | "retryable" | "refused" | "unrecorded" | "abort" | "abortSignal";

const OUTCOMES: readonly Outcome[] = [
  "ok",
  "drop",
  "retryable",
  "refused",
  "unrecorded",
  "abort",
  "abortSignal",
];

/** Whether a failure of this kind is one the loop comes back from. */
function resumable(outcome: Outcome): boolean {
  return outcome === "drop" || outcome === "retryable" || outcome === "abortSignal";
}

/** The failure a round of this kind throws — the shapes the real callers produce. */
function failureFor(outcome: Outcome, round: number): Error {
  if (outcome === "retryable") {
    return Object.assign(new Error(`the agent said 503 on round ${round}`), { status: 503 });
  }
  if (outcome === "refused") {
    return Object.assign(new Error(`the agent said 413 on round ${round}`), { status: 413 });
  }
  if (outcome === "unrecorded")
    return new UploadNotRecordedError(`nothing recorded, round ${round}`);
  if (outcome === "abort") {
    return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  }
  return new TypeError(`fetch failed on round ${round}`);
}

/** The window round `n` jitters inside — the documented doubling, capped. */
function backoffWindow(round: number): number {
  return Math.min(UPLOAD_RESUME_BASE_MS * 2 ** (round - 1), UPLOAD_RESUME_MAX_MS);
}

/**
 * What the module's PROSE says should happen, computed without running it.
 *
 * Deliberately a forward walk over the script rather than a rearrangement of
 * the loop's own exit condition: the claim being checked is "how many rounds,
 * and what did each carry", which is a fact about the sequence of answers.
 */
function predict(
  script: readonly Outcome[],
  attempts: number,
  callerResume: boolean | undefined,
): { rounds: ResumeRound[]; settles: "resolved" | "rejected"; endedBy: Outcome } {
  const rounds: ResumeRound[] = [];
  let signalAborted = false;
  for (let round = 1; round <= attempts; round += 1) {
    const outcome = script[(round - 1) % script.length] ?? "drop";
    rounds.push({ resume: round === 1 ? callerResume : true, round });
    if (outcome === "ok") return { rounds, settles: "resolved", endedBy: outcome };
    if (outcome === "abortSignal") signalAborted = true;
    const lastRound = round === attempts;
    if (lastRound || signalAborted || !resumable(outcome)) {
      return { rounds, settles: "rejected", endedBy: outcome };
    }
  }
  // Unreachable: `attempts` is at least one, so the loop always returns from
  // inside it. Stated as a throw rather than a fallback value, because a
  // fallback here would be a second, silent model of the loop's exit.
  throw new Error("unreachable: a budget of at least one round always settles");
}

/** Longer than the whole real schedule, so a run never settles by under-advancing. */
const DRIVE_MS = 5 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withResumes", () => {
  test("the round count, what each round carries, and which failure escapes", async () => {
    const reached = { resolved: 0, budgetSpent: 0, refusedEarly: 0, abortedBySignal: 0 };

    await fc.assert(
      fc.asyncProperty(
        // A SHORT script consumed cyclically — the number of rounds is decided
        // by the loop, not by the generator, so a per-round list would generate
        // entries no run reads and shrink to nothing readable.
        fc.array(fc.constantFrom(...OUTCOMES), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom<boolean | undefined>(undefined, true, false),
        async (script, attempts, callerResume) => {
          const expected = predict(script, attempts, callerResume);
          const controller = new AbortController();
          const seen: ResumeRound[] = [];
          const thrown: Error[] = [];

          try {
            const attempt = async (round: ResumeRound): Promise<string> => {
              seen.push({ ...round });
              const outcome = script[(round.round - 1) % script.length] ?? "drop";
              if (outcome === "ok") return "stored";
              if (outcome === "abortSignal") controller.abort();
              const failure = failureFor(outcome, round.round);
              thrown.push(failure);
              throw failure;
            };

            const pending = withResumes(attempt, {
              resume: callerResume,
              attempts,
              signal: controller.signal,
            });
            const drive = vi.advanceTimersByTimeAsync(DRIVE_MS);
            const settled = await pending.then(
              (value) => ({ ok: true as const, value }),
              (err: unknown) => ({ ok: false as const, err }),
            );
            await drive;

            // 1. Exactly the rounds the prose predicts, in order, each carrying
            //    the `resume` the module documents for its position.
            expect(seen).toEqual(expected.rounds);

            // 2. Resolved with the value, or rejected with the LAST failure —
            //    the state the caller is actually in, not the one a minute ago.
            if (expected.settles === "resolved") {
              expect(settled).toEqual({ ok: true, value: "stored" });
              reached.resolved += 1;
            } else {
              expect(settled.ok).toBe(false);
              expect(settled.ok === false && settled.err).toBe(thrown.at(-1));
            }

            if (expected.settles === "rejected") {
              if (expected.endedBy === "abortSignal") reached.abortedBySignal += 1;
              else if (seen.length === attempts) reached.budgetSpent += 1;
              else reached.refusedEarly += 1;
            }
          } finally {
            // Per-run teardown: a leaked timer converges the shrinker on the
            // wrong counterexample, and shrinking re-runs this dozens of times.
            vi.clearAllTimers();
          }
        },
      ),
      { numRuns: 200 },
    );

    // Floors under the OBSERVED MINIMUM over 20 calibration runs, range in each
    // trailing comment. Four exits, and each is a different decision about
    // somebody's recording: it landed, the server never came back, the agent
    // said no, or a person pressed pause.
    expect(reached.resolved, "no script ever succeeded").toBeGreaterThan(15); // 29-46
    expect(reached.budgetSpent, "no script ever spent the whole budget").toBeGreaterThan(15); // 31-68
    expect(reached.refusedEarly, "no script was ever refused early").toBeGreaterThan(45); // 70-89
    expect(reached.abortedBySignal, "no script was ever stopped by the signal").toBeGreaterThan(12); // 24-40
  });

  test("the backoff doubles, jitters over the lower half, and CLAMPS", async () => {
    const reached = { waits: 0, clamped: 0 };
    const draws = { list: [0.5] as readonly number[], next: 0 };
    vi.spyOn(Math, "random").mockImplementation(() => {
      const value = draws.list[draws.next % draws.list.length] ?? 0;
      draws.next += 1;
      return value;
    });

    await fc.assert(
      fc.asyncProperty(
        // The jitter draws are part of the generated world, cycled — which is
        // what makes the whole schedule a function of the value and the run
        // replayable to the millisecond.
        //
        // The pool is fifths rather than an arbitrary `fc.double`, and the
        // reason is the TIMER rather than the code: every window here is a
        // multiple of five, so a fifth produces a whole number of
        // milliseconds, where a draw of `0.999` against the clamped 15000 ms
        // window asks for 14992.5 and the clock advances 14992. Harmless in a
        // backoff, and the difference between a millisecond-exact claim and one
        // hedged by a tolerance.
        fc.array(fc.constantFrom(0, 0.2, 0.4, 0.6, 0.8), { minLength: 1, maxLength: 4 }),
        // Five rounds, so the fifth window is the one the cap bites on: the
        // default budget of four never reaches it.
        fc.integer({ min: 2, max: 6 }),
        async (jitter, attempts) => {
          draws.list = jitter;
          draws.next = 0;
          const at: number[] = [];

          try {
            const attempt = async (round: ResumeRound): Promise<never> => {
              at.push(Date.now());
              throw new TypeError(`fetch failed on round ${round.round}`);
            };
            const pending = withResumes(attempt, { resume: undefined, attempts });
            const drive = vi.advanceTimersByTimeAsync(DRIVE_MS);
            await expect(pending).rejects.toThrow(`round ${attempts}`);
            await drive;

            expect(at.length).toBe(attempts);
            for (let round = 1; round < attempts; round += 1) {
              const window = backoffWindow(round);
              const drawn = jitter[(round - 1) % jitter.length] ?? 0;
              // Read off the clock rather than off a spy on `setTimeout`: the
              // gap between two attempts IS the wait that was taken.
              expect((at[round] ?? 0) - (at[round - 1] ?? 0)).toBe(
                window / 2 + drawn * (window / 2),
              );
              reached.waits += 1;
              if (window === UPLOAD_RESUME_MAX_MS) reached.clamped += 1;
            }
          } finally {
            vi.clearAllTimers();
          }
        },
      ),
      { numRuns: 120 },
    );

    // 20 calibration runs. `clamped` is the one that matters: the shipped budget
    // of four rounds stops one window short of the cap, so nothing else in the
    // tree exercises it at all.
    expect(reached.waits, "no round ever waited").toBeGreaterThan(220); // 324-372
    expect(reached.clamped, "the backoff never reached its ceiling").toBeGreaterThan(25); // 47-71
  });
});
