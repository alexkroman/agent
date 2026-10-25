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
 * The poll is `repeatUntil`'s loop (`_repeat-until.ts`), re-armed from the
 * SETTLED read rather than on an interval — a slow route would otherwise
 * stack overlapping reads — and stopped by `until`, by a change of what is
 * read, and by unmount, with the in-flight request aborted on the same signal.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { createEpoch, type Epoch } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { repeatUntil } from "./_repeat-until.ts";
import { useOptionalSessionCore } from "./context.ts";
import { routeFetch } from "./route-fetch.ts";

/**
 * Options for {@link useRoute}.
 *
 * @input
 * @public
 */
export type UseRouteOptions<T = unknown> = {
  /** Read again every this many ms, while mounted. Default: never. */
  pollMs?: number | undefined;
  /**
   * Stop polling once an answer satisfies this — a call that is over, a job
   * that has settled. Judged on every read, the first included; `reload()`
   * still works afterwards. Read per request, so an inline function is fine.
   */
  until?: ((value: T) => boolean) | undefined;
  /**
   * The `?client=` to send. Default: the session's client
   * (`session.identity.clientId()`, read per request) inside `mountClient()`,
   * none on a page with no session.
   */
  client?: string | undefined;
  /**
   * Extra request headers, as `routeFetch`'s — an `authorization` for a route
   * behind `apiKeyRoute`. Read per request, so an inline object does not
   * re-trigger the read.
   */
  headers?: Readonly<Record<string, string>> | undefined;
};

/**
 * What {@link useRoute} returns.
 *
 * @sealed
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
 * `pollMs` until `until` says so — see this module's doc.
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
 * @example A call followed until it is over
 * ```tsx
 * import { useRoute } from "@alexkroman1/aai-ui";
 *
 * type Call = { status: string; transcript: { role: string; text: string }[] };
 *
 * function LiveCall({ id }: { id: string }) {
 *   const { data } = useRoute<Call>(`/calls/${id}`, {
 *     pollMs: 2000,
 *     until: (call) => call.status === "completed",
 *   });
 *   return <ol>{data?.transcript.map((line, i) => <li key={String(i)}>{line.text}</li>)}</ol>;
 * }
 * ```
 *
 * @typeParam T - The shape the route answers. Not checked.
 * @param path - The route's path as declared, without `/api`. `null` reads nothing.
 * @param options - `pollMs`, `until`, `client` and `headers`; see {@link UseRouteOptions}.
 * @returns The answer, the last error, and `reload`; see {@link UseRouteResult}.
 *
 * @public
 */
export function useRoute<T = unknown>(
  path: string | null,
  options: UseRouteOptions<T> = {},
): UseRouteResult<T> {
  const session = useOptionalSessionCore();
  const { pollMs, client } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);

  // Read per request rather than named as dependencies: an inline `until` or
  // `headers` literal is a new identity every render, and a read re-armed on
  // every render is a read that never settles. See `_submission-state.ts`
  // for the same pattern.
  const perRequest = useRef({ until: options.until, headers: options.headers });
  perRequest.current = { until: options.until, headers: options.headers };

  // Bumped by each read as it starts and by the unmount — see the module doc.
  const epochRef = useRef<Epoch | undefined>(undefined);
  epochRef.current ??= createEpoch();
  const epoch = epochRef.current;

  /**
   * One read. Resolves whether the poll (if any) is FINISHED: `until` was
   * satisfied. A read that was superseded by a newer one (a `reload()`, or the
   * unmount's bump) answers `false` — its ANSWER is nobody's, but the poll is
   * still owed its next tick: `true` here would stop `repeatUntil` for good on
   * the first reload during a poll. The unmount is what stops the loop, through
   * its own `stop()`, and a loop whose signal is aborted never re-arms.
   */
  const read = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      if (path === null) return true;
      epoch.bump();
      const mine = epoch.current();
      setLoading(true);
      const { until, headers } = perRequest.current;
      try {
        const answer = await routeFetch<T>("GET", path, undefined, {
          ...omitUndefined({ client: client ?? session?.identity.clientId(), headers, signal }),
        });
        if (!epoch.isCurrent(mine)) return false;
        setData(answer);
        setError(undefined);
        setLoading(false);
        return until?.(answer) === true;
      } catch (err: unknown) {
        if (!epoch.isCurrent(mine)) return false;
        setError(errorMessage(err));
        setLoading(false);
        return false;
      }
    },
    [path, client, session, epoch],
  );

  const reload = useCallback((): void => {
    void read();
  }, [read]);

  useEffect(() => {
    // The poll's first tick IS the mount read, so a polled route is not read
    // twice at mount.
    const stop = pollMs ? repeatUntil(pollMs, read) : undefined;
    if (!stop) void read();
    return () => {
      stop?.();
      epoch.bump();
    };
  }, [read, pollMs, epoch]);

  return { data, error, loading, reload };
}
