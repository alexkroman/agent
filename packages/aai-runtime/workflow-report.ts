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
/**
 * Which step is speaking, when one is.
 *
 * `getStepMetadata()` THROWS outside a step — in a workflow body, in a spec —
 * which is a legitimate place to call `report()` from, so the answer there is
 * "no step" rather than a failure.
 */
function stepMetadata(): { stepName: string; stepId: string; attempt: number } | undefined {
  // `workflow-run-context.ts` is an `AsyncLocalStorage` this package owns, and
  // it is now the only answer: a second arm read the DevKit's `getStepMetadata`,
  // kept "for as long as a body can still be a `"use step"` one". The transform
  // that produced those is gone, so the arm went and the try/catch with it —
  // that call THREW outside a step, which is a legitimate place to `report()`
  // from, and returning `undefined` is simply what no-run means now.
  const step = currentRun()?.step;
  return step ? { stepName: step.name, stepId: step.key, attempt: step.attempt } : undefined;
}

/**
 * Build the reporter `createServer` publishes.
 *
 * @param logger - Where the line goes as well as the run's stream.
 * @internal
 */
export function createStepReporter(logger: Logger): StepReporter {
  return async (chunk: unknown, options): Promise<void> => {
    const step = stepMetadata();
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
      await writeChunk(written, namespace);
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
 * lines: a run's streams are keyed by it, so a reader subscribing to one sees
 * only the other's. An ABSENT namespace is the default stream, which is
 * `report()`'s.
 */
async function writeChunk(chunk: unknown, namespace: string | undefined): Promise<void> {
  // No run in this context (a spec, a script, a `report()` from a tool): the log
  // line above is the whole report, which is what makes an exported step
  // callable with no engine around it.
  const run = currentRun();
  if (!run) return;
  // `namespace` is passed through UNRESOLVED — `streamNamespace` in
  // `workflow-streams.ts` is the one owner, and an earlier draft's `?? ""` here
  // defeated it while a comment claimed the opposite.
  await run.write(namespace, chunk);
}
