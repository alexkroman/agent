// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's failure vocabulary: how a request failure is typed, whether it
 * is worth retrying, and how it reads to a user.
 *
 * Its own module because the readers are not the callers. `api.ts` mints
 * these; the gate screens (`gate-card.tsx`, `main.tsx`, `auth.tsx`) and the
 * panes read them, and the busy/broken split below is the one thing both
 * halves have to agree on.
 */

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Should a failed attempt be retried? A 4xx is a real answer from a live
 * server (bad key, missing project) that retrying cannot change — except
 * 408/429, which are the transient kind. Everything else — a rejected fetch
 * (connection refused mid-restart), a timed-out attempt, a 5xx — means the
 * server or sandbox wasn't ready, so the query keeps retrying with backoff
 * and a chat (or an account read) opened during a restart lands once the
 * server is back instead of wedging on the first failure.
 *
 * This is also the busy/broken split the gate screens word themselves from
 * (`loadFailureText`): the same errors that are worth retrying are the ones
 * that say the server is busy rather than something about this user.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return err.status === 408 || err.status === 429;
  }
  return true;
}

/** A query/mutation error as displayable text; undefined when there is none. */
export function errorText(err: unknown): string | undefined {
  if (!err) return;
  return err instanceof Error ? err.message : String(err);
}
