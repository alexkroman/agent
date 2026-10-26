// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.report` — one progress line from a workflow BODY, as ONE journaled step.
 *
 * `stepReport` may be called from a STEP and not from the body, because the
 * body is replayed from the top and a line written there is re-emitted on
 * every delivery. So every body that wanted to narrate between two steps wrote
 * `ctx.step("announce", () => stepReport("…"))`, which is this call under one
 * name. Composed ENTIRELY of `ctx.step`, so it has no journal shape of its own:
 * `ctx.report("announce", line)` journals `announce#0`, exactly as the
 * hand-written step did, and the line is written on the walk that first reaches
 * it and answered from the journal on every later one.
 *
 * Every `WorkflowContext` (the replay engine's, the `/testing` recorder, an
 * eval's) implements `report` by calling {@link reportWorkflow}, as they do
 * `ctx.poll` and `ctx.sayOnClient`.
 *
 * @internal — reached by a host through `@alexkroman1/aai/host-internal`; an
 * author calls `ctx.report`.
 */

import { stepReport } from "./step-report.ts";
import type { StepOptions } from "./workflow-ctx-options.ts";

/**
 * The one context method a report is made of, with the NAME unconstrained —
 * the `PollHost` shape, for the same reason.
 *
 * @internal
 */
export type ReportHost = {
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
};

/**
 * Run one `ctx.report` over `host`.
 *
 * `stepReport` swallows its own failures, so the step cannot fail and spends no
 * retry; `maxAttempts: 1` says so rather than leaving a default budget nothing
 * can consume.
 *
 * @internal
 */
export function reportWorkflow(host: ReportHost, name: string, line: string): Promise<void> {
  return host.step(name, () => stepReport(line), { maxAttempts: 1 });
}
