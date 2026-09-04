// Copyright 2026 the AAI authors. MIT license.
/**
 * The published half of {@link stepReport} and {@link stepEmit}: one call becomes a
 * stream chunk, and — for a narration line — a server-log line beside it.
 *
 * `sdk/step-report.ts` is the surface a step calls and may not import a logger
 * (a step is handed none) — it rides the browser bundle and the CLI's
 * zero-dependency startup path. This module is where the logger lives, and
 * `createRuntimeServer` publishes it — the one front door `aai dev`, a self-hosted
 * server and every deployed guest share, so narration behaves identically in all
 * three.
 *
 * ## Two readers, and neither is optional
 *
 * The **stream** is what a page renders: `RunContext.write` is the only channel
 * a run has before it produces an output, read back by
 * `GET /workflows/runs/:id/stream` and `useWorkflowProgress`. The **log** is
 * what an operator has: a workflow app otherwise answers requests and executes
 * steps with nothing in the server log naming the work, so "is it stuck, or is
 * segment 41 of 60 slow?" was unanswerable without a browser.
 *
 * They are written in that order and the log line is written even when the
 * stream write fails, because the failure modes are the reader's: a page can
 * close, a stream can be gone, and an operator still wants the line.
 *
 * ## The run is found through an `AsyncLocalStorage`, not through an import
 *
 * `workflow-run-context.ts` is the store, and it propagates across awaits — so a
 * `stepReport()` from deep inside a step's own helpers still lands in the step's own
 * run. Outside a run there is no context, and that is ORDINARY: a spec calling
 * an exported step degrades to log-only rather than failing.
 */

import type { StepInfoReader, StepReporter } from "@alexkroman1/aai/host-internal";
// `StepInfo` is the PUBLIC shape a step reads, so it comes from the subpath a
// step author imports rather than from the host support surface beside it.
import type { StepInfo } from "@alexkroman1/aai/step";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { currentRun } from "./workflow-run-context.ts";

/**
 * Build the reporter `createRuntimeServer` publishes.
 *
 * @param logger - Where the line goes as well as the run's stream.
 * @internal
 */
export function createStepReporter(logger: Logger): StepReporter {
  return async (chunk: unknown, options): Promise<void> => {
    // Which step is speaking, when one is. A body, a tool and a spec are all
    // legitimate places to `stepReport()` from and none of them is a step, so the
    // answer there is `undefined` rather than a failure — which is what let the
    // DevKit-era try/catch around `getStepMetadata()` go.
    const step = currentRun()?.step;
    const namespace = options?.namespace;
    // **The attempt is part of the LINE, not just the log context.** A fan-out
    // that is retrying looks identical in a progress stream to one that is
    // succeeding — `stepReport()` prints the same sentence each attempt — so a
    // reader watching sixty segments cannot tell a slow run from a wedged one.
    // Only past the first, so the ordinary case reads as the author wrote it.
    //
    // Only a LINE gets it. `stepEmit()`'s chunk is a value a program parses, and a
    // suffix on it is either lost or corruption — its retries are visible in the
    // narration beside it, which is the reader that can read a suffix.
    const written =
      typeof chunk === "string" && step && step.attempt > 1
        ? `${chunk} (attempt ${step.attempt})`
        : chunk;
    // The log first: it is the reader that cannot go away, and a stream write
    // that throws must not cost the operator the line. `stepEmit()` passes
    // `log: false`, because a structured chunk per item would bury the narration
    // it sits beside.
    if (options?.log !== false) {
      logger.info(`Workflow: ${String(written)}`, {
        ...(step ? { step: step.name, stepId: step.key, attempt: step.attempt } : {}),
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
 * The namespace is what separates `stepEmit()`'s typed chunks from `stepReport()`'s
 * lines: a run's streams are keyed by it, so a reader subscribing to one sees
 * only the other's. An ABSENT namespace is the default stream, which is
 * `stepReport()`'s.
 */
async function writeChunk(chunk: unknown, namespace: string | undefined): Promise<void> {
  // No run in this context (a spec, a script, a `stepReport()` from a tool): the log
  // line above is the whole report, which is what makes an exported step
  // callable with no engine around it.
  const run = currentRun();
  if (!run) return;
  // `namespace` is passed through UNRESOLVED — `streamNamespace` in
  // `workflow-streams.ts` is the one owner, and an earlier draft's `?? ""` here
  // defeated it while a comment claimed the opposite.
  await run.write(namespace, chunk);
}

/**
 * Build the step-info reader `createRuntimeServer` publishes.
 *
 * Beside {@link createStepReporter} because both are the published half of a
 * `@alexkroman1/aai/step` slot over the same `AsyncLocalStorage`, and both
 * answer `undefined` outside a step for the same reason: a body, a tool and a
 * spec are all legitimate callers and none of them is a step.
 *
 * `isLastAttempt` is DERIVED here rather than carried on the run context, so the
 * one place that knows both numbers is the one place that compares them —
 * `attempt >= maxAttempts` and not `===`, because a boot can burn an attempt and
 * push the count past the ceiling, which is the case a strict equality reads as
 * "not the last try" on the try that really is.
 *
 * @internal
 */
export function createStepInfoReader(): StepInfoReader {
  return (): StepInfo | undefined => {
    const step = currentRun()?.step;
    if (step === undefined) return undefined;
    return {
      name: step.name,
      key: step.key,
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      isLastAttempt: step.attempt >= step.maxAttempts,
    };
  };
}
