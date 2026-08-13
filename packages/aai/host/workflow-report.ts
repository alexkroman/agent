// Copyright 2026 the AAI authors. MIT license.
/**
 * The published half of {@link report}: one progress line becomes a stream chunk
 * AND a server-log line.
 *
 * `sdk/step-report.ts` is the surface a step calls and may import neither the
 * DevKit (it is on the CLI's zero-dependency startup path and rides the browser
 * bundle) nor a logger (a step is handed none). This module is where both live,
 * and `createServer` publishes it — the one front door `aai dev`, a self-hosted
 * server and every deployed guest share, so narration behaves identically in all
 * three.
 *
 * ## Two readers, and neither is optional
 *
 * The **stream** is what a page renders: `getWritable()` is the only channel a
 * run has before it produces an output, read back by
 * `GET /workflows/runs/:id/stream` and `useWorkflowProgress`. The **log** is
 * what an operator has: a workflow app otherwise answers requests and executes
 * steps with nothing in the server log naming the work, so "is it stuck, or is
 * segment 41 of 60 slow?" was unanswerable without a browser.
 *
 * They are written in that order and the log line is written even when the
 * stream write fails, because the failure modes are the reader's: a page can
 * close, a stream can be gone, and an operator still wants the line.
 *
 * ## `workflow` is imported LAZILY, and that is load-bearing twice
 *
 * `host/server.ts` reaches this module, and `server.ts` is what `aai dev`
 * imports at startup — a static import would put the DevKit on the CLI's
 * startup path for every agent, workflows or not. It also must not throw for a
 * process that has no world: an import failure degrades to log-only, which is
 * exactly right for a spec calling an exported step.
 *
 * The dynamic import does not lose the run: `getWritable()` reads an
 * `AsyncLocalStorage` context, which propagates across awaits, so resolving the
 * module inside the call still lands in the step's own run.
 */

import type { StepReporter } from "../sdk/step-report.ts";
import { errorMessage } from "../sdk/utils.ts";
import type { Logger } from "./runtime-config.ts";

/** The two DevKit entry points a report reads, as that package exports them. */
type WorkflowRuntime = {
  getWritable?: <T>() => WritableStream<T>;
  getStepMetadata?: () => { stepName: string; stepId: string; attempt: number };
};

/**
 * Resolve `getWritable` once per process.
 *
 * Memoized on the PROMISE rather than the value so concurrent steps share one
 * import; a rejection is remembered too, deliberately — the module is either
 * resolvable in this process or it never will be, and retrying it per line
 * would pay the failure on every step of every run.
 */
let devkit: Promise<WorkflowRuntime> | undefined;

function loadDevkit(): Promise<WorkflowRuntime> {
  devkit ??= import("workflow")
    .then((mod) => mod as WorkflowRuntime)
    .catch(() => ({}) as WorkflowRuntime);
  return devkit;
}

/**
 * Which step is speaking, when one is.
 *
 * `getStepMetadata()` THROWS outside a step — in a workflow body, in a spec —
 * which is a legitimate place to call `report()` from, so the answer there is
 * "no step" rather than a failure.
 */
function stepMetadata(
  mod: WorkflowRuntime,
): { stepName: string; stepId: string; attempt: number } | undefined {
  try {
    return mod.getStepMetadata?.();
  } catch {
    return undefined;
  }
}

/**
 * Build the reporter `createServer` publishes.
 *
 * @param logger - Where the line goes as well as the run's stream.
 * @internal
 */
export function createStepReporter(logger: Logger): StepReporter {
  return async (line: string): Promise<void> => {
    const mod = await loadDevkit();
    const step = stepMetadata(mod);
    // **The attempt is part of the LINE, not just the log context.** A fan-out
    // that is retrying looks identical in a progress stream to one that is
    // succeeding — `report()` prints the same sentence each attempt — so a
    // reader watching sixty segments cannot tell a slow run from a wedged one.
    // Only past the first, so the ordinary case reads as the author wrote it.
    const written = step && step.attempt > 1 ? `${line} (attempt ${step.attempt})` : line;
    // The log first: it is the reader that cannot go away, and a stream write
    // that throws must not cost the operator the line.
    logger.info(`Workflow: ${written}`, {
      ...(step ? { step: step.stepName, stepId: step.stepId, attempt: step.attempt } : {}),
    });
    try {
      await writeChunk(mod, written);
    } catch (err: unknown) {
      // Not `logger.warn`: a page that closed mid-run makes this the ordinary
      // case, and a warn per step would bury the narration it sits beside.
      logger.debug?.("Workflow progress not streamed", { error: errorMessage(err) });
    }
  };
}

/** Write one line to the current run's output stream, if there is one. */
async function writeChunk(mod: WorkflowRuntime, line: string): Promise<void> {
  // No DevKit in this process (a spec, a script): the log line above is the
  // whole report, which is what makes an exported step callable without a world.
  if (!mod.getWritable) return;
  const writer = mod.getWritable<string>().getWriter();
  try {
    await writer.write(line);
  } finally {
    // Released rather than closed: later steps write to the same stream, and a
    // closed stream cannot be reopened.
    writer.releaseLock();
  }
}
