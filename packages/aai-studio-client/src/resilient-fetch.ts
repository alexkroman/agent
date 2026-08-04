// Copyright 2026 the AAI authors. MIT license.
/**
 * The chat transport's fetch wrapper: translate the ways a turn can fail
 * into the one recovery action the app can take — re-broker the sandbox.
 *
 * Chat turns stream DIRECTLY to the project's guest sandbox, so the endpoint
 * is a lease on a process that can die, not a durable URL. Three signals say
 * "this lease is no good", and only two of them are HTTP responses:
 *
 * - **409** — a live guest telling us it holds no session for us.
 * - **401** — a live guest rejecting our bearer. On THIS surface that can
 *   only mean a stale session token: the guest compares against the
 *   broker-minted per-session `chatToken` and never sees an account
 *   credential, so 401 here says nothing about who the user is. Mapping it
 *   to "re-authenticate" signed the user out of the studio outright — a
 *   second tab on the same project was enough, back when the broker
 *   re-minted the token on every call.
 * - **A rejected fetch** — nothing is listening at all (the guest was
 *   killed, evicted, or its host restarted). This is the common case and the
 *   one that used to be missed: a wrapper that only inspected `res.status`
 *   never ran its checks, so the tab sat on "Failed to fetch" through every
 *   subsequent message until the user reloaded by hand.
 *
 * The exception is a user abort. The composer's Stop button aborts the SSE
 * fetch, which is indistinguishable from a network failure at the promise
 * level — re-brokering there would respawn a sandbox on every Stop.
 *
 * Account-level 401s still sign the user out; they surface on the PLATFORM's
 * REST queries, which go through `api.ts` and are handled in `app.tsx`.
 */

export type ResilientFetchOptions = {
  /** The sandbox is gone, replaced, or no longer accepts our token. */
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
  const { onStale } = options;
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
    if (res.status === 401 || res.status === 409) onStale();
    return res;
  }) as typeof fetch;
}
