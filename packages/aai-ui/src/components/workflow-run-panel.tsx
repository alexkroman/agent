// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import type { WorkflowRunStatus } from "../workflow-client.ts";
import { isTerminal, type WorkflowApi, type WorkflowRun } from "../workflow-client.ts";
import { WORKFLOW_STATUS_LABELS } from "../workflow-status-labels.ts";
import { WorkflowProgress } from "./workflow-progress.tsx";
import { WorkflowRunError } from "./workflow-run-error.tsx";

/**
 * Props of {@link WorkflowRunPanel}.
 *
 * @typeParam O - The run's output type; `run.output` narrows to it in the
 * completed slot.
 *
 * @public
 */
export type WorkflowRunPanelProps<O> = {
  /** The run to show. Nothing here handles `undefined` — a page renders the panel once it has one. */
  run: WorkflowRun<O>;
  /**
   * The status lines this page has a better word for — `{ running:
   * "Writing…" }`. The rest come from {@link WORKFLOW_STATUS_LABELS}.
   */
  statusLabels?: Partial<Readonly<Record<WorkflowRunStatus, string>>> | undefined;
  /** Renders a Clear button in the header that calls this. Absent, no button. */
  onClear?: (() => void) | undefined;
  /** The workflow API client, when the page holds its own. */
  api?: WorkflowApi | undefined;
  /**
   * Rendered beneath the narration while the run is NOT terminal — a live
   * transcript, a partial result. Nothing once it settles.
   */
  live?: ReactNode | undefined;
  /**
   * The completed body: what the run PRODUCED. A function receives the typed
   * output; a node is rendered as it is. Either appears only while
   * `run.status === "completed"`.
   */
  children?: ReactNode | ((output: O) => ReactNode) | undefined;
  /** Additional CSS class names for the wrapping `<section>`, appended to its own. */
  className?: string | undefined;
};

/**
 * The bordered panel a workflow page shows one run in: a status line, a Clear
 * button, the run's own narration, the live slot while it works, the completed
 * body once it has, and the announced error if it failed.
 *
 * Two pages had written this shell — `document-redline-workflow` and `transcription-workflow` —
 * with the same header, the same `text-xs underline` Clear, the same
 * {@link WorkflowProgress} under it, the same `run.status === "completed"`
 * discrimination above the same {@link WorkflowRunError}, and each spread
 * {@link WORKFLOW_STATUS_LABELS} into a local map to change `running`. The
 * ORDER is the part worth owning: the narration is the complement of the status
 * line (a run is `running` for its whole life, so a one-round job and a
 * ten-round one look identical without it), and the error goes last because it
 * is the outcome the reader waited minutes for.
 *
 * `children` is discriminated on the run for the caller, so the body reads
 * `run.output` typed, without a cast and without the page repeating the guard —
 * the reason {@link WorkflowRun} is a union rather than a flat object with
 * optional fields.
 *
 * @example
 * ```tsx
 * import { useWorkflowRun, WorkflowRunPanel } from "@alexkroman1/aai-ui";
 *
 * // `useWorkflowRun<R>` is where a page names the output's shape; a page that
 * // started the run itself has it typed already, from `useWorkflowSubmit<D>`.
 * function Panel({ runId, onClear }: { runId: string; onClear: () => void }) {
 *   const { run } = useWorkflowRun<{ draft: string }>(runId);
 *   if (!run) return null;
 *   return (
 *     <WorkflowRunPanel run={run} statusLabels={{ running: "Writing…" }} onClear={onClear}>
 *       {(output) => <article className="whitespace-pre-wrap">{output.draft}</article>}
 *     </WorkflowRunPanel>
 *   );
 * }
 * ```
 *
 * @param props - See {@link WorkflowRunPanelProps}.
 *
 * @public
 */
export function WorkflowRunPanel<O = unknown>({
  run,
  statusLabels,
  onClear,
  api,
  live,
  children,
  className,
}: WorkflowRunPanelProps<O>): ReactNode {
  const labels: Readonly<Record<WorkflowRunStatus, string>> = {
    ...WORKFLOW_STATUS_LABELS,
    ...statusLabels,
  };
  return (
    <section className={clsx("flex flex-col gap-4 rounded-md border p-5", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-[1.2px]">{labels[run.status]}</h2>
        {onClear && (
          <button type="button" onClick={onClear} className="text-xs underline opacity-60">
            Clear
          </button>
        )}
      </div>
      {/* The run's own narration, oldest first. These lines REPLAY, so a reload
          mid-run — or a finished run opened tomorrow — shows how it got there. */}
      <WorkflowProgress runId={run.runId} api={api} />
      {!isTerminal(run) && live}
      {run.status === "completed" &&
        (typeof children === "function" ? children(run.output) : children)}
      {/* Announced, the same contract `<Form>` gives the submit error: this is
          the outcome the reader waited minutes for. */}
      <WorkflowRunError run={run} />
    </section>
  );
}
