// Copyright 2026 the AAI authors. MIT license.
/**
 * `useRoute` — read one of the agent's own `/api` routes into a component, and
 * again on demand or on a poll. The reading half of `routeFetch`.
 *
 * What a hand-written `useEffect` + `fetch` got wrong here: a slow earlier read
 * overwriting a newer one (each read carries an epoch, and a stale one is
 * dropped — `useWorkflowRuns`' rule), a read landing after unmount, and a
 * failure rendered as an empty answer. `data` is KEPT through a failed re-read,
 * so a poll that hiccups does not blank the panel; `error` says it is stale.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { createEpoch, type Epoch } from "@alexkroman1/aai/internal";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalSessionCore } from "./context.ts";
import { routeFetch } from "./route-fetch.ts";

/**
 * Options for {@link useRoute}.
 *
 * @public
 */
export type UseRouteOptions = {
  /** Read again every this many ms, while mounted. Default: never. */
  pollMs?: number | undefined;
  /**
   * The `?client=` to send. Default: the session's client
   * (`session.identity.clientId()`, read per request) inside `mountClient()`,
   * none on a page with no session.
   */
  client?: string | undefined;
};

/**
 * What {@link useRoute} returns.
 *
 * @public
 */
export type UseRouteResult<T> = {
  /** The last answer, kept through a failed re-read. `undefined` until the first. */
  data: T | undefined;
  /** Why the LAST read failed — the route's `{ error }` when it said — or `undefined`. */
  error: string | undefined;
  /** Whether a read is in flight. */
  loading: boolean;
  /** Read again now — after a write, say. */
  reload: () => void;
};

/**
 * `GET` one of the agent's own routes, on mount, on `reload()` and every
 * `pollMs` — see this module's doc.
 *
 * @example A list that re-reads after each delete
 * ```tsx
 * import { routeFetch, useClientId, useRoute } from "@alexkroman1/aai-ui";
 *
 * type Memory = { id: string; text: string };
 *
 * function Memories() {
 *   const client = useClientId();
 *   const { data, error, reload } = useRoute<{ memories: Memory[] }>("/memories");
 *   if (error) return <p role="alert">{error}</p>;
 *   return (
 *     <ul>
 *       {data?.memories.map((m) => (
 *         <li key={m.id}>
 *           {m.text}
 *           <button
 *             type="button"
 *             onClick={() => void routeFetch("DELETE", `/memories/${m.id}`, undefined, { client }).then(reload)}
 *           >
 *             Forget
 *           </button>
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 *
 * @typeParam T - The shape the route answers. Not checked.
 * @param path - The route's path as declared, without `/api`. `null` reads nothing.
 * @param options - `pollMs` and `client`; see {@link UseRouteOptions}.
 * @returns The answer, the last error, and `reload`; see {@link UseRouteResult}.
 *
 * @public
 */
export function useRoute<T = unknown>(
  path: string | null,
  options: UseRouteOptions = {},
): UseRouteResult<T> {
  const session = useOptionalSessionCore();
  const { pollMs, client } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);

  // Bumped by each read as it starts and by the unmount — see the module doc.
  const epochRef = useRef<Epoch | undefined>(undefined);
  epochRef.current ??= createEpoch();
  const epoch = epochRef.current;

  const reload = useCallback((): void => {
    if (path === null) return;
    epoch.bump();
    const mine = epoch.current();
    setLoading(true);
    const who = client ?? session?.identity.clientId();
    routeFetch<T>("GET", path, undefined, who ? { client: who } : {})
      .then((answer) => {
        if (!epoch.isCurrent(mine)) return;
        setData(answer);
        setError(undefined);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!epoch.isCurrent(mine)) return;
        setError(errorMessage(err));
        setLoading(false);
      });
  }, [path, client, session, epoch]);

  useEffect(() => {
    reload();
    const timer = pollMs ? setInterval(reload, pollMs) : undefined;
    return () => {
      clearInterval(timer);
      epoch.bump();
    };
  }, [reload, pollMs, epoch]);

  return { data, error, loading, reload };
}
