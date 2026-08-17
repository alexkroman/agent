// Copyright 2026 the AAI authors. MIT license.
/**
 * Did this session's resume actually FIND anything?
 *
 * `?sessionId=<id>` is a claim, not a fact. `parseWsUpgradeParams` suppresses the
 * greeting on the id's mere PRESENCE — it has nothing else to go on at upgrade
 * time — and the two things a resume recovers are looked up later, inside the
 * `session.start()` window: the event log (`attachSessionStream`) and the slot
 * values (`attachSessionState`). So a resume presenting an id whose state is gone
 * used to produce the worst session available: socket up, `config` sent, mic
 * live, no history restored, and the greeting suppressed — **an agent that is
 * connected and silent**, with nothing on either side saying why.
 *
 * That is not a rare state now that a page RELOAD resumes by default
 * (`aai-ui/session-resume-store.ts`): a reload past `SESSION_RESUME_GRACE_MS`,
 * or after an agent guest self-exited on idle, presents a perfectly well-formed
 * id that names nothing. Before the reload change it took a hand-wired client to
 * reach at all, which is why it went unnoticed.
 *
 * This is the one bit of state that closes it: the two lookups REPORT what they
 * recovered, and the greeting decision reads the answer instead of the claim.
 * A resume that found nothing is a new session, and a new session greets.
 *
 * Deliberately not a general-purpose primitive. It is a latch with one writer
 * per source and one reader, and the reason it is a named module rather than two
 * lines in `runtime.ts` is that the ORDER it depends on is invisible at the call
 * sites: the transport is built before either lookup runs, so the greeting has to
 * read this LATE (see `SkipGreeting` in `transports/types.ts`) or it reads
 * `false` every time and the whole thing silently does nothing.
 */

import { type SkipGreeting, shouldSkipGreeting } from "./transports/types.ts";

/** What a resume recovered, written by the lookups and read by the greeting. */
export type ResumeFindings = {
  /**
   * Record that this resume recovered something — restored history, or hydrated
   * slot state. Idempotent and monotonic: either source is sufficient, and
   * neither can un-say it.
   */
  record(): void;
  /** Whether anything was recovered. Read when the greeting would fire. */
  any(): boolean;
};

/**
 * A fresh latch for one session.
 *
 * @internal
 */
export function createResumeFindings(): ResumeFindings {
  let found = false;
  return {
    record: () => {
      found = true;
    },
    any: () => found,
  };
}

/**
 * Turn a resume CLAIM into the greeting decision, resolved when the greeting
 * would fire.
 *
 * `?sessionId=` suppresses the greeting on the id's mere PRESENCE, which is all
 * the upgrade can see (`parseWsUpgradeParams`). So an id naming a session whose
 * state is gone — a reload past `SESSION_RESUME_GRACE_MS`, a guest that
 * self-exited on idle — produced a connected, mic-live, historyless session that
 * never spoke. This is the seam that makes the suppression conditional on the
 * lookups having found something.
 *
 * Two properties:
 *
 * - **A `resume=1` with NO id is left alone.** There is nothing to look up, and
 *   the caller has asserted it already heard the opening line; second-guessing
 *   that would re-greet a legitimate reconnect. Only a session that presented an
 *   id has a claim to check.
 * - **It returns a THUNK, and must.** The transport is constructed before either
 *   lookup runs (both are inside the `session.start()` window), so a value
 *   computed here would read `false` every time and the whole mechanism would
 *   silently do nothing. See {@link SkipGreeting}.
 *
 * @internal
 */
export function resolveSkipGreeting(
  /** What the socket claimed — `?sessionId=` or `resume=1`. */
  claimed: SkipGreeting | undefined,
  /** Whether an ID was presented, i.e. whether there is a claim to CHECK. */
  resumed: boolean | undefined,
  findings: ResumeFindings,
): () => boolean {
  // The three inputs by name rather than a `sessionOpts` bag: this is the one
  // place the two questions ("did the caller claim a resume" and "did the resume
  // find anything") are combined, and a wider parameter would let the next
  // reader think it had the whole session to work with.
  return () => shouldSkipGreeting(claimed) && (resumed !== true || findings.any());
}
