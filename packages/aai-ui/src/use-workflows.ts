// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent's declared workflows — what a form is rendered FROM.
 *
 * Split out of `use-workflow-form.ts` at the 500-line cap, along the seam that
 * file's own doc already drew: it held "the two hooks a FORM needs", and only
 * one of them is about a RUN. This is the other one, and it shares nothing with
 * its former neighbours but the client ref every hook here uses — no state, no
 * run id, no upload.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { useEffect, useState } from "react";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** Options for {@link useWorkflows}. */
export type UseWorkflowsOptions = {
  /** The client to read the listing with. Defaults to one for the page's own agent. */
  api?: WorkflowApi;
  /**
   * Skip the lookup entirely, reporting an empty listing that is not loading.
   *
   * For a caller that may or may not need the listing and cannot decide with a
   * conditional hook — `<WorkflowFields>` handed a summary rather than a name is
   * the one in this package. It reports `loading: false`, because a skipped
   * lookup is finished rather than pending.
   */
  skip?: boolean;
};

/** What {@link useWorkflows} reports. */
export type UseWorkflowsResult = {
  /** The agent's declared workflows, each with the JSON Schema of its input. */
  workflows: WorkflowSummary[];
  /** True until the listing lands, so a form can hold its fields back. */
  loading: boolean;
  /** The lookup's failure. Set alongside an EMPTY list, which is why it exists. */
  error: string | undefined;
};

/**
 * Read the agent's declared workflows.
 *
 * What `<WorkflowFields>` renders a form FROM: each summary carries the JSON
 * Schema of that workflow's input, converted server-side precisely so a browser
 * can read it.
 *
 * The failure is reported rather than swallowed, because the alternative is an
 * empty list — which renders as a form with no fields and reads as "this agent
 * declares no workflows" about an agent that was merely unreachable.
 *
 * @example
 * ```tsx
 * import { useWorkflows } from "@alexkroman1/aai-ui";
 *
 * // A page rendering its own chrome from the listing — a picker, say. A form
 * // for ONE workflow wants `<WorkflowFields workflow="name" />` instead,
 * // which does this lookup itself.
 * function WorkflowPicker({ onPick }: { onPick: (name: string) => void }) {
 *   const { workflows, loading, error } = useWorkflows();
 *   if (loading) return <p>Loading…</p>;
 *   if (error !== undefined) return <p role="alert">{error}</p>;
 *   return (
 *     <ul>
 *       {workflows.map((summary) => (
 *         <li key={summary.name}>
 *           <button type="button" onClick={() => onPick(summary.name)}>
 *             {summary.description ?? summary.name}
 *           </button>
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 *
 * @param opts - See {@link UseWorkflowsOptions}.
 * @returns The listing, its loading flag and its failure — see
 * {@link UseWorkflowsResult}.
 *
 * @public
 */
export function useWorkflows(opts: UseWorkflowsOptions = {}): UseWorkflowsResult {
  const { api, skip = false } = opts;
  const [state, setState] = useState<UseWorkflowsResult>({
    workflows: [],
    // A skipped lookup is not a pending one: `loading: true` forever would hold
    // back a form that is waiting on it.
    loading: !skip,
    error: undefined,
  });

  // The client through a ref — see `_workflow-api-ref.ts`.
  const getClient = useWorkflowApiRef(api);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    getClient()
      .list()
      .then((workflows) => {
        if (!cancelled) setState({ workflows, loading: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          workflows: [],
          loading: false,
          error: errorMessage(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [skip, getClient]);

  return state;
}
