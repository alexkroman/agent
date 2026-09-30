// Copyright 2026 the AAI authors. MIT license.
/**
 * `useRouteMutation` — WRITE to one of the agent's own `/api` routes from a
 * component: the writing half of `useRoute`, over `routeFetch`.
 *
 * Every save, delete and connect button on a device-twin page wrote the same
 * nine lines: set a busy flag, call the route, clear the error on success or
 * set it from the thrown message on failure, clear the flag, and re-read the
 * list the write changed. This is those lines once, plus the three things the
 * copies got wrong:
 *
 * - **A write settling after unmount sets no state and calls nothing** — the
 *   page navigated away, and its `reload` would read into a dead component.
 * - **An OLDER write settling after a newer one does not overwrite its
 *   outcome** — each write is numbered, and the error shown is that of the
 *   highest-numbered write to have settled (`useRoute`'s stale-read rule, for
 *   writes, which cannot be dropped the way a read can).
 * - **`busy` names WHICH write is in flight**, not just that one is — a row of
 *   buttons disables the one that was pressed, where a boolean greyed them all.
 *
 * `run` never rejects: a failure is `error` (the route's own `{ error }`
 * sentence when it answered one) and `run` resolves `undefined`.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalSessionCore } from "./context.ts";
import { type RouteMethod, routeFetch } from "./route-fetch.ts";

/**
 * Options for {@link useRouteMutation}.
 *
 * @public
 */
export type UseRouteMutationOptions = {
  /**
   * The `?client=` to send. Default: the session's client
   * (`session.identity.clientId()`, read per write) inside `mountClient()`,
   * none on a page with no session.
   */
  client?: string | undefined;
  /**
   * Called after every write settles, success or failure — a `useRoute`'s
   * `reload`, so the list shows what the write did. Not called after unmount.
   * Read at settle time, so an inline arrow is fine.
   */
  onSettled?: (() => void) | undefined;
};

/**
 * Options for one {@link UseRouteMutationResult.run} call.
 *
 * @public
 */
export type RouteMutationRunOptions = {
  /**
   * What {@link UseRouteMutationResult.busy} names while this write is in
   * flight — the field being saved, the row being deleted. Default:
   * `"<METHOD> <path>"`.
   */
  key?: string | undefined;
};

/**
 * What {@link useRouteMutation} returns.
 *
 * @public
 */
export type UseRouteMutationResult = {
  /**
   * Send one write: `routeFetch(method, path, body, { client })`. Resolves the
   * route's answer, or `undefined` when it failed (the reason is in `error`) —
   * never rejects.
   */
  run: <T = unknown>(
    method: RouteMethod,
    path: string,
    body?: unknown,
    options?: RouteMutationRunOptions,
  ) => Promise<T | undefined>;
  /**
   * The key of the newest write still in flight (see
   * {@link RouteMutationRunOptions.key}), or `undefined` when none is —
   * `busy === "email"` for one field, `busy !== undefined` for any.
   */
  busy: string | undefined;
  /** Why the newest settled write failed — the route's `{ error }` when it said — or `undefined`. */
  error: string | undefined;
  /** Forget `error` — when the reader dismissed it, or edited the field again. */
  clearError: () => void;
};

/**
 * Write to the agent's own routes, with a busy key, the last error and a
 * re-read after — see this module's doc.
 *
 * @example A profile field that saves, then re-reads
 * ```tsx
 * import { useRoute, useRouteMutation } from "@alexkroman1/aai-ui";
 *
 * function Name() {
 *   const { data, reload } = useRoute<{ name: string }>("/profile");
 *   const { run, busy, error } = useRouteMutation({ onSettled: reload });
 *   return (
 *     <form
 *       onSubmit={(e) => {
 *         e.preventDefault();
 *         const name = new FormData(e.currentTarget).get("name");
 *         void run("PUT", "/profile", { name }, { key: "name" });
 *       }}
 *     >
 *       <input name="name" defaultValue={data?.name} disabled={busy === "name"} />
 *       {error && <p role="alert">{error}</p>}
 *     </form>
 *   );
 * }
 * ```
 *
 * @param options - `client` and `onSettled`; see {@link UseRouteMutationOptions}.
 * @returns `run`, the busy key, the last error and `clearError`; see
 *   {@link UseRouteMutationResult}.
 *
 * @public
 */
export function useRouteMutation(options: UseRouteMutationOptions = {}): UseRouteMutationResult {
  const session = useOptionalSessionCore();
  const { client } = options;
  const [inFlight, setInFlight] = useState<readonly { seq: number; key: string }[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  // Read at settle time, so a new inline `onSettled` each render costs nothing.
  const onSettledRef = useRef(options.onSettled);
  onSettledRef.current = options.onSettled;
  // Each write's number, and the newest one to have settled — see the module doc.
  const seqRef = useRef(0);
  const settledRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async <T = unknown>(
      method: RouteMethod,
      path: string,
      body?: unknown,
      runOptions: RouteMutationRunOptions = {},
    ): Promise<T | undefined> => {
      seqRef.current += 1;
      const seq = seqRef.current;
      const key = runOptions.key ?? `${method} ${path}`;
      setInFlight((list) => [...list, { seq, key }]);
      const who = client ?? session?.identity.clientId();
      let answer: T | undefined;
      let failure: string | undefined;
      try {
        answer = await routeFetch<T>(method, path, body, who ? { client: who } : {});
      } catch (err: unknown) {
        failure = errorMessage(err);
      }
      if (!mountedRef.current) return answer;
      setInFlight((list) => list.filter((w) => w.seq !== seq));
      if (seq > settledRef.current) {
        settledRef.current = seq;
        setError(failure);
      }
      onSettledRef.current?.();
      return answer;
    },
    [client, session],
  );

  const clearError = useCallback(() => setError(undefined), []);

  return { run, busy: inFlight.at(-1)?.key, error, clearError };
}
