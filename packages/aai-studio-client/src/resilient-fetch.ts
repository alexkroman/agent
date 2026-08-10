// Copyright 2026 the AAI authors. MIT license.
/**
 * The chat transport's fetch wrapper: name the ways a turn can fail against
 * the project's sandbox, so that the layer which owns the turn can take the
 * one recovery action there is — re-broker, and send it again
 * (sandbox-transport.ts).
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
 *   killed, evicted, or its host restarted). This is the common case, and
 *   the one an idle-evicted sandbox produces.
 *
 * All three become a {@link StaleSandboxError}, and it is THROWN rather than
 * reported through a callback because the recovery is not something a request
 * can do to itself: the replacement sandbox has a different origin AND a
 * different token, so only the caller holding the turn can re-aim it. The
 * older shape did report through a callback and hand the failure back, and it
 * recovered nothing — the re-brokered lease landed in the query cache while
 * the transport went on posting to the dead origin, so the first message to a
 * spun-down sandbox failed, every retype failed the same way, and only a page
 * reload fixed it.
 *
 * The exception is a user abort. The composer's Stop button aborts the SSE
 * fetch, which is indistinguishable from a network failure at the promise
 * level — reading it as staleness would respawn a sandbox on every Stop.
 *
 * Account-level 401s still sign the user out; they surface on the PLATFORM's
 * REST queries, which go through `api.ts` and are handled in `app.tsx`.
 */

/**
 * The sandbox this request was aimed at is gone, replaced, or no longer
 * accepts our token — the one failure a re-broker fixes.
 *
 * The message is user-facing: it is what the panel renders when the retry on
 * a fresh lease fails too (the AI SDK surfaces a thrown error as
 * `error.message`), and the browser's own wording for the common case —
 * "Failed to fetch" — reads as a broken page rather than a sandbox that went
 * to sleep while the tab sat open.
 *
 * `reason` keeps the distinction the single message flattens: `unreachable`
 * means nothing answered at all (the sandbox is gone), `refused` means a live
 * guest turned us away (401/409). The recovery is identical, so nothing
 * branches on it — it is what a report of this failure has to say to be worth
 * reading.
 */
export class StaleSandboxError extends Error {
  readonly reason: "unreachable" | "refused";
  constructor(reason: "unreachable" | "refused", options?: ErrorOptions) {
    super("Lost the connection to the project's sandbox. Send again in a moment.", options);
    this.name = "StaleSandboxError";
    this.reason = reason;
  }
}

/**
 * The guest refuses a second concurrent turn (see `createTurnGate` in
 * aai-guest/studio-turn-stream.ts): a project has ONE sandbox, and each tab
 * posts its own whole-conversation view, so interleaving two turns raced the
 * workspace edits and the loser's turn vanished from the stored conversation.
 */
export const TURN_IN_FLIGHT_STATUS = 423;

/**
 * What the user sees when another tab holds the turn. The AI SDK surfaces a
 * non-2xx as `new Error(await response.text())`, so without this the panel
 * would render the raw JSON body — and the queue's error handling hands their
 * typed follow-up back to the composer, so waiting costs them nothing.
 */
export const TURN_IN_FLIGHT_MESSAGE =
  "This project is already working in another tab or window. Wait for that turn to finish, then send again.";

/** Did this rejection come from the caller aborting, rather than a dead peer? */
function isAbort(err: unknown, init?: RequestInit): boolean {
  if (init?.signal?.aborted === true) return true;
  return err instanceof Error && err.name === "AbortError";
}

export type ResilientFetchOptions = {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
};

export function createResilientFetch(options: ResilientFetchOptions = {}): typeof fetch {
  const impl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let res: Response;
    try {
      res = await impl(input, init);
    } catch (err) {
      // A dead sandbox and a user Stop look identical here; only the second
      // must be left alone.
      if (isAbort(err, init)) throw err;
      throw new StaleSandboxError("unreachable", { cause: err });
    }
    // A busy guest is HEALTHY — re-brokering would spawn nothing useful and
    // reset the session other tabs are using. It is the one rejection from
    // this surface that must not be read as staleness.
    if (res.status === TURN_IN_FLIGHT_STATUS) throw new Error(TURN_IN_FLIGHT_MESSAGE);
    if (res.status === 401 || res.status === 409) throw new StaleSandboxError("refused");
    return res;
  }) as typeof fetch;
}
