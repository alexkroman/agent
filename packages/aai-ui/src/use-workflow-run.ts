// Copyright 2026 the AAI authors. MIT license.
/**
 * `useWorkflowRun` — watch one run until it settles.
 *
 * Split from `workflow-client.ts` on the seam that module's doc already draws:
 * everything there is a REQUEST (one call, one answer, no React), and everything
 * here is the loop that keeps asking. They are read for different reasons — the
 * client is what a script or a `curl` equivalent needs, this is what a page needs
 * — and only this half imports React.
 *
 * `workflow-events.ts` sits under it as the streaming fast path, and
 * `use-workflow-form.ts` above it as the form-shaped caller.
 */

import { errorMessage } from "@alexkroman1/aai";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
import { useEffect, useState } from "react";
import { repeatUntil } from "./_repeat-until.ts";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";
import { watchRunEvents } from "./workflow-events.ts";

/** How often {@link useWorkflowRun} re-reads a live run when it has to poll. */
export const DEFAULT_WORKFLOW_POLL_MS = 2000;

/**
 * Consecutive "no such run" reads {@link useWorkflowRun} tolerates before giving
 * up on the id.
 *
 * Small on purpose: a 404 is a stable answer, so the budget exists only to
 * absorb a first read that races the run's creation — not to keep hoping.
 * Unbounded, a stale id polls (and, on the platform, BROKERS) for as long as the
 * tab is open.
 */
export const MAX_MISSING_READS = 3;

export type UseWorkflowRunResult<R = unknown> = {
  /** Latest snapshot, or undefined before the first read lands. */
  run: WorkflowRun<R> | undefined;
  /** The last read's failure, cleared by the next successful one. */
  error: string | undefined;
  /** True while a non-terminal run is still being watched. */
  polling: boolean;
};

/**
 * Poll `runId` until it is terminal, reporting each read. Returns a stop
 * function.
 *
 * Module-level rather than inline in the hook below, so neither function carries
 * the whole loop's branching — and so the loop can be read without React in the
 * way.
 */
function pollUntilTerminal<R>(
  getClient: () => WorkflowApi,
  runId: string,
  intervalMs: number,
  onRun: (run: WorkflowRun<R>) => void,
  onError: (message: string) => void,
  onStopped: () => void,
): () => void {
  let missing = 0;

  /**
   * A read that came back empty. Resolves whether the loop should STOP.
   *
   * A 404 is a STABLE answer — a run the agent does not know about now will not
   * appear later — and retrying it unbounded is how a stale id (one restored
   * from `localStorage`, or one whose agent was redeployed onto a fresh
   * database) polls forever: the page stays `polling` and therefore busy, and on
   * the platform every read BROKERS, so a tab's worth of dead ids keeps
   * sandboxes resident. A small budget is kept anyway, because the first read
   * can race a replica that has not yet seen the run.
   */
  const onMissing = (signal: AbortSignal): boolean => {
    missing += 1;
    if (missing < MAX_MISSING_READS) return false;
    if (!signal.aborted) onError(`No workflow run ${runId}`);
    return true;
  };

  const read = async (signal: AbortSignal): Promise<boolean> => {
    try {
      // Resolved per read rather than captured once, so a caller that swaps
      // clients mid-run — a token arriving after login — is picked up on the
      // next poll without the loop restarting. See the ref in the hook.
      //
      // The generic is the PAGE's assertion about its own agent's workflow,
      // which nothing in the browser can verify — the client reads JSON off a
      // route that describes no output type. Narrowed once, here, rather than at
      // every call site reading `run.output`.
      const next = (await getClient().get(runId)) as WorkflowRun<R> | undefined;
      if (signal.aborted) return true;
      if (!next) return onMissing(signal);
      missing = 0;
      onRun(next);
      // Terminal: nothing will change again, so stop rather than poll a finished
      // run for as long as the page stays open.
      return isTerminal(next);
    } catch (err) {
      // Reported and RETRIED: a dropped request against a booting sandbox is the
      // common case here, and giving up would strand a live run.
      if (!signal.aborted) onError(errorMessage(err));
      return false;
    }
  };

  return repeatUntil(intervalMs, async (signal) => {
    if (!(await read(signal))) return false;
    // Stopped on its own — a terminal run, or an id the agent will never know.
    // Reported because `polling` cannot be derived from the snapshot alone:
    // giving up on a MISSING id leaves `run` undefined, which reads as "still
    // waiting" and would leave the page permanently busy.
    if (!signal.aborted) onStopped();
    return true;
  });
}

/**
 * Watch one run until it reaches a terminal status.
 *
 * A watch rather than a subscription because a run is durable and the page is
 * not: it can complete while the tab is closed, on a different sandbox, hours
 * later. There is no session to reconnect — the id is the whole state.
 *
 * Which is also the limit of what this hook can do on its own. An id is state a
 * RELOAD destroys, so a page holding nothing else comes back unable to name a
 * run that is still going. The durable handle is `StartOptions.key`, read back
 * with `find(workflow, key)`, and the hook that owns the id is where that
 * belongs: `useWorkflowSubmit({ key, recover: true })` adopts the key's newest
 * run as it mounts and passes the id here. See `_recover-run.ts` — the reason
 * recovery is NOT in this hook is `reset()`, which leaves the owner holding no
 * id on purpose, and a watcher that re-resolved one from a key would undo it.
 *
 * The stream (`GET /runs/:id/events`) is tried first and the poll is its
 * fallback, so an agent deployed before that route existed still works. Watching
 * STOPS on a terminal status, so a finished run costs nothing; passing
 * `undefined` (nothing started yet) also costs nothing.
 *
 * @example
 * ```tsx
 * import type { ToolInputSchema, WorkflowDef } from "@alexkroman1/aai";
 * import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
 * import { useWorkflowRun } from "@alexkroman1/aai-ui";
 *
 * // A real page writes `import type { digest } from "./agent.ts"`. Stood in
 * // for here so the example compiles on its own.
 * declare const digest: WorkflowDef<ToolInputSchema, Promise<{ points: string[] }>>;
 *
 * type Digest = WorkflowOutputOf<typeof digest>;
 *
 * function RunPanel({ runId }: { runId: string | undefined }) {
 *   // The type argument is what makes `run.output` a `Digest` below.
 *   const { run, error, polling } = useWorkflowRun<Digest>(runId);
 *   if (error !== undefined) return <p role="alert">{error}</p>;
 *   if (run?.status === "completed") {
 *     return (
 *       <ul>
 *         {run.output.points.map((point) => (
 *           <li key={point}>{point}</li>
 *         ))}
 *       </ul>
 *     );
 *   }
 *   return <p>{polling ? "Working…" : "Nothing running."}</p>;
 * }
 * ```
 *
 * @typeParam R - The workflow's output type. Supplying it is what makes
 *   `run.status === "completed"` narrow to a typed `run.output` instead of
 *   `unknown`. Derive it with `WorkflowOutputOf<typeof myWorkflow>` — a
 *   type-only import of `agent.ts` is erased, so it costs the bundle nothing.
 * @param runId - The run to watch. `undefined` costs nothing, so a page may
 *   pass its state straight through before a run exists.
 * @param options - `api` when the page holds its own client; `intervalMs` to
 *   change the poll interval the stream falls back to.
 * @returns The latest snapshot, the last read's error, and whether the watch
 *   is still going — see {@link UseWorkflowRunResult}.
 *
 * @public
 */
export function useWorkflowRun<R = unknown>(
  runId: string | undefined,
  options: { api?: WorkflowApi; intervalMs?: number } = {},
): UseWorkflowRunResult<R> {
  const { api, intervalMs = DEFAULT_WORKFLOW_POLL_MS } = options;
  const [run, setRun] = useState<WorkflowRun<R> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * Has the watch stopped for a reason the snapshot does not show?
   *
   * Only one such reason exists — an id the agent kept reporting as unknown,
   * past {@link MAX_MISSING_READS} — and it leaves `run` undefined, so `polling`
   * derived from `isTerminal(run)` alone would stay true forever.
   */
  const [stopped, setStopped] = useState(false);

  // The caller's client through a ref, and the lazily-built default behind it —
  // see `_workflow-api-ref.ts` for why neither may be an effect dependency.
  const getClient = useWorkflowApiRef(api);

  useEffect(() => {
    // A new id must not show the previous run's state for one frame, which is
    // what makes the "started, still waiting" moment read as "completed".
    setRun(undefined);
    setError(undefined);
    setStopped(false);
    if (!runId) return;
    const onRun = (next: WorkflowRun<R>): void => {
      setRun(next);
      setError(undefined);
    };
    // The stream first, the poll as its fallback. Both are stopped by the
    // returned teardown, and only one is ever running: `watchRunEvents` hands
    // over exactly once, and does not hand over after the run settled.
    let stopPoll: (() => void) | undefined;
    const stopStream = watchRunEvents<R>(
      getClient,
      runId,
      onRun,
      () => setStopped(true),
      () => {
        stopPoll = pollUntilTerminal<R>(getClient, runId, intervalMs, onRun, setError, () =>
          setStopped(true),
        );
      },
    );
    return () => {
      stopStream();
      stopPoll?.();
    };
    // `getClient` is stable for the component's life (that is the whole point
    // of the ref behind it), so naming it here restarts nothing.
  }, [runId, intervalMs, getClient]);

  return { run, error, polling: runId !== undefined && !stopped && !isTerminal(run) };
}
