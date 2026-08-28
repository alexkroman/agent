// Copyright 2026 the AAI authors. MIT license.
/**
 * What a socket's CLOSE means to the caller.
 *
 * One decision, in its own module because `session-core.ts` is at its length cap
 * and because the decision is worth reading on its own: which endings are
 * ordinary, and which carry something the user has to be told.
 *
 * @module
 */

/**
 * The one close code whose reason is never worth showing.
 *
 * `1000` is a deliberate, successful close — the caller hanging up, or the
 * server retiring a session it finished with. A browser reports a socket that
 * closed with no status as `1005`, which carries no reason either, so testing
 * for text is enough to exclude it.
 */
const NORMAL_CLOSE = 1000;

/**
 * What to REPORT for a socket that closed for good, or null for an ordinary end.
 *
 * A sentence the peer wrote beats one this file invented. A guest that cannot
 * build its runtime closes 1011 with the remedy already in it — "Anthropic LLM:
 * missing API key. Set ANTHROPIC_API_KEY in the agent env." — and this handler
 * used to discard `event.reason` entirely, so the one thing a misconfigured
 * deployment needed to be told surfaced as "WebSocket connection error", or as a
 * plain disconnect with nothing at all. Measured against a deployed agent with no
 * provider key.
 *
 * A NORMAL close carries no reason worth showing (1000 is the caller hanging up
 * or the server retiring a finished session; a browser reports a status-less
 * close as 1005, which has no reason either), so the two ordinary endings are
 * untouched.
 */
export function closeFailure(event: CloseEvent, socketErrored: boolean): string | null {
  const refusal = event.reason.trim();
  if (refusal !== "" && event.code !== NORMAL_CLOSE) return refusal;
  return socketErrored ? "WebSocket connection error" : null;
}
