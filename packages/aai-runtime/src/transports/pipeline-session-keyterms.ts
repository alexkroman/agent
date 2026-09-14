// Copyright 2026 the AAI authors. MIT license.
/**
 * The SESSION's own recognizer keyterms — what a tool learned mid-call and
 * asked to bias the recognizer toward, accumulated for the rest of the call.
 *
 * The third of three steering sources, and the only one that can know anything
 * about who is actually on the line: `assemblyAIStt({ keyterms })` is the
 * DEPLOYMENT's list and a `dialog()` state's is the PHASE's, both fixed before
 * the call connects. This one holds the facts a lookup returned.
 *
 * Its own module rather than a few lines in `pipeline-transport.ts` for the
 * ordinary reason — that file sits at 490 of the 500-line cap — and for a
 * better one: the accumulation POLICY is the whole substance here (what
 * duplicate means, what the bound is, which end drops when it is reached), and
 * a policy with three decisions in it wants somewhere to be stated and tested.
 */

/**
 * How many session terms are kept.
 *
 * The service's own cap is 100 and covers BOTH halves, so an unbounded session
 * list would crowd out the vocabulary the deployment shipped — and the session
 * half is written from a tool body, which can run on every turn of a long
 * call. 25 is chosen as a fraction of the service cap rather than measured:
 * the facts worth boosting for one caller are a name, an order or two and a
 * product, and a session wanting more than 25 has stopped describing a caller.
 */
export const SESSION_KEYTERM_LIMIT = 25;

/** The session-scoped keyterm list, as the transport reads and writes it. */
export type SessionKeyterms = {
  /** Add terms. Idempotent: a term already held does not move or repeat. */
  add: (terms: readonly string[]) => void;
  /** The terms, oldest first. */
  current: () => readonly string[];
};

/**
 * Accumulate the session's keyterms.
 *
 * Three decisions, all of them visible in `pipeline-session-keyterms.test.ts`:
 *
 * - **Duplicates are case-insensitive, and the FIRST spelling wins.** A name
 *   arrives from a database field and again from a caller's spelling, and the
 *   two differ only in case; keeping both spends two of the budget's slots on
 *   one fact and tells the recognizer nothing it did not know. First rather
 *   than last so a term already pushed to the wire is not rewritten, which
 *   would cost a wire message for no change in what is biased.
 * - **Blank and whitespace-only terms are dropped here**, so the wire-facing
 *   normalizer is never asked to make sense of `""` — a tool interpolating a
 *   missing field is the likely source, and the empty string biases nothing.
 * - **The OLDEST term drops at the cap.** A later lookup is the more likely to
 *   be relevant to the phase the call is now in, and the alternative (refuse
 *   new terms once full) makes a long call permanently unable to learn the one
 *   fact it is currently failing on.
 */
export function createSessionKeyterms(limit: number = SESSION_KEYTERM_LIMIT): SessionKeyterms {
  const terms: string[] = [];
  const seen = new Set<string>();
  return {
    add(next) {
      for (const raw of next) {
        const term = raw.trim();
        if (term.length === 0) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push(term);
        while (terms.length > limit) {
          const dropped = terms.shift();
          if (dropped !== undefined) seen.delete(dropped.toLowerCase());
        }
      }
    },
    current: () => terms,
  };
}
