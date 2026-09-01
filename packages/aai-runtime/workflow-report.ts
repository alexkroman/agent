// Copyright 2026 the AAI authors. MIT license.
/**
 * The published half of {@link report} and {@link emit}: one call becomes a
 * stream chunk, and — for a narration line — a server-log line beside it.
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

import type { StepReporter } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { currentRun } from "./workflow-run-context.ts";

/** The two DevKit entry points a report reads, as that package exports them. */
type WorkflowRuntime = {
  getWritable?: <T>(options?: { namespace?: string }) => WritableStream<T>;
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
  mod: WorkflowRuntime | undefined,
): { stepName: string; stepId: string; attempt: number } | undefined {
  // OUR engine first. `workflow-run-context.ts` is an `AsyncLocalStorage` this
  // package owns, so it is both cheaper than the DevKit's lazy import and the
  // only one that answers for a run this engine is executing. The DevKit arm
  // stays for as long as a body can still be a `"use step"` one; when the last
  // template migrates it goes, and with it the try/catch — the DevKit's
  // `getStepMetadata()` THREW outside a step, which is a legitimate place to
  // call `report()` from.
  const step = currentRun()?.step;
  if (step) return { stepName: step.name, stepId: step.key, attempt: step.attempt };
  try {
    return mod?.getStepMetadata?.();
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
  return async (chunk: unknown, options): Promise<void> => {
    // OUR context first, and the `await` below is what that costs when there is
    // one: nothing. An earlier draft claimed this ordering while still opening
    // with `await loadDevkit()`, so every `report()` in the process paid a full
    // module load of the package this change exists to remove — on the narration
    // path of a run's FIRST step, which is the first line a watching page is
    // waiting for.
    const run = currentRun();
    const mod = run ? undefined : await loadDevkit();
    const step = stepMetadata(mod);
    const namespace = options?.namespace;
    // **The attempt is part of the LINE, not just the log context.** A fan-out
    // that is retrying looks identical in a progress stream to one that is
    // succeeding — `report()` prints the same sentence each attempt — so a
    // reader watching sixty segments cannot tell a slow run from a wedged one.
    // Only past the first, so the ordinary case reads as the author wrote it.
    //
    // Only a LINE gets it. `emit()`'s chunk is a value a program parses, and a
    // suffix on it is either lost or corruption — its retries are visible in the
    // narration beside it, which is the reader that can read a suffix.
    const written =
      typeof chunk === "string" && step && step.attempt > 1
        ? `${chunk} (attempt ${step.attempt})`
        : chunk;
    // The log first: it is the reader that cannot go away, and a stream write
    // that throws must not cost the operator the line. `emit()` passes
    // `log: false`, because a structured chunk per item would bury the narration
    // it sits beside.
    if (options?.log !== false) {
      logger.info(`Workflow: ${String(written)}`, {
        ...(step ? { step: step.stepName, stepId: step.stepId, attempt: step.attempt } : {}),
      });
    }
    try {
      await writeChunk(mod, written, namespace);
    } catch (err: unknown) {
      // Not `logger.warn`: a page that closed mid-run makes this the ordinary
      // case, and a warn per step would bury the narration it sits beside.
      logger.debug?.("Workflow progress not streamed", {
        // Truthiness, not `omitUndefined`, and `guard-invariants` rule 22 has a
        // baseline entry for it: an ABSENT namespace IS the default stream (see
        // `writeChunk` below), so `namespace: ""` would claim a namespace where
        // there is none. `omitUndefined` keeps `""`; dropping it is the point.
        ...(namespace ? { namespace } : {}),
        error: errorMessage(err),
      });
    }
  };
}

/**
 * Write one chunk to a stream of the current run, if there is one.
 *
 * The namespace is what separates `emit()`'s typed chunks from `report()`'s
 * lines: the DevKit keys a run's writable streams by it, so a reader subscribing
 * to one sees only the other's. An ABSENT namespace is the default stream, which
 * is `report()`'s — passed through rather than defaulted here, because
 * `getWritable` distinguishes the two and a `{ namespace: undefined }` is not
 * the same request as no options at all.
 */
async function writeChunk(
  mod: WorkflowRuntime | undefined,
  chunk: unknown,
  namespace: string | undefined,
): Promise<void> {
  // OUR engine first, same order and same reason as `stepMetadata`. `write`
  // takes the namespace resolved rather than optional, because this engine's
  // stream store has one default and does not need to tell "absent" from
  // "explicitly the default" — the distinction below exists only because
  // `getWritable` makes it.
  const run = currentRun();
  if (run) {
    // `namespace` is passed through UNRESOLVED — `streamNamespace` in
    // `workflow-streams.ts` is the one owner, and an earlier draft's `?? ""`
    // here defeated it while a comment claimed the opposite.
    await run.write(namespace, chunk);
    return;
  }
  // No DevKit in this process (a spec, a script): the log line above is the
  // whole report, which is what makes an exported step callable without a world.
  if (!mod?.getWritable) return;
  const writer = mod
    .getWritable<unknown>(namespace === undefined ? undefined : { namespace })
    .getWriter();
  try {
    await writer.write(chunk);
  } finally {
    // Released rather than closed: later steps write to the same stream, and a
    // closed stream cannot be reopened.
    writer.releaseLock();
  }
}
