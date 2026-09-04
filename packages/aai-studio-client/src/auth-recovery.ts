// Copyright 2026 the AAI authors. MIT license.
/**
 * The ONE answer to "the server rejected this bearer".
 *
 * There used to be three call sites and two opposite conclusions. The event
 * stream refreshed (`use-event-stream.ts` → `onAuthFailure`); the account gate
 * refreshed, with a comment explaining at length why signing out there was
 * wrong; and the app's REST queries called `signOut()` with no scope. That last
 * one is the bug the other two were written to avoid: supabase-js runs its
 * refresh ticker only on FOCUSED tabs, so a studio tab left in the background
 * for an hour holds an expired-but-REFRESHABLE access token, and focusing it
 * refetches `projects`, `workspace` and `chat` with that dead bearer. All three
 * 401, and a global `signOut()` revokes the refresh token — ending a session
 * that was still recoverable, and racing supabase-js's own focus refresh on the
 * same event, which the synchronous effect wins.
 *
 * So: refresh first, and sign out only when the refresh fails. That is already
 * `useStudioAuth().refresh`'s stated contract — it drops the stored session
 * locally when `refreshSession` errors, which lands the app back on the sign-in
 * gate — so there is nothing left for a caller to decide.
 */

import { useEffect, useRef } from "react";
import { ApiError } from "./api-error.ts";

/** Is this the server refusing the caller's bearer, rather than anything else? */
function isAuthRejection(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * The first of these errors that is a rejected bearer, or `undefined`.
 *
 * One check over every query rather than a copy-pasted effect per query — and
 * the ERROR is returned rather than a boolean so the effect below can key on
 * its identity: each rejection is a distinct `ApiError`, so a second one after
 * a failed recovery re-arms the handler while a re-render does not.
 */
export function authRejection(...errors: readonly unknown[]): unknown {
  return errors.find(isAuthRejection);
}

/**
 * Recover from a rejected bearer, at most `maxAttempts` times.
 *
 * The cap is what stops a server that will 401 a *refreshable* token — a
 * different Supabase project, a JWT-secret mismatch, clock skew — from becoming
 * an unbounded refresh+refetch loop behind a screen that says nothing.
 * `onExhausted` is the terminal state: somewhere the user can act, rather than
 * a wait with no end.
 */
export function useAuthRecovery(
  rejection: unknown,
  refreshAuth: () => Promise<void>,
  opts: { maxAttempts?: number; onExhausted?: () => void } = {},
): void {
  const { maxAttempts = 2, onExhausted } = opts;
  // The rejection this hook has already acted on. Guards against React 19's
  // StrictMode double-invoking the effect (which would otherwise burn two
  // attempts on one rejection) as well as ordinary re-renders.
  const handled = useRef<unknown>(null);
  const attempts = useRef(0);
  const exhaustedRef = useRef(onExhausted);
  exhaustedRef.current = onExhausted;

  useEffect(() => {
    if (rejection == null || handled.current === rejection) return;
    handled.current = rejection;
    if (attempts.current >= maxAttempts) {
      exhaustedRef.current?.();
      return;
    }
    attempts.current += 1;
    void refreshAuth();
  }, [rejection, refreshAuth, maxAttempts]);
}
