// Copyright 2026 the AAI authors. MIT license.
/**
 * The client preamble every workflow hook needs, once.
 *
 * Five hooks (`useWorkflowRun`, `useWorkflowProgress`, `useWorkflowRuns`,
 * `useWorkflows`, `useWorkflowSubmit`) opened with the same two refs and the
 * same two paragraphs explaining them, and both halves are load-bearing rather
 * than stylistic — which is exactly why they should not be re-derived per hook:
 *
 * - **The caller's client lives in a REF, never in an effect's dependency
 *   array.** The natural call site is
 *   `useWorkflowRun(id, { api: createWorkflowApi() })`, which passes a NEW
 *   object every render; as a dependency that tears the effect down and
 *   restarts it on each one, and because a restart clears state and re-renders,
 *   it schedules the next. The result is an unbounded request loop against the
 *   agent — on the platform, against the BROKER — with `error` wiped before
 *   anything can read it, presenting as "the page polls forever" rather than as
 *   a mistake at the call site.
 * - **The no-client default is built lazily and ONCE.** As a render-time
 *   default (`api ?? createWorkflowApi()`) it is a fresh object per render,
 *   which is the same hazard one layer down; built inside an effect it is a
 *   fresh object per watch.
 *
 * The returned getter is stable for the life of the component and reads the ref
 * on every call, so a caller that SWAPS clients mid-watch — a token arriving
 * after login — is picked up by the next request without the watch restarting.
 */

import { useCallback, useRef } from "react";
import { createWorkflowApi, type WorkflowApi } from "./workflow-client.ts";

/**
 * Resolve the client a workflow hook should use, now.
 *
 * @param api - The caller's client, or undefined for one aimed at the page's
 *   own agent.
 * @returns A stable getter. Call it per request, never once per watch.
 *
 * @internal
 */
export function useWorkflowApiRef(api: WorkflowApi | undefined): () => WorkflowApi {
  const apiRef = useRef(api);
  apiRef.current = api;
  const fallbackRef = useRef<WorkflowApi | undefined>(undefined);
  return useCallback((): WorkflowApi => {
    const current = apiRef.current;
    if (current) return current;
    fallbackRef.current ??= createWorkflowApi();
    return fallbackRef.current;
  }, []);
}
