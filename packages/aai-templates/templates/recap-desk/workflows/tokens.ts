// Copyright 2026 the AAI authors. MIT license.
/**
 * The hook tokens this desk's body and its tools have to agree on.
 *
 * A hook's token is chosen by the WORKFLOW and typed in by whatever signals it,
 * so it is the one string two files must derive identically — and a template
 * literal written twice is a string that drifts once, silently: the body waits
 * on a token nobody signals, the tool signals a token nobody holds, and the
 * only symptom is `ctx.workflows.signal` answering `false`, which is also what
 * the ordinary "nobody is waiting" case looks like.
 *
 * Hence one exported function per token, imported by both sides. It carries no
 * directive, which is what lets it live under `workflows/` beside the bodies:
 * the WDK builder scans this directory and transforms only what carries one
 * (`transcription-desk/workflows/wav.ts` is the same shape).
 *
 * **A token addresses a run, so it is derived from the SESSION** rather than
 * from anything a caller could name out loud. `ctx.sessionId` keys this call;
 * a real desk keys on the caller's number, and the run's `requestedBy` moves
 * with it.
 */

/** The gate that asks whether the transcript stays on file. */
export function retentionToken(sessionId: string): string {
  return `retention:${sessionId}`;
}
