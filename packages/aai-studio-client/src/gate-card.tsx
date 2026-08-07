// Copyright 2026 the AAI authors. MIT license.
/**
 * The pre-app screens' shell, and the one card every gate needs when it
 * cannot get what it needs: what went wrong, and the single way out.
 *
 * A gate has no app behind it to degrade into — it either resolves or it is
 * the whole page — so "still waiting" must never be the terminal state. Every
 * failure here ends in a retry the user can press, bar the one kind that
 * trying again cannot change.
 */

import { ApiError, errorText, isTransientError } from "./api.ts";
import logoUrl from "./assets/assemblyai-logomark.svg";

export function GateCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-cream">
      <div className="flex w-[420px] flex-col gap-3.5 rounded-lg border border-line bg-panel p-10 shadow-sm">
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
          <span className="font-serif text-[16px]">AssemblyAI Build</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export type GateProblemProps = {
  message: string;
  /** The server's own words, when it managed to say any. */
  detail?: string | undefined;
  /** An automatic attempt is already in flight. */
  retrying?: boolean | undefined;
  onRetry?: (() => void) | undefined;
};

/**
 * A gate that could not load: the problem, the server's own words for it when
 * there were any, and the retry.
 *
 * `retrying` is worth saying rather than hiding: the query layer retries
 * transient failures with backoff, and a live "Try again" during that window
 * would be a no-op (TanStack Query folds a `refetch` into the in-flight retry
 * rather than starting a fresh attempt), so a button that looked pressable
 * would do nothing at all.
 *
 * `onRetry` is optional because one failure really is terminal: a server that
 * answers "sign-in is not configured here" will answer that again, and a
 * button offering to re-ask is a false promise.
 */
export function GateProblem({ message, detail, retrying, onRetry }: GateProblemProps) {
  return (
    <GateCard>
      <p className="m-0 text-[15px] text-err">{message}</p>
      {detail && <p className="m-0 text-[13px] text-subtle">{detail}</p>}
      {onRetry && (
        // Primary, unlike the plain button this replaced: it is the only
        // control on the screen, and `btn-primary` is the variant that has a
        // disabled FACE — a bare `.btn` only changes the cursor, so the
        // retrying state was invisible to anyone not hovering it.
        <button
          type="button"
          className="btn btn-primary h-10 self-start px-5"
          disabled={retrying === true}
          onClick={() => onRetry()}
        >
          {retrying === true ? "Retrying…" : "Try again"}
        </button>
      )}
    </GateCard>
  );
}

/** What the user is told when the app's own server won't answer. */
export const SERVER_BUSY_MESSAGE =
  "AssemblyAI Build is busy right now and couldn't finish loading.";

/**
 * Wording for a failed load, split by whether trying again can help.
 *
 * A transient failure (a 5xx, a rejected fetch, an attempt that ran out of
 * time) says nothing about this user or this account: the server is
 * restarting, saturated, or unreachable, and the honest thing to report is
 * that the app is busy. Only its own answer is quoted as detail — a timeout
 * or a refused connection has no message worth showing, and "signal timed
 * out" reads as a bug in the page rather than load on the server.
 *
 * Anything else is a real refusal that will refuse again (`definite` names
 * what could not be loaded), so it is quoted verbatim: that text is the only
 * thing that distinguishes a rejected key from a missing account.
 */
export function loadFailureText(
  error: unknown,
  definite: string,
): { message: string; detail?: string } {
  if (!isTransientError(error)) {
    // An error carrying an EMPTY message is as useless as no error at all,
    // and left to itself would render as a dangling colon.
    const said = errorText(error);
    return { message: `${definite}: ${said ? said : "unknown error"}` };
  }
  const detail = error instanceof ApiError ? errorText(error) : undefined;
  return { message: SERVER_BUSY_MESSAGE, ...(detail !== undefined && { detail }) };
}

/** The slice of a TanStack query state a gate screen reads. */
export type GateQueryState = {
  error: unknown;
  failureReason: unknown;
  isFetching: boolean;
  refetch: () => void;
};

/**
 * Why the last attempt failed, whether or not the query has given up yet.
 *
 * `error` is only set once the retries are exhausted; until then the failure
 * lives in `failureReason` and `error` stays null. So a gate that reads
 * `error` alone cannot tell a retry round from a first, still-hopeful
 * attempt — which is exactly how the studio sat on "Loading…" through the
 * whole backoff and then some, with a failing server behind it.
 */
export function queryFailure(query: Pick<GateQueryState, "error" | "failureReason">): unknown {
  return query.error ?? query.failureReason;
}

/**
 * What a gate should show for a query that has produced no data: `null` while
 * the first attempt is still outstanding (the caller's own "Loading…"), else
 * the {@link GateProblem} to render instead.
 *
 * The failure is reported as soon as ONE attempt fails, rather than when the
 * query gives up. From the user's side the retries and the original request
 * are the same unexplained wait, and the automatic ones keep running behind
 * the card — so whichever lands first, a retry or their click, opens the app.
 */
export function gateProblem(query: GateQueryState, definite: string): GateProblemProps | null {
  const failure = queryFailure(query);
  if (failure == null) return null;
  return {
    ...loadFailureText(failure, definite),
    retrying: query.isFetching,
    onRetry: () => query.refetch(),
  };
}
