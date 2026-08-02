// Copyright 2026 the AAI authors. MIT license.
/**
 * The chat transport's fetch wrapper: translate the ways a turn can fail
 * into the two recovery actions the app can take — re-authenticate, or
 * re-broker the sandbox.
 *
 * Chat turns stream DIRECTLY to the project's guest sandbox, so the endpoint
 * is a lease on a process that can die, not a durable URL. There are two
 * distinct signals for "this sandbox is gone" and only one of them is an
 * HTTP response:
 *
 * - **409** — a live server telling us the sandbox was replaced under us.
 * - **A rejected fetch** — nothing is listening at all (the guest was
 *   killed, evicted, or its host restarted). This is the common case and the
 *   one that used to be missed: a wrapper that only inspected `res.status`
 *   never ran its checks, so the tab sat on "Failed to fetch" through every
 *   subsequent message until the user reloaded by hand.
 *
 * The exception is a user abort. The composer's Stop button aborts the SSE
 * fetch, which is indistinguishable from a network failure at the promise
 * level — re-brokering there would respawn a sandbox on every Stop.
 */

export type ResilientFetchOptions = {
  /** The caller's key was rejected (HTTP 401). */
  onUnauthorized: () => void;
  /** The sandbox is gone or replaced — re-broker a session. */
  onStale: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** Did this rejection come from the caller aborting, rather than a dead peer? */
function isAbort(err: unknown, init?: RequestInit): boolean {
  if (init?.signal?.aborted === true) return true;
  return err instanceof Error && err.name === "AbortError";
}

export function createResilientFetch(options: ResilientFetchOptions): typeof fetch {
  const { onUnauthorized, onStale } = options;
  const impl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let res: Response;
    try {
      res = await impl(input, init);
    } catch (err) {
      // A dead sandbox and a user Stop look identical here; only the second
      // must be left alone.
      if (!isAbort(err, init)) onStale();
      throw err;
    }
    if (res.status === 401) onUnauthorized();
    if (res.status === 409) onStale();
    return res;
  }) as typeof fetch;
}
