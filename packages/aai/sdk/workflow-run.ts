// Copyright 2026 the AAI authors. MIT license.
/**
 * A workflow RUN's observable state: its status, the snapshot a caller reads, and
 * the guard that says whether it will change again.
 *
 * Split from `workflow.ts` (which owns the authoring API — `workflow()`, the
 * context, the client) because this is what a READER of a run needs and the two
 * audiences barely overlap: a page polling a run imports only this half, while an
 * agent author writing a `run` body imports only the other. Everything here is
 * re-exported from `workflow.ts`, so no import path changes.
 *
 * The snapshot being a discriminated union is the load-bearing decision — see
 * {@link WorkflowRunSnapshot}.
 */

/**
 * Lifecycle of one workflow run.
 *
 * - `pending` — created, not yet picked up.
 * - `running` — claimed by an executor whose lease has not expired.
 * - `sleeping` — suspended at a {@link WorkflowContext.sleep}; `wakeAt` says when.
 * - `completed` / `failed` / `cancelled` — terminal.
 *
 * A `running` run whose lease expired (its sandbox died) is claimable again;
 * that is the whole recovery mechanism, and it is why the status set has no
 * separate "crashed".
 *
 * @public
 */
export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed"
  | "cancelled";

/** Statuses nothing will change again. */
export const TERMINAL_WORKFLOW_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly WorkflowRunStatus[];

/**
 * Fields every {@link WorkflowRunSnapshot} member carries, whatever its status.
 *
 * Exported because it is part of a public type's shape: `WorkflowRunSnapshot`
 * intersects it into every member, so TypeDoc's `treatWarningsAsErrors` fails the
 * docs build for a type "referenced by a public signature but not exported" —
 * which is the rule working, not an inconvenience. Keeping the alias rather than
 * inlining four fields five times is what makes a field added here reach every
 * status at once.
 *
 * @public
 */
export type WorkflowRunBase = {
  runId: string;
  /** Key the workflow was declared under in `agent({ workflows })`. */
  workflow: string;
  /** How many steps this run has journaled — enough to render coarse progress. */
  stepsCompleted: number;
  /** The correlation key {@link WorkflowClient.start} was given, when it was given one. */
  key?: string;
};

/**
 * A run's observable state, as {@link WorkflowClient.get} returns it.
 *
 * **Discriminated on `status`**, so the field a status defines is present
 * exactly when that status holds: narrowing to `"completed"` gives a non-optional
 * `output`, and to `"failed"` a non-optional `error`. It was a flat object with
 * four optional fields and the correlation stated only in prose, which every
 * consumer paid for as a cast — the shipped `transcription-desk` page read
 * `run.status === "completed" ? (run.output as TranscribeOutput) : undefined`,
 * i.e. re-asserting by hand both halves of what the type now says.
 *
 * @typeParam R - The workflow's own return type, when the caller named the
 *   workflow (see {@link WorkflowDef}); `unknown` otherwise.
 *
 * @public
 */
export type WorkflowRunSnapshot<R = unknown> =
  | (WorkflowRunBase & { status: "pending" | "running" })
  /** `wakeAt` is when a sleeping run becomes due, as epoch ms. */
  | (WorkflowRunBase & { status: "sleeping"; wakeAt: number })
  /** `output` is the `run` function's return value. */
  | (WorkflowRunBase & { status: "completed"; output: R })
  /** `error` is the failure message. */
  | (WorkflowRunBase & { status: "failed"; error: string })
  /** Cancelled by {@link WorkflowClient.cancel}; it produced no output. */
  | (WorkflowRunBase & { status: "cancelled" });

/** A run in a status nothing will change again. */
export type TerminalWorkflowRun<R = unknown> = Extract<
  WorkflowRunSnapshot<R>,
  { status: "completed" | "failed" | "cancelled" }
>;

/**
 * Is this run finished?
 *
 * A type guard rather than a `boolean`, so the narrow it performs is usable:
 * `if (isTerminal(run))` leaves `run.status` as the three-member union a caller
 * can switch over exhaustively. Accepts `undefined` (nothing started yet, or the
 * first poll has not landed) because that is what every call site holds.
 *
 * @public
 */
export function isTerminal<R>(
  run: WorkflowRunSnapshot<R> | undefined,
): run is TerminalWorkflowRun<R> {
  return (
    run !== undefined && (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(run.status)
  );
}
