// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a `Turn` event: the two word-confidence statistics, and which turn
 * counts as the COMMIT when the service is formatting.
 *
 * Both are pure functions over the event shape rather than branches inside the
 * opener's handler, because both are policy: what "the recognizer's confidence
 * in this turn" means, and what "this turn is over" means when one turn
 * produces two finals.
 */

/**
 * The turn fields this module reads, as the service sends them.
 *
 * Declared here rather than imported from the `assemblyai` SDK because the two
 * do not agree: `TurnEvent.words` is typed non-optional there, and a turn with
 * no words at all is a real message (every fixture in this repo has one), so a
 * reader that trusts the declaration crashes on `.length` of `undefined`.
 * Everything is optional and guarded at the use site.
 */
export interface AssemblyAITurnLike {
  readonly transcript?: string | undefined;
  readonly end_of_turn?: boolean | undefined;
  readonly turn_is_formatted?: boolean | undefined;
  readonly words?: readonly { readonly confidence?: unknown }[] | undefined;
}

/**
 * Does this end-of-turn event COMMIT the turn, or is a better one coming?
 *
 * With `format_turns` on, `universal-streaming-english` sends **two**
 * `end_of_turn: true` messages for one `turn_order` — the unformatted
 * transcript first, the formatted one right after — and AssemblyAI's own
 * message-sequence guide says to treat a turn as complete only when
 * `end_of_turn` and `turn_is_formatted` are both true, "or you'll process
 * every turn twice". Twice here is not a cosmetic double: each would commit a
 * user turn, so the model would answer the same sentence two times, the second
 * one on a history that already contains its own reply.
 *
 * So when the session asked for formatting, the unformatted final is demoted
 * to a PARTIAL — the caption still updates with it, and the commit waits for
 * the formatted text, which is the whole point of asking. `awaitingFormatted`
 * is false for every other session (including every `universal-3-5-pro` one,
 * where formatting is always on and a single final arrives already formatted),
 * and then this is exactly `end_of_turn`.
 */
export function isCommittingTurn(event: AssemblyAITurnLike, awaitingFormatted: boolean): boolean {
  if (event.end_of_turn !== true) return false;
  return !awaitingFormatted || event.turn_is_formatted === true;
}
