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
 * (`transcription-workflow/workflows/wav.ts` is the same shape).
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

/**
 * The nudge that says a transcript is ready.
 *
 * The other end of this one is not a tool but ASSEMBLYAI: `request_recap` mints
 * `ctx.workflows.publicWebhookUrl(transcriptToken(ctx.sessionId))` and hands it
 * to the provider as `webhook_url`, and the provider's `POST` to that URL is
 * what resolves the body's wait. So the two sides that have to agree are a file
 * in this template and a third party on the public internet — which is the
 * strongest case there is for deriving the string in one place.
 *
 * **A token is held for the life of its run and given back only when the run
 * goes TERMINAL**, so deriving it from the session is what makes a second recap
 * in the same call legal: `claimHook` refuses a token another run still holds,
 * and a refusal is not a suspend, so it would unwind the saga and delete the
 * transcript the run was waiting for. `request_recap` allows one LIVE run per
 * caller, which is the invariant that keeps this safe.
 */
export function transcriptToken(sessionId: string): string {
  return `transcript:${sessionId}`;
}
