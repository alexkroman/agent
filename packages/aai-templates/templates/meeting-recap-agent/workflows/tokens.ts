// Copyright 2026 the AAI authors. MIT license.
/**
 * The two hook tokens this desk's body and its callers have to agree on,
 * derived in one place so the body cannot wait on a string nobody signals.
 *
 * Both are derived from the SESSION rather than from anything a caller could
 * name out loud: a token addresses a run. `ctx.sessionId` keys this call; a
 * real desk keys on the caller's number, and the run's `requestedBy` moves
 * with it. A token is held for the life of its run, so deriving it from the
 * session is what makes a second recap in the same call legal — `request_recap`
 * allows one LIVE run per caller, which is the invariant that keeps this safe.
 */

/** The gate that asks whether the transcript stays on file; `keep_transcript` signals it. */
export function retentionToken(sessionId: string): string {
  return `retention:${sessionId}`;
}

/** The nudge that says a transcript is ready; ASSEMBLYAI posts to the URL minted for it. */
export function transcriptToken(sessionId: string): string {
  return `transcript:${sessionId}`;
}
