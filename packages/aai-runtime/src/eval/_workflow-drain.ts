// Copyright 2026 the AAI authors. MIT license.
/**
 * What happens to a workflow run that is still in flight when the case ends.
 *
 * Internal to `eval/workflows.ts`, and its own module because the decision here
 * is a decision rather than three lines: a body outliving the case that started
 * it is a LEAK, not untidiness, and only half of it is the harness's to fix.
 *
 * ## The leak
 *
 * `recap-workflow`'s eval states it exactly, and this is the argument credited
 * to the failure rather than to the file: the scripted provider a case installs
 * is unpublished when that case finishes, so a body still mid-flight makes its
 * next request "against whatever the next case publishes — or against the real
 * provider, with a real key". Two shipped templates hand-rolled the same drain
 * loop for it, verbatim.
 *
 * ## Why the harness can only take half
 *
 * A case that means to observe a run mid-flight does it by HOLDING a provider
 * response — a `Promise.race` against a durable sleep resolves instantly here,
 * `sleep()` being recorded rather than taken — so the thing keeping the run
 * alive is a gate belonging to the case. Nothing in this package can release
 * one. So {@link settleAllRuns} is the WAIT and the case owns the release:
 * `release(); await app.settleAll();`.
 *
 * ## And why `close()` reports instead of waiting
 *
 * Three behaviours were available:
 *
 * - **Drain on close.** Deadlock, for the reason above: the gate is released in
 *   the case's own body or teardown, and `close()` may not reject, so a case
 *   would hang for the whole run timeout and then PASS. A harness cannot release
 *   a gate it did not take.
 * - **Abandon silently**, which is what it did. That is the leak, reachable by
 *   forgetting one line.
 * - **Report**, which is this. `process.emitWarning` rather than the app's
 *   logger, because that logger defaults to SILENT so a report stays readable —
 *   and a leak warning the default swallows is the same green-run-of-nothing
 *   shape the credential gate exists to avoid. It cannot hang, and it cannot
 *   fail a case in teardown: a leak is a finding about the SUITE, and turning it
 *   into the failure of whichever case happened to close last would name the
 *   wrong one.
 *
 * @module
 */

import type { EvalWorkflowEngine } from "./workflow-engine.ts";

/**
 * Settle every run this engine has started, oldest first, through `read`.
 *
 * Generic in the run shape so this module names none of `eval/workflows.ts`'s
 * types and the dependency stays one-way.
 *
 * Re-reads `records()` after every wait rather than walking one snapshot of it:
 * a body that starts another run appends to that list WHILE this drains, and the
 * appended run is precisely the one nobody would otherwise wait for. `read`
 * bounds each run, so a chain that never ends fails rather than looping.
 */
export async function settleAllRuns<T>(
  engine: EvalWorkflowEngine,
  read: (runId: string) => Promise<T>,
): Promise<readonly T[]> {
  const settled: T[] = [];
  const drained = new Set<string>();
  for (;;) {
    const next = engine.records().find((record) => !drained.has(record.runId));
    if (next === undefined) return settled;
    drained.add(next.runId);
    settled.push(await read(next.runId));
  }
}

/**
 * Say, on stderr, that a body is still running with nothing left to hold it.
 *
 * Keyed on `elapsedMs` rather than on `status`, which is the honest test: this
 * engine's `cancel` marks a run cancelled and the BODY KEEPS GOING (there is no
 * queue to stop delivering to), so a terminal status is not evidence that
 * anything stopped. `elapsedMs` is written when the body settles and at no other
 * time.
 */
export function warnOnAbandonedRuns(engine: EvalWorkflowEngine): void {
  const live = engine.records().filter((record) => record.elapsedMs === undefined);
  if (live.length === 0) return;
  const each = live
    .map((record) => {
      const last = record.reported.at(-1);
      return (
        `${record.runId} (${record.workflowName}` +
        `${last === undefined ? "" : `, last: ${JSON.stringify(last)}`})`
      );
    })
    .join("; ");
  process.emitWarning(
    `${live.length} eval workflow run(s) were still running when the app closed: ${each}. ` +
      "Their steps will keep calling out with this app's fakes unpublished — against " +
      "whatever the next case publishes, or against the real provider on a real key. " +
      "Release whatever is holding the run and `await app.settleAll()` before closing.",
    "EvalRunAbandoned",
  );
}

/** Release the engine without letting teardown fail a case. */
export async function releaseQuietly(engine: EvalWorkflowEngine): Promise<void> {
  await engine.release().catch(() => undefined);
}
