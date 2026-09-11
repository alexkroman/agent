// Copyright 2026 the AAI authors. MIT license.
/**
 * Keyterm normalization — the service's two hard limits and the three
 * best-practice rules, applied ONCE, host-side, before a list reaches the wire.
 *
 * AssemblyAI's streaming keyterms prompt takes at most **100 terms of at most
 * 50 characters each**; a term over 50 characters is silently ignored by the
 * service, and a list over 100 terms is an ERROR that fails the whole connect.
 * So an agent whose keyterm list grows past the cap — a product catalogue is
 * exactly the list that does — would stop opening sessions at all, having
 * changed nothing but a data file. Trimming here turns that into a warning and
 * a shorter list.
 *
 * The three rules that are not limits come from AssemblyAI's own guidance
 * (`/streaming/prompting-and-keyterms`) plus Vapi's published custom-keyword
 * list, which agree: **uncommon words and proper nouns only, no duplicates,
 * and the exact spelling and casing you want in the transcript.** Only the
 * middle one is mechanizable, so it is the one enforced — a duplicate spends a
 * slot against the 100 cap and boosts nothing twice. The other two are
 * judgement about a specific vocabulary and belong in the doc of whatever
 * declares the list.
 *
 * **Casing is preserved and duplicates are detected case-INSENSITIVELY**, which
 * is the only combination that honours both rules at once: `"Acme Rewards"` and
 * `"acme rewards"` are one term competing for one slot, and the one kept is the
 * FIRST, because an author writes the spelling they want to read first and a
 * later stray-cased copy is the accident.
 */

/** Most keyterms one streaming session accepts. Over this the connect FAILS. */
export const MAX_KEYTERMS = 100;

/** Longest one keyterm may be. Over this the service ignores the term. */
export const MAX_KEYTERM_CHARS = 50;

/** Why {@link normalizeKeyterms} left a term out. */
export type KeytermDropReason = "empty" | "too-long" | "duplicate" | "over-cap";

/** One term that did not make it onto the wire, and why. */
export interface KeytermDrop {
  readonly term: string;
  readonly reason: KeytermDropReason;
}

/** The list as it goes on the wire, plus what was left out of it. */
export interface NormalizedKeyterms {
  /** At most {@link MAX_KEYTERMS} terms, each at most {@link MAX_KEYTERM_CHARS}. */
  readonly terms: readonly string[];
  /** Everything dropped, in declaration order, each with its reason. */
  readonly dropped: readonly KeytermDrop[];
}

/**
 * Trim, de-duplicate and cap a declared keyterm list.
 *
 * Total: every input term appears in exactly one of `terms` and `dropped`, so
 * a caller can report what it is not sending without re-deriving the rules.
 */
export function normalizeKeyterms(terms: readonly string[]): NormalizedKeyterms {
  const kept: string[] = [];
  const dropped: KeytermDrop[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length === 0) {
      dropped.push({ term: raw, reason: "empty" });
    } else if (term.length > MAX_KEYTERM_CHARS) {
      dropped.push({ term, reason: "too-long" });
    } else if (seen.has(term.toLowerCase())) {
      dropped.push({ term, reason: "duplicate" });
    } else if (kept.length >= MAX_KEYTERMS) {
      dropped.push({ term, reason: "over-cap" });
    } else {
      seen.add(term.toLowerCase());
      kept.push(term);
    }
  }
  return { terms: kept, dropped };
}

/** One line naming what was dropped and why, or `undefined` when nothing was. */
export function describeKeytermDrops(dropped: readonly KeytermDrop[]): string | undefined {
  if (dropped.length === 0) return;
  const byReason = new Map<KeytermDropReason, string[]>();
  for (const drop of dropped) {
    const list = byReason.get(drop.reason) ?? [];
    list.push(drop.term);
    byReason.set(drop.reason, list);
  }
  return [...byReason]
    .map(([reason, terms]) => `${reason}: ${terms.map((t) => JSON.stringify(t)).join(", ")}`)
    .join("; ");
}
