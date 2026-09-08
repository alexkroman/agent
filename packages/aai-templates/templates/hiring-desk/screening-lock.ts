/**
 * One screening at a time per call.
 *
 * **Every expensive tool here is a READ, a fan-out, and a WRITE of the whole
 * table** — `screen_candidates` and `rescore_with_feedback` score twelve
 * candidates between the read and the write, `proceed_to_emails` writes twelve
 * emails — and the LLM loop runs a step's tool calls CONCURRENTLY, so two of
 * them interleave at the first `await`. Both failures are real and neither is
 * visible afterwards:
 *
 * - Two screenings issue twenty-four evaluations and the slower one's table
 *   overwrites the faster one's, so the ranking the caller was read is not the
 *   ranking the desk now holds.
 * - Two re-scores both read `rounds: 0` and both write `rounds: 1`. A round of
 *   feedback the caller was charged twelve model calls for disappears, and
 *   `MAX_FEEDBACK_ROUNDS` stops bounding what it was written to bound.
 *
 * `createKeyedLock` is the SDK's primitive for exactly this — "serialize the
 * async work touching one entity" — and the entity is the SESSION: the key is
 * `ctx.sessionId`, the same identity `hiringSlot` is keyed by, so two hiring
 * managers screening at once never wait on each other. The READ tools
 * (`candidate_details`, `read_email`, `screening_status`) take no lock and need
 * none: their bodies are synchronous, so there is no `await` to interleave at.
 *
 * **Its own module rather than `shared.ts`** because the browser half imports
 * that file for the view, and a lock is host machinery: nothing `client.tsx`
 * pulls in should be able to reach it.
 */

import { createKeyedLock, type KeyedLock, type SlotHolder, withLock } from "@alexkroman1/aai";

/** One entry per session that is currently screening; dropped when it drains. */
const screeningLock: KeyedLock = createKeyedLock();

/**
 * Hold this call's screening lock while `run` reads the slot, spends the model
 * and writes back.
 *
 * Takes a {@link SlotHolder} rather than the whole `ToolContext` to say what
 * the key has to be: the identity the slot is keyed by, and nothing else about
 * the tool call.
 */
export function withScreening<T>(ctx: SlotHolder, run: () => Promise<T>): Promise<T> {
  return withLock(screeningLock, ctx.sessionId, run);
}

/** Sessions currently screening or queued behind one — the lock's own count,
 *  which a spec reads to assert the entry is dropped once the chain drains. */
export function screeningsInFlight(): number {
  return screeningLock.size;
}
