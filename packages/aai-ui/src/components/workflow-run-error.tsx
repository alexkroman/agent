// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import type { WorkflowRun } from "../workflow-client.ts";

/**
 * Props for {@link WorkflowRunError}.
 *
 * @public
 */
export type WorkflowRunErrorProps = {
  /** The run the page is following. Nothing renders unless it has FAILED. */
  run: WorkflowRun | undefined;
  /**
   * ADDED to the alert's own `text-red-600` rather than replacing it. There is
   * no `tailwind-merge` in this package, so a class that CONFLICTS with a base
   * one is not reliably the winner.
   */
  className?: string | undefined;
};

/**
 * The announced line for a run that failed: its error, or nothing at all while
 * the run is anything else.
 *
 * Six workflow pages had written this paragraph by hand, and the one thing that
 * mattered about it was the part a reviewer cannot see is missing:
 * `role="alert"`. A run fails minutes after the reader looked away — days, for
 * a scheduled one — and `<Form>` announces only the SUBMIT error, so without
 * the role a screen reader is never told the outcome it waited for arrived.
 * Three of the six also disagreed on the sentence ("That one failed", "That run
 * failed", the bare message), which is the drift a component ends.
 *
 * Discriminated on `status`, so `error` is reachable without a cast — the
 * reason {@link WorkflowRun} is a union rather than a flat object with optional
 * fields.
 *
 * @example
 * ```tsx
 * import { useWorkflowSubmit, WorkflowRunError } from "@alexkroman1/aai-ui";
 *
 * function App() {
 *   const { run } = useWorkflowSubmit("digest");
 *   return <WorkflowRunError run={run} />;
 * }
 * ```
 *
 * @param props - See {@link WorkflowRunErrorProps}.
 *
 * @public
 */
export function WorkflowRunError({ run, className }: WorkflowRunErrorProps): ReactNode {
  if (run?.status !== "failed") return null;
  return (
    <p role="alert" className={clsx("text-red-600", className)}>
      That run failed: {run.error}
    </p>
  );
}
