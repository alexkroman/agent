// Copyright 2026 the AAI authors. MIT license.
/**
 * How many step bodies may EXECUTE at once in this process.
 *
 * ## The bound the world used to provide, and its absence killed a guest
 *
 * A body's fan-out width and its execution concurrency were two different
 * numbers under the Workflow DevKit, and only one of them was the author's.
 * `mapConcurrent(32)` bounded how many step CALLS the body had in flight; each
 * call became a queued job, and how many RAN at once was the world's worker
 * concurrency — three, on the `DATABASE_URL` path. The transcription template
 * says so in its own doc: "what EXECUTES at this width is the world's call, not
 * this number's".
 *
 * The replay engine runs a step INLINE during the walk, so those two numbers
 * collapsed into one and nothing was left holding the second. A 50-minute
 * recording planned 34 segments, the body opened 32 of them at once against a
 * 640 MB in-flight budget, and the microVM died about five seconds later —
 * before any segment settled, so nothing journaled and every redelivery redid
 * the same 32. Observed as four boots in thirty seconds, each transcribing the
 * identical set, with the queue's backoff ladder the only thing slowing it.
 *
 * ## Why a PROCESS bound rather than a per-run one
 *
 * What ran out was memory, and memory belongs to the container. A per-run bound
 * would hold for one run and let two concurrent runs of the same agent overrun
 * together — which a deployed guest does routinely, since one sandbox serves
 * every run of its slug.
 *
 * ## Why it QUEUES rather than sheds
 *
 * `aai-server/_semaphore.ts` is the other counting semaphore in this repo and it
 * waits with a deadline so a request path can answer 503. That is exactly wrong
 * here: a step that could not acquire is not a step to fail, it is a step to run
 * a moment later, and failing it would burn an attempt off a ceiling that exists
 * for provider faults.
 *
 * @internal
 */

/**
 * The default, and it is chosen to RESTORE prior behaviour rather than to be
 * optimal.
 *
 * Three is what graphile-worker ran on the `DATABASE_URL` path, so an agent that
 * worked before this engine works the same after it. It is deliberately not the
 * transcription template's measured knee of 32: that number is the ENDPOINT's,
 * measured against the transcription API with one concurrency per run, and it
 * says nothing about how much audio a 1-CPU sandbox can hold. An operator who
 * has sized their guest for more raises it.
 */
export const DEFAULT_STEP_CONCURRENCY = 3;

/** Where an operator raises it. */
export const STEP_CONCURRENCY_ENV = "AAI_WORKFLOW_STEP_CONCURRENCY";

/**
 * Read the bound from the environment, falling back to the default.
 *
 * A value that is not a positive integer is IGNORED rather than refused: this is
 * read at engine construction, on a path with no good way to fail, and a typo'd
 * knob should not stop an agent booting. It is reported in the boot line either
 * way, which is where a wrong value becomes visible.
 *
 * @internal
 */
export function resolveStepConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[STEP_CONCURRENCY_ENV]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_STEP_CONCURRENCY;
}

/** Runs `fn` when a slot is free. */
export type StepGate = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Build the gate.
 *
 * FIFO, because a body's fan-out is ordered and a reader watching the narration
 * should see segments start roughly in order rather than in whatever order the
 * event loop happened to resume them.
 *
 * @internal
 */
export function createStepGate(limit: number): StepGate {
  const waiting: (() => void)[] = [];
  let active = 0;

  /**
   * The slot is TRANSFERRED to the next waiter, never freed and re-acquired.
   *
   * Decrementing and letting the woken waiter increment looks equivalent and is
   * not: between the two, a caller arriving fresh sees `active < limit`, takes
   * the slot without queueing, and then the waiter increments too — so the gate
   * admits `limit + 1`. Once per release, under a fan-out, that is unbounded
   * drift. `active` only falls when nobody is waiting.
   */
  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A woken waiter already HOLDS the slot (see `release`), so it must not
    // increment; only a caller that never queued does.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
