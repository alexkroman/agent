// Copyright 2026 the AAI authors. MIT license.
/**
 * `report()` — what a running workflow says about itself, to a page AND to the
 * server log.
 *
 * A run's snapshot carries a status and, once terminal, an output. Between those
 * two there is nothing: a sixty-segment transcription and a one-segment one both
 * read as `running` for the whole fan-out, and an operator tailing the server
 * log sees a workflow app answer requests without ever learning what its steps
 * are doing. Both gaps have the same cause — a step is dispatched separately
 * from the agent bundle, holds no `ToolContext`, and is handed no logger.
 *
 * So a step narrates with one call and it lands in both places:
 *
 * ```ts no-check
 * import { report } from "@alexkroman1/aai/utils";
 *
 * export async function transcribeSegment(index: number) {
 *   "use step";
 *   await report(`Transcribing segment ${index}.`);
 * }
 * ```
 *
 * ## Why a published slot rather than an import
 *
 * The stream half is `getWritable()` from `workflow`, which this module may not
 * import: `@alexkroman1/aai/utils` is on the CLI's zero-dependency startup path
 * and is pulled into the browser bundle, and the DevKit is neither zero-cost nor
 * loadable in a browser. The host publishes a reporter instead — the same
 * `Symbol.for` slot mechanism {@link stepEnv} uses, and for the same reason: the
 * step artifact bundles its own copy of this module, so the publisher and the
 * reader are two module instances in one realm.
 *
 * `host/workflow-report.ts` is the published half, and it is what turns one
 * `report()` into a stream chunk plus a `logger.info` line.
 *
 * ## An UNPUBLISHED slot logs and moves on
 *
 * Which is what makes an exported step callable from its own spec, where there
 * is no run and no server: the line goes to the console and the call resolves.
 * The same rule {@link stepEnv} follows for `process.env`.
 *
 * ## It is BEST EFFORT, always
 *
 * A run must not fail because its narration could not be written — a closed
 * stream, a run that has moved on, a reporter that threw — so every failure here
 * is swallowed. That was already the rule in the three templates that had
 * hand-rolled this helper; it is now the rule in one place.
 */

/**
 * The registry-wide slot. Prefixed with the package name so a second copy of
 * this SDK in the same process shares it rather than shadowing it.
 */
const STEP_REPORTER_SLOT = Symbol.for("@alexkroman1/aai.stepReporter");

/**
 * What a published reporter does with one line.
 *
 * Returning a promise is allowed and awaited: the stream write is async, and a
 * step that awaits `report()` should not race the chunk it just wrote against
 * the request that reads it back.
 *
 * @internal
 */
export type StepReporter = (line: string) => void | Promise<void>;

/** The shape stored in the slot. `undefined` means nothing has published. */
type StepReporterSlot = { [STEP_REPORTER_SLOT]?: StepReporter };

/**
 * Publish the reporter for this process's `"use step"` functions.
 *
 * Called by whatever is about to serve workflows — `createServer`, which is the
 * one front door `aai dev`, a self-hosted server and every deployed guest all
 * go through. Publishing again REPLACES, which is what a dev-server restart
 * means; pass `undefined` to unpublish, which is what a spec does when it is
 * done with a fake.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai/runtime`. A step
 * author calls {@link report}.
 */
export function publishStepReporter(reporter: StepReporter | undefined): void {
  if (reporter === undefined) delete (globalThis as StepReporterSlot)[STEP_REPORTER_SLOT];
  else (globalThis as StepReporterSlot)[STEP_REPORTER_SLOT] = reporter;
}

/**
 * Write one progress line for the run this step belongs to.
 *
 * The line reaches two readers: the run's own output stream, which
 * `GET /workflows/runs/:id/stream` serves and `useWorkflowProgress` renders,
 * and the server log, so an operator watching a deploy can see which step is
 * running without a page open.
 *
 * **Call it from a STEP, never from the workflow body.** A body replays from the
 * top on every resume, so a line written there is re-emitted on each one — the
 * same rule `ctx.db` follows.
 *
 * Failures are swallowed: narration must never fail a run. It resolves either
 * way, so awaiting it is safe and is what keeps the ordering of a step's own
 * lines.
 *
 * @param line - One line of progress, as a reader should see it. Prefer a
 *   sentence naming what is happening and to what (`"Transcribing 0:00–0:58."`)
 *   over a machine token — the page renders these verbatim.
 * @public
 */
export async function report(line: string): Promise<void> {
  const reporter = (globalThis as StepReporterSlot)[STEP_REPORTER_SLOT];
  if (!reporter) {
    // No host in this process — a spec, or a script calling an exported step.
    // The console is the only channel there is, and silence would make a step
    // under test look like it did nothing.
    consoleLine(line);
    return;
  }
  try {
    await reporter(line);
  } catch {
    // A run must not fail because its narration could not be written.
  }
}

/** The fallback channel: `console.error`, where there is a console at all. */
function consoleLine(line: string): void {
  (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console?.error?.(
    `[workflow] ${line}`,
  );
}
