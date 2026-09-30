// Copyright 2026 the AAI authors. MIT license.
/**
 * `useClientRuns` — the page half of `clientRunsRoutes()` on
 * `@alexkroman1/aai`: the runs going on for this client, polled, with a
 * cancel.
 *
 * `useRoute` over the list route plus `useRouteMutation` over the cancel one,
 * so it inherits both halves' rules — the stale-read drop, data kept through a
 * failed poll, the session's client as `?client=`, no state after unmount —
 * and adds only what every "Running" panel re-wrote: the row type, the cancel
 * URL (`DELETE <path>/<runId>`, the id encoded) and the re-read after it.
 *
 * @module
 */

import type { ClientRun, ClientRunsResponse } from "@alexkroman1/aai";
import { useCallback } from "react";
import { useRoute } from "./use-route.ts";
import { useRouteMutation } from "./use-route-mutation.ts";

/** The default {@link UseClientRunsOptions.pollMs}. */
const DEFAULT_CLIENT_RUNS_POLL_MS = 5000;

/**
 * Options for {@link useClientRuns}.
 *
 * @public
 */
export type UseClientRunsOptions = {
  /** Read the list again every this many ms, while mounted. Default 5000; `0` never. */
  pollMs?: number | undefined;
  /**
   * The `?client=` to send. Default: the session's client inside
   * `mountClient()`, none on a page with no session.
   */
  client?: string | undefined;
};

/**
 * What {@link useClientRuns} returns.
 *
 * @public
 */
export type UseClientRunsResult = {
  /** The client's runs, oldest first — `undefined` until the first read lands. */
  runs: ClientRun[] | undefined;
  /** Why the last read or cancel failed — the route's `{ error }` when it said — or `undefined`. */
  error: string | undefined;
  /** Read the list again now. */
  reload: () => void;
  /**
   * Cancel one run, then re-read the list. Resolves `true` when this call
   * ended it, `false` when it had already finished or the cancel failed (the
   * reason is in `error`). Never rejects.
   */
  cancel: (runId: string) => Promise<boolean>;
  /** The run id whose cancel is in flight, or `undefined` — to disable its button. */
  cancelling: string | undefined;
};

/**
 * The runs going on for this client, from a `clientRunsRoutes()` pair — see
 * this module's doc.
 *
 * @example A "Running" panel with a Cancel on each live reminder
 * ```tsx
 * import { useClientRuns } from "@alexkroman1/aai-ui";
 *
 * function Running() {
 *   const { runs, error, cancel, cancelling } = useClientRuns();
 *   if (!runs) return error ? <p role="alert">{error}</p> : null;
 *   return (
 *     <ul>
 *       {runs.map((r) => (
 *         <li key={r.runId}>
 *           {r.title} — {r.status}
 *           {r.detail && <small>{r.detail}</small>}
 *           {r.status === "running" && (
 *             <button type="button" disabled={cancelling === r.runId} onClick={() => void cancel(r.runId)}>
 *               Cancel
 *             </button>
 *           )}
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 *
 * @param path - The `path` the routes were declared with, without `/api`.
 *   Default `"/tasks"`, `clientRunsRoutes()`' own default.
 * @param options - `pollMs` and `client`; see {@link UseClientRunsOptions}.
 * @returns The rows, the last error, `reload`, `cancel` and the id being
 *   cancelled; see {@link UseClientRunsResult}.
 *
 * @public
 */
export function useClientRuns(
  path = "/tasks",
  options: UseClientRunsOptions = {},
): UseClientRunsResult {
  const { client } = options;
  const pollMs = options.pollMs ?? DEFAULT_CLIENT_RUNS_POLL_MS;
  const list = useRoute<ClientRunsResponse>(path, { pollMs, client });
  const mutation = useRouteMutation({ client, onSettled: list.reload });
  const { run } = mutation;

  const cancel = useCallback(
    async (runId: string): Promise<boolean> => {
      const answer = await run<{ cancelled?: unknown }>(
        "DELETE",
        `${path}/${encodeURIComponent(runId)}`,
        undefined,
        { key: runId },
      );
      return answer?.cancelled === true;
    },
    [run, path],
  );

  return {
    runs: list.data?.runs,
    error: mutation.error ?? list.error,
    reload: list.reload,
    cancel,
    cancelling: mutation.busy,
  };
}
