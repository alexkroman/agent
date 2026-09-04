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

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The default, and it is now MEASURED against a guest rather than inherited.
 *
 * It was three, which was graphile-worker's number on the `DATABASE_URL` path —
 * chosen to restore prior behaviour, explicitly not to be optimal, and never
 * measured against the thing it bounds. What it actually cost is that a body's
 * fan-out was capped at three whatever it asked for: the transcription template
 * opens `mapConcurrent(32)` and got three, so its own measured knee was inert.
 *
 * ## What sixteen is measured against
 *
 * A real libkrun microVM (`msb`), running the template's own `downsampleSegment`
 * and `parseWav` plus this SDK's `encodeWav` and `multipartBody` — every
 * allocation a `transcribeSegment` makes before its request goes out — with the
 * HTTP call replaced by a hold of equal duration. Peak RSS, by width:
 *
 * | width | 16 kHz mono segment | 48 kHz stereo segment |
 * | --- | --- | --- |
 * | 3 | 135 MB | 224 MB |
 * | 8 | 218 MB | 368 MB |
 * | 16 | 344 MB | 576 MB |
 * | 32 | 459 MB | 981 MB |
 * | 64 | 754 MB | 1816 MB |
 *
 * Linear, at **10.1 MB per concurrent segment** for 16 kHz mono and **26.1 MB**
 * for 48 kHz stereo, over a ~105-146 MB base. That decomposes exactly as the code
 * does — for stereo: the window (16.9), the downsampled copy (2.81), `encodeWav`
 * (2.81) and the multipart body (2.81) — which is why it extrapolates.
 *
 * ## Why sixteen and not more
 *
 * **The bound is Modal's RESERVATION, not its cap.** `modal_deploy.py` reserves
 * `SANDBOX_MEMORY_MB` (1024) and caps at `SANDBOX_MEMORY_LIMIT_MB` (4096); only
 * the reservation is guaranteed, so a default that needs the burst is a default
 * that fails under host pressure. Measured in a 1 CPU / 982 MB guest, the worst
 * format survives to 32 (950 MB — 97% of usable, which is luck rather than
 * headroom) and dies at 48. Sixteen sits at 576 MB, 59%, which leaves room for the
 * co-resident voice session `DEFAULT_GUEST_MEMORY_MIB` sizes for.
 *
 * The 48 kHz stereo column is the one that governs, and it is not hypothetical:
 * `transcribeStream` cuts windows out of the recording AS UPLOADED and normalizes
 * each one in process, so its segments really are the heavy ones. Only the classic
 * flow, which converts the whole file first, gets the cheap column.
 *
 * **It is not CPU.** Wall time was flat (4.0-4.6s) from width 3 to 48 on ONE core,
 * so Modal's single-core reservation does not bind this workload; memory does.
 *
 * ## What the old default was really protecting against
 *
 * A guest that died at 32 wide, which this doc used to cite as the reason for
 * three. Reproduced: 32 wide at 48 kHz stereo is 981 MB, fine in a 4 GB guest and
 * fatal in the 480 MiB one microsandbox gives when `SANDBOX_MEMORY_LIMIT_MB` is
 * unset. The fault was an unsized guest, not the width — and the failure is SILENT
 * (the buffers are ArrayBuffers, so V8's heap limit never trips and the kernel
 * OOM-kills the process with no diagnostic at all), which is why it read as a
 * concurrency problem.
 *
 * An operator whose guest is bigger raises it; one whose recordings are heavier
 * than 48 kHz stereo lowers it.
 */
export const DEFAULT_STEP_CONCURRENCY = 16;

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

/**
 * Runs `fn` when a slot is free — or straight away, when the caller already
 * holds one. See {@link createStepGate} for the re-entrancy rule.
 */
export type StepGate = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Build the gate.
 *
 * FIFO, because a body's fan-out is ordered and a reader watching the narration
 * should see segments start roughly in order rather than in whatever order the
 * event loop happened to resume them.
 *
 * ## RE-ENTRANT, because otherwise a nested step deadlocks the process
 *
 * `ctx.step` may be reached from inside a step body — directly, or through any
 * helper that step calls. A plain counting semaphore cannot serve that: the
 * outer step holds its slot for the whole of its attempt loop (deliberately —
 * see the call site in `workflow-replay.ts`), so the inner one queues behind a
 * slot that is only released when the inner one returns. Reproduced at
 * `createStepGate(1)` with a single nested step: it never resolves, with no
 * error and no timeout, and the gate is per ENGINE rather than per run — so at
 * the default width sixteen concurrent nested-outer steps wedge every workflow
 * in the agent.
 *
 * So a caller that ALREADY holds a slot runs on it: nested work is charged to
 * the step that reached it, never queued against it. Membership is decided by
 * async context ({@link AsyncLocalStorage}), which is what "reached from inside
 * this step" means — it follows the awaits, so a helper five frames down is
 * still the same step, and a fresh caller arriving from anywhere else is not.
 *
 * The store belongs to THIS gate, rather than being read off the step context
 * `runStepAttempts` already enters. Two engines in one process (a deployed guest
 * has two copies of this package — see the guide) each have their own gate, and
 * holding one's slot says nothing about the other's; the question this asks is
 * "does this context hold a slot in me", which only a per-gate store answers.
 *
 * **What that costs, stated rather than hidden**: a body's fan-out reached from
 * inside a step is UNBOUNDED by this gate — the bound applies to the outermost
 * steps. That is the honest reading of the trade, since the alternative is a
 * deadlock, and it leaves the measured case intact: a workflow body fans out at
 * the TOP level ({@link DEFAULT_STEP_CONCURRENCY}'s own measurement is
 * `mapConcurrent(32)` in a body), where every step is a fresh caller and every
 * one of them queues.
 *
 * @internal
 */
export function createStepGate(limit: number): StepGate {
  /**
   * The FIFO queue of waiters, as an array plus a head CURSOR.
   *
   * `waiting.shift()` is what this replaced, and it is O(n): every release
   * memmoves the whole queue down one. A fan-out is exactly the shape that
   * makes that quadratic — a body opening W steps against a gate of `limit`
   * queues W - limit of them, and each of the W releases pays a memmove
   * proportional to what is still queued.
   *
   * Measured, in milliseconds to queue and drain W waiters (Node 26, this
   * bookkeeping alone, no engine around it):
   *
   * | waiters | `shift` | cursor |
   * | --- | --- | --- |
   * | 32 | 0.004 | 0.006 |
   * | 128 | 0.008 | 0.005 |
   * | 512 | 0.027 | 0.008 |
   * | 2048 | 0.114 | 0.030 |
   * | 8192 | 0.463 | 0.098 |
   * | 32768 | 85.3 | 1.5 |
   *
   * So the trade is microseconds at a width nobody notices against the shape of
   * the curve past it — V8 has a fast path for `shift` that holds up to a few
   * thousand and then stops, which is precisely the regime a body that fans out
   * over a long recording is in. A cursor removes the growth without changing
   * the ORDER, which the FIFO note above requires.
   */
  const waiting: (() => void)[] = [];
  let head = 0;
  let active = 0;
  /** Set for the duration of a slot-holder's body — see the re-entrancy rule. */
  const holding = new AsyncLocalStorage<true>();

  /** Take the next waiter off the queue, or `undefined` when there is none. */
  function shiftWaiter(): (() => void) | undefined {
    const next = head < waiting.length ? waiting[head] : undefined;
    if (next !== undefined) head++;
    // The dead prefix is dropped once it is at least half the array, which is
    // what makes both bounds hold at once: the splice is O(remaining) but pays
    // for at least as many removals as it moves survivors, so it is amortized
    // O(1) per waiter, and nothing dequeued is retained past the next drop.
    if (head > 0 && head * 2 >= waiting.length) {
      waiting.splice(0, head);
      head = 0;
    }
    return next;
  }

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
    const next = shiftWaiter();
    if (next) next();
    else active--;
  }

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Already inside a slot of this gate: run on it. Before the counter is
    // touched at all, so a nested call neither takes a slot nor releases one.
    if (holding.getStore()) return fn();
    // A woken waiter already HOLDS the slot (see `release`), so it must not
    // increment; only a caller that never queued does.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await holding.run(true, fn);
    } finally {
      release();
    }
  };
}
