// Copyright 2026 the AAI authors. MIT license.
/**
 * Run a string of CommonJS in a worker thread, and TERMINATE it at a deadline.
 *
 * The one way in Node to bound code that may never yield. A timer on the
 * thread running a `while (true) {}` or a catastrophically backtracking regex
 * can never fire, so a promise race "times out" while the work runs on and
 * wedges the process — every HTTP route, session and heartbeat behind it.
 * `terminate()` tears the isolate down whether or not it ever yields.
 *
 * Two callers, which is why it is one function: the guest's `run_code`
 * executor (`aai-guest-core/trial.ts`) and the coding tools' bounded `grep`
 * (`coding-grep.ts`). The body is a STRING evaluated with `eval: true` rather
 * than a sibling file because the guest harness ships as one bundled artifact
 * with no second file to start a worker from; whatever the body works on
 * travels as `workerData`, never spliced into the source. The body answers by
 * posting exactly one message.
 *
 * @internal Not part of the published API surface.
 */

// The ban's stated reason ("not available in Firecracker guest VMs") does not
// describe where this runs: both callers run in a container, and the guest has
// run `run_code` in a worker thread on every call for as long as that executor
// has existed. Same line-scoped suppression and argument as `coding-spawn.ts`'s
// `child_process` import.
// biome-ignore lint/style/noRestrictedImports: see above.
import { Worker } from "node:worker_threads";
import pTimeout from "p-timeout";

/** Options for {@link runEvalWorker}. */
export type EvalWorkerOptions = {
  /** Wall-clock deadline; the worker is terminated when it passes. */
  timeoutMs: number;
  /** Names the work in the error for a worker that died without answering. */
  label: string;
  /** What the deadline rejects with — a message, or the error itself. */
  timeoutMessage: string | Error;
};

/**
 * Start `source` in a fresh worker with `workerData`, and resolve with the
 * first message it posts.
 *
 * Rejects when the deadline passes, when the body throws uncaught, and when
 * the worker exits without answering (the code called `process.exit`, or an
 * OOM took the isolate). The worker is terminated on EVERY path — on the
 * timeout path that is the whole point, and on the others it reclaims an
 * isolate the body left work pending in (a dangling `setInterval`).
 */
export async function runEvalWorker<T>(
  source: string,
  workerData: unknown,
  options: EvalWorkerOptions,
): Promise<T> {
  const worker = new Worker(source, { eval: true, workerData });
  const settled = new Promise<T>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    // A late `reject` after a `resolve` is a no-op, so the ordinary exit
    // following an answer needs no guard.
    worker.once("exit", (exitCode) => {
      reject(new Error(`${options.label} ended without a result (worker exit ${exitCode})`));
    });
  });
  try {
    return await pTimeout(settled, {
      milliseconds: options.timeoutMs,
      message: options.timeoutMessage,
    });
  } finally {
    void worker.terminate();
  }
}
