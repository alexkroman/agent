// Copyright 2026 the AAI authors. MIT license.
/**
 * The scan worker's thread entry — the other half of `studio-scan-runner.ts`.
 *
 * Runs the coding agent's CPU-bearing workspace computations (the grep scan,
 * edit matching + diff) off the server's main thread. Loaded by a bare
 * `node` worker: from `.ts` source under node's type stripping in dev, from
 * the tsdown-built `dist/studio-scan-worker.mjs` in production — so keep the
 * import graph to picomatch/diff and dependency-free local modules (see
 * `studio-limits.ts`), and keep this file free of anything that assumes the
 * server process around it.
 *
 * Protocol: the runner posts `{ id, job }`; the worker answers
 * `{ id, ok: true, result }` or `{ id, ok: false, kind, message }`, with
 * `kind` classifying the failure the way `studio-build-protocol.ts` does —
 * errors cross the thread boundary as data and the runner rehydrates the
 * typed errors, since an Error instance loses its subclass in the
 * structured clone. The worker never self-limits runtime: the runner's
 * `worker.terminate()` deadline is the CPU bound, which is the whole reason
 * this thread exists.
 */

import { parentPort } from "node:worker_threads";
import { applyEdit, type EditResult, StudioEditError } from "./studio-edit.ts";
import { type GrepOptions, grepWorkspace, StudioGrepError } from "./studio-grep.ts";

export type ScanJob =
  | { kind: "grep"; files: Record<string, string>; pattern: string; opts: GrepOptions }
  | {
      kind: "edit";
      path: string;
      content: string;
      oldText: string;
      newText: string;
      replaceAll: boolean | undefined;
    };

export type ScanResponse =
  | { id: number; ok: true; result: string | EditResult }
  | { id: number; ok: false; kind: "grep" | "edit" | "internal"; message: string };

function runJob(job: ScanJob): string | EditResult {
  if (job.kind === "grep") return grepWorkspace(job.files, job.pattern, job.opts);
  return applyEdit(job.path, job.content, job.oldText, job.newText, {
    replaceAll: job.replaceAll,
  });
}

function classify(err: unknown): { kind: "grep" | "edit" | "internal"; message: string } {
  if (err instanceof StudioGrepError) return { kind: "grep", message: err.message };
  if (err instanceof StudioEditError) return { kind: "edit", message: err.message };
  return { kind: "internal", message: err instanceof Error ? err.message : String(err) };
}

// Absent only when this module is imported for its types; the runner always
// starts it as a worker entry, where parentPort is set.
parentPort?.on("message", ({ id, job }: { id: number; job: ScanJob }) => {
  let response: ScanResponse;
  try {
    response = { id, ok: true, result: runJob(job) };
  } catch (err) {
    response = { id, ok: false, ...classify(err) };
  }
  parentPort?.postMessage(response);
});
