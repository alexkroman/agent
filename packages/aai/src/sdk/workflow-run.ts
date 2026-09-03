// Copyright 2026 the AAI authors. MIT license.
/**
 * A workflow RUN's observable state: its status, the snapshot a caller reads, and
 * the guard that says whether it will change again.
 *
 * Split from `workflow.ts` (which owns the authoring API) because this is what a
 * READER of a run needs and the two audiences barely overlap: a page polling a
 * run imports only this half, while an agent author writing a workflow body
 * imports only the other. Everything here is re-exported from `workflow.ts`, so
 * no import path changes.
 *
 * **The status set is the Workflow DevKit's, not ours.** It is
 * `WorkflowRunStatus` from `@workflow/world` restated as a plain union — five
 * members, no `sleeping`. That omission is the one to know about, because the
 * predecessor engine had one: a suspended run there held a journaled wake time
 * and a snapshot could say "asleep until 09:00". WDK models a sleep as a
 * suspension of a run that is still `running`, and exposes no wake time on the
 * run record, so a page cannot render a countdown any more. Restating the union
 * rather than re-exporting theirs keeps it off the published type surface (the
 * root barrel would otherwise drag `@workflow/world` into every agent bundle's
 * types) — `workflow-status-align.test.ts` pins the two lists equal, so a WDK
 * release that adds a member fails here rather than at the first run that
 * reports it.
 */

/**
 * Lifecycle of one workflow run.
 *
 * - `pending` — created, not yet picked up by the queue.
 * - `running` — executing, or suspended at a `sleep`/hook waiting to resume.
 * - `completed` / `failed` / `cancelled` — terminal.
 *
 * @public
 */
export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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
 * inlining the fields five times is what makes a field added here reach every
 * status at once.
 *
 * @public
 */
export type WorkflowRunBase = {
  runId: string;
  /** Key the workflow is declared under in `agent({ workflows })`. */
  workflow: string;
  /** When the run was created, as epoch ms. */
  createdAt: number;
  /** The correlation key {@link WorkflowClient.start} was given, when it was given one. */
  key?: string;
};

/**
 * A run's observable state, as {@link WorkflowClient.get} returns it.
 *
 * **Discriminated on `status`**, so the field a status defines is present
 * exactly when that status holds: narrowing to `"completed"` gives a
 * non-optional `output`, and to `"failed"` a non-optional `error`. A flat object
 * with optional fields makes every consumer pay a cast — a page rendering a
 * result would write `run.status === "completed" ? (run.output as Out) :
 * undefined`, re-asserting by hand both halves of what the type can say.
 *
 * @typeParam R - The workflow's own return type, when the caller named the
 *   workflow (see {@link WorkflowDef}); `unknown` otherwise.
 *
 * @public
 */
export type WorkflowRunSnapshot<R = unknown> =
  | (WorkflowRunBase & { status: "pending" | "running" })
  /** `output` is what the workflow function returned. */
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

/**
 * Longest a request may hold open waiting for a run to settle — the ceiling on
 * the API's SYNCHRONOUS mode.
 *
 * 60s, under every default idle timeout a proxy in the path is likely to carry
 * (nginx and most CDNs sit there), because a request cut by an intermediary
 * answers the caller with a network error rather than the "still running" the
 * API answers a timeout with — and that is the one outcome which loses the run
 * id.
 *
 * The cap is the honest statement of what waiting IS: an optimization over
 * reading the run back, never the mechanism. A run can take a week; a request
 * cannot.
 *
 * @public
 */
export const MAX_WORKFLOW_WAIT_MS = 60_000;

/**
 * Clamp a requested wait to what the API will actually hold a socket open for.
 *
 * Shared by both ends deliberately: the browser client sizes its own `fetch`
 * deadline from this same function, so a page can never still be waiting on a
 * request the agent already answered — nor give up before it does.
 *
 * Anything above the cap is CLAMPED rather than rejected, because the caller's
 * intent ("wait as long as you can") is unambiguous; anything absent, negative
 * or non-finite means "do not wait".
 *
 * @public
 */
export function clampWorkflowWait(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(requested, MAX_WORKFLOW_WAIT_MS);
}
