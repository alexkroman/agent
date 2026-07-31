// Copyright 2026 the AAI authors. MIT license.
/**
 * Runs the coding agent's CPU-bearing workspace computations — grep's regex
 * scan and edit_file's matching + diff — on a dedicated worker thread with a
 * hard terminate deadline, never on the server's main thread.
 *
 * Why: both take model-controlled input into superlinear algorithms. A
 * catastrophic regex (`(a+)+$`) goes exponential at a few dozen characters,
 * and a large mostly-different edit pushes Myers diff into seconds — and
 * the per-tool `pTimeout` cannot stop either, because a promise race needs
 * the event loop the computation is pinning. One hostile (or unlucky) tool
 * call would stall every session on the process. Off-thread, the main loop
 * never blocks, and `worker.terminate()` is a real bound: V8 kills the
 * thread mid-backtrack.
 *
 * Shape: one lazy singleton worker per process, jobs multiplexed by id
 * (`studio-scan-worker.ts` is the thread side). On a deadline or worker
 * failure the worker is terminated and the singleton reset — pending jobs
 * fail with a retryable message, the offending job with a classified error,
 * and the next call spawns a fresh worker. Job payloads are structured
 * clones (a maximal workspace is ~2ms of copy — linear, unlike the work
 * being isolated). Failures come back as classified wire data
 * (`kind: grep | edit | internal`) and are rethrown as the same typed
 * errors the sync implementations throw — call sites never know the work
 * ran on another thread.
 */

import { Worker } from "node:worker_threads";
import { errorMessage } from "@alexkroman1/aai";
import type { EditResult } from "./studio-edit.ts";
import { StudioEditError } from "./studio-edit.ts";
import type { GrepOptions } from "./studio-grep.ts";
import { StudioGrepError } from "./studio-grep.ts";
import type { ScanJob, ScanResponse } from "./studio-scan-worker.ts";

/**
 * Hard per-job deadline. Generous: a benign grep over a maximal workspace
 * measures low tens of ms, and edit_file's diff self-elides at 500ms
 * (`DIFF_BUDGET_MS`) — only runaway backtracking or a pathological fuzzy
 * replaceAll gets near this, and killing those is the point.
 */
export const SCAN_JOB_TIMEOUT_MS = 2000;

/**
 * Locate the worker entry. From source (dev, tests — this module's URL ends
 * in `.ts`) the entry is the sibling `.ts` module, which bare node loads via
 * type stripping — native on the supported node versions, behind the flag on
 * older ones (`process.features.typescript` is false there). Built, this
 * module is bundled into `dist/index.mjs` while the entry is its own tsdown
 * artifact alongside it.
 */
function workerSpec(): { url: URL; execArgv: string[] } {
  if (import.meta.url.endsWith(".ts")) {
    return {
      url: new URL("./studio-scan-worker.ts", import.meta.url),
      execArgv: process.features.typescript ? [] : ["--experimental-strip-types"],
    };
  }
  return { url: new URL("./studio-scan-worker.mjs", import.meta.url), execArgv: [] };
}

type Pending = {
  kind: ScanJob["kind"];
  resolve: (result: string | EditResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 0;

function rehydrate(kind: "grep" | "edit" | "internal", message: string): Error {
  if (kind === "grep") return new StudioGrepError(message);
  if (kind === "edit") return new StudioEditError(message);
  return new Error(`Scan worker failed: ${message}`);
}

function deadlineError(kind: ScanJob["kind"]): Error {
  const seconds = SCAN_JOB_TIMEOUT_MS / 1000;
  if (kind === "grep") {
    return new StudioGrepError(
      `Search timed out after ${seconds}s — the pattern is too expensive ` +
        "(likely catastrophic backtracking). Simplify it, or pass literal: true.",
    );
  }
  return new StudioEditError(
    `The edit took over ${seconds}s to compute and was abandoned; no change was applied. ` +
      "Try a smaller oldText, or write_file for a full rewrite.",
  );
}

/** Fail every in-flight job and drop the worker; the next job respawns it. */
function resetWorker(reason: Error): void {
  const w = worker;
  worker = null;
  const failed = [...pending.values()];
  pending.clear();
  for (const job of failed) {
    clearTimeout(job.timer);
    job.reject(new Error(`${reason.message} — retry the tool call`, { cause: reason }));
  }
  void w?.terminate();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const spec = workerSpec();
  const w = new Worker(spec.url, { execArgv: spec.execArgv });
  // The worker must not hold an otherwise-finished process open (tests,
  // graceful shutdown). An unref'd worker still serves jobs normally.
  w.unref();
  w.on("message", (msg: ScanResponse) => {
    const job = pending.get(msg.id);
    if (!job) return; // already timed out and rejected
    pending.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.ok) job.resolve(msg.result);
    else job.reject(rehydrate(msg.kind, msg.message));
  });
  w.on("error", (err) => {
    if (worker === w) resetWorker(new Error(`Scan worker crashed: ${errorMessage(err)}`));
  });
  w.on("exit", (code) => {
    if (worker === w) resetWorker(new Error(`Scan worker exited with code ${code}`));
  });
  worker = w;
  return w;
}

function postJob(job: ScanJob): Promise<string | EditResult> {
  const w = ensureWorker();
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // The offending job gets the classified deadline error; the terminate
      // (via reset) frees the thread and fails any other queued jobs as
      // retryable. Distinguishing the two matters: only the job that hit
      // the deadline should read as "your input was too expensive".
      pending.delete(id);
      reject(deadlineError(job.kind));
      resetWorker(new Error(`Scan worker terminated: a ${job.kind} job exceeded its deadline`));
    }, SCAN_JOB_TIMEOUT_MS);
    // Unref'd like the worker itself: a pending deadline must not hold the
    // process open either.
    timer.unref();
    pending.set(id, { kind: job.kind, resolve, reject, timer });
    w.postMessage({ id, job });
  });
}

/** `grepWorkspace`, executed on the scan worker. */
export function grepWorkspaceInWorker(
  files: Record<string, string>,
  pattern: string,
  opts: GrepOptions = {},
): Promise<string> {
  return postJob({ kind: "grep", files, pattern, opts }) as Promise<string>;
}

/** `applyEdit`, executed on the scan worker. */
export function applyEditInWorker(
  path: string,
  content: string,
  oldText: string,
  newText: string,
  opts: { replaceAll?: boolean | undefined } = {},
): Promise<EditResult> {
  return postJob({
    kind: "edit",
    path,
    content,
    oldText,
    newText,
    replaceAll: opts.replaceAll,
  }) as Promise<EditResult>;
}

/** Test-only: tear down the singleton so suites end with no live thread. */
export async function _shutdownScanWorker(): Promise<void> {
  const w = worker;
  worker = null;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(new Error("Scan worker shut down"));
  }
  pending.clear();
  await w?.terminate();
}
