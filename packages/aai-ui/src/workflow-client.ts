// Copyright 2026 the AAI authors. MIT license.
/**
 * Browser client for the workflow HTTP API (`aai/host/workflow-api.ts`).
 *
 * This is the whole client half of a WORKFLOW APP: an agent whose front door is
 * a form rather than a microphone (`workflowApp()`) starts runs
 * here and watches them for the answer. It deliberately does NOT go through
 * `BrowserSession` — there is no socket, no audio graph, and no session to resume.
 *
 * **The requests themselves are the SDK's now**
 * (`createWorkflowApiClient`, `@alexkroman1/aai/workflow-api`), and what is left
 * here is the one thing that is genuinely a BROWSER's: the default base URL.
 * Every route, every query, the 404-is-an-answer rule and the `wait` clamp were
 * written three times over — here, in the studio's Workflows card, and in
 * `aai workflow` — and the parts the copies disagreed on were exactly the ones a
 * reader cannot check by eye. The SDK module's doc carries that argument; this
 * file must not grow a second implementation of any of it.
 *
 * The one thing worth knowing before using it: **a run outlives the page.**
 * Starting one resolves as soon as the run is created, so `runId` is the only
 * handle that matters and it stays valid across a reload, a different device, or
 * `curl` — which is what makes `useWorkflowRun` a watch rather than a
 * subscription to something the page owns.
 *
 * The loop that keeps asking lives in `use-workflow-run.ts`, and the streaming
 * fast path under it in `workflow-events.ts`.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { createWorkflowApiClient, type WorkflowApi } from "@alexkroman1/aai/workflow-api";
import { pageBaseUrl } from "./_utils.ts";

/**
 * A run's observable state.
 *
 * Aliased from the SDK rather than restated. `import type` is erased entirely,
 * so a second definition of the fields and the five-member status union would
 * buy nothing and cost the one thing that matters — nothing would assert the two
 * agree, so a status added to the SDK would never reach the browser type.
 *
 * `WorkflowRun` keeps the shorter name because it is what a page's own code
 * writes; nothing in a browser needs the word "snapshot" to know a read returns
 * one.
 *
 * It is GENERIC on the run's output, and a page supplies it — see
 * {@link useWorkflowRun}. It does NOT have to restate that type: a page can name
 * its own workflow and derive the rest with `WorkflowOutputOf`, pulling no
 * server graph into the bundle.
 *
 * @public
 */
export type WorkflowRun<R = unknown> = WorkflowRunSnapshot<R>;

/**
 * A workflow's own output type, and the shape `GET /workflows` lists — both
 * re-exported so a page needs ONE import to type its runs and render its form.
 */
/**
 * The call set {@link createWorkflowApi} returns.
 *
 * Re-exported from the SDK rather than declared here: it IS the SDK's client,
 * and a structural restatement would be a second thing to keep in step with the
 * routes for no gain.
 */
export type {
  WorkflowApi,
  // Both halves of a def's shape, not just the output. `WorkflowInputOf` is
  // what a page names to type the object it hands `submit()`, and it was absent
  // here while its sibling was present — so a page typing a form value reached
  // past this package into `@alexkroman1/aai/workflow-api` for one name.
  WorkflowInputOf,
  WorkflowOutputOf,
  // The status union on its own, so a page can type a lookup keyed by it —
  // which is what `WORKFLOW_STATUS_LABELS` is and what a page extending it
  // writes. Reachable through `WorkflowRun["status"]` either way; naming it is
  // what makes `Record<WorkflowRunStatus, string>` readable at the call site.
  WorkflowRunStatus,
  WorkflowSummary,
} from "@alexkroman1/aai/workflow-api";
/**
 * A run status nothing will change again.
 *
 * Re-exported from the SDK rather than defined here. A second implementation
 * listing two of the three terminal statuses would leave a cancelled run polled
 * forever by a page while the agent considered it finished — the kind of drift a
 * status predicate beside the status union cannot have.
 */
export { isTerminal } from "@alexkroman1/aai/workflow-api";

export type WorkflowApiOptions = {
  /**
   * Base URL of the agent. Defaults to the page's own origin + path, which is
   * right for a page the agent itself serves — the only case that exists today,
   * and the reason this wrapper exists at all: the SDK client requires a base
   * URL, because `location` does not exist in that half of the SDK.
   */
  baseUrl?: string;
  /**
   * Bearer for an agent whose operator set `AAI_WORKFLOW_API_TOKEN`. A page
   * served to the public has nothing to put here (and should not — it would be
   * readable in the bundle); this exists for a programmatic caller written
   * against the same client.
   */
  token?: string;
};

/**
 * Create a workflow API client aimed at the agent serving this page.
 *
 * Hoist it out of the component that uses it. `useWorkflowRun` holds the client
 * in a ref precisely so a fresh object per render does not restart its watch,
 * but a client built in render is still a new `fetch` closure every time and
 * reads as though it were free.
 *
 * @example
 * ```tsx
 * import { createWorkflowApi, useWorkflowRun } from "@alexkroman1/aai-ui";
 * import { useState } from "react";
 *
 * // Module scope, not render scope — see above.
 * const api = createWorkflowApi();
 *
 * function StartDigest() {
 *   const [runId, setRunId] = useState<string>();
 *   const { run } = useWorkflowRun(runId, { api });
 *   return (
 *     <button
 *       type="button"
 *       onClick={() => void api.start("digest", { url: "…" }).then(setRunId)}
 *     >
 *       {run ? run.status : "Start"}
 *     </button>
 *   );
 * }
 * ```
 *
 * @param options - See {@link WorkflowApiOptions}. Both fields are optional; the
 * default base URL is the page's own origin and path.
 * @returns The call set — see {@link WorkflowApi}.
 *
 * @public
 */
export function createWorkflowApi(options: WorkflowApiOptions = {}): WorkflowApi {
  return createWorkflowApiClient({
    baseUrl: options.baseUrl ?? pageBaseUrl(),
    ...omitUndefined({ token: options.token }),
  });
}
