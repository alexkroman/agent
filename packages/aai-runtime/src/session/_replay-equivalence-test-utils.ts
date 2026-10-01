// Copyright 2026 the AAI authors. MIT license.
/**
 * The message vocabulary `history-replay-equivalence.test.ts` classifies
 * by — split out of that spec at the test-file length cap. Data and three pure
 * readers; the argument for the classification is in the spec's module doc.
 */

import type { Message } from "@alexkroman1/aai";

/**
 * Every message this driver can produce, keyed by the first character of its
 * text, so a message's PROVENANCE is readable off the message itself.
 *
 * The classification is what makes the boundary assertable without either
 * implementation being consulted about it: a leaked `[interrupted]` reply is a
 * `k` where only `u`/`a`/`g` may appear.
 */
export const KIND = {
  /** A committed user turn. Both sides. */
  user: "u",
  /** A spoken reply. Both sides. */
  reply: "a",
  /** The greeting. Both sides. */
  greeting: "g",
  /** An injected prompt (resume / nudge / `injectTurn`). LIVE ONLY. */
  synthetic: "s",
  /** The heard prefix of an interrupted reply. LIVE ONLY. */
  interrupted: "k",
  /** `errorPhrase`. NEITHER side, since the `recovery` tag. */
  errorPhrase: "e",
  /** `startFailurePhrase`. NEITHER side, since the `recovery` tag. */
  startFailure: "f",
  /** A `userTranscript.updated` partial. NEITHER side. */
  userPartial: "p",
  /**
   * An `agentTranscript.updated` interim. NEITHER side.
   *
   * Tagged distinctly from the committed text it precedes, which is the
   * FAITHFUL choice and not a convenience: interim snapshots "legitimately
   * shrink and differ mid-string", and an interrupted reply's carry the dead-air
   * filler the caller heard and the record excludes
   * (`session-event-history.ts:16-21`).
   */
  agentInterim: "i",
} as const;

export const SHARED_KINDS: ReadonlySet<string> = new Set([KIND.user, KIND.reply, KIND.greeting]);
export const LIVE_ONLY_KINDS: ReadonlySet<string> = new Set([KIND.synthetic, KIND.interrupted]);
/**
 * The two recovery phrases. Named for the boundary they USED to sit on: both are
 * now spoken and captioned but enter no history, so what either reconstruction
 * contains of this set must be EMPTY. Kept as a live assertion rather than
 * deleted — an untagged phrase would land back here, which is the regression.
 */
export const REPLAY_ONLY_KINDS: ReadonlySet<string> = new Set([
  KIND.errorPhrase,
  KIND.startFailure,
]);
/** The interim vocabulary, which neither reconstruction may ever contain. */
export const INTERIM_KINDS: ReadonlySet<string> = new Set([KIND.userPartial, KIND.agentInterim]);

/** Fixed, because both phrases are session-scoped config rather than per-turn text. */
export const ERROR_PHRASE = `${KIND.errorPhrase} sorry, I had trouble with that`;
export const START_FAILURE_PHRASE = `${KIND.startFailure} I cannot start this call`;

export const kindOf = (m: Message): string => m.content.slice(0, 1);
export const contentsOf = (msgs: readonly Message[]): string[] => msgs.map((m) => m.content);
export const keep = (msgs: readonly Message[], kinds: ReadonlySet<string>): Message[] =>
  msgs.filter((m) => kinds.has(kindOf(m)));
