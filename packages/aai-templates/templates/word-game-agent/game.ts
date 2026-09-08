/**
 * Where the game IS, as a dialog — and the game clock, which is the reason this
 * template needs `agent({ dialogs })`.
 *
 * Their `GameTimer` was an `asyncio.sleep(GAME_DURATION_SECONDS)` that queued a
 * "Time's up" `TTSSpeakFrame` and an `EndFrame`. A dialog `timeout` is that
 * sleep as a declaration: `playing` may last two minutes, and when it has, the
 * runtime sends `TIME_UP` and the conversation is in `over`, where the only legal
 * move is to read the score.
 *
 * **`playing` declares no transition on anything but the two ways out, and that
 * is the clock's whole correctness.** The deadline clock runs from the dialog's
 * last MOVE (`packages/aai-runtime/DIALOG-CLAUDE.md`), so a state that moved on
 * every guess — a self transition on `@user-transcript.committed`, say — would
 * re-arm the two minutes on every sentence and the round would never end. The
 * tools that run during a round (`relay_description`, `skip_word`, `repeat_word`)
 * therefore send NOTHING; they read and write the slot and leave the position
 * alone. That is the opposite of `roadside-assistance-agent`'s silence ladder, and the
 * same rule read the other way.
 *
 * **Time's up is announced a turn late, and that is a property of deadlines.** A
 * fired deadline moves the dialog and pushes the new instruction; it does not
 * make the agent speak. The describer, still describing, is answered by a
 * `relay_description` REFUSAL quoting `over`'s instruction — which is what tells
 * the host to call `final_score` and read the score. `relay_description` also
 * checks the clock itself, for the process that restarted mid-round and lost
 * the timer.
 */

import type { AnyDialog, DialogEvent } from "@alexkroman1/aai";
import { dialog } from "@alexkroman1/aai";
import { GAME_SECONDS } from "./shared.ts";

const gameSpec = {
  initial: "lobby",
  states: {
    lobby: {
      instruction:
        "No round is running. Explain the game in two sentences if the caller is new - you " +
        "give a word, they describe it without saying it, the A.I. player guesses, two minutes " +
        "on the clock - and call start_game the moment they say they are ready. Read the intro " +
        "start_game returns word for word.",
      on: { STARTED: "playing" },
    },
    playing: {
      instruction:
        "A round is running and the clock is ticking. Every time the describer says something " +
        "about the word, call relay_description with their words as close to verbatim as you can " +
        "- the player only hears what you pass. Never guess yourself, never hint, never say the " +
        "word. Relay the player's remark in your own voice. On a correct guess, announce the point, " +
        "the score and the next word; on a wrong one, just the remark, briefly. 'Skip' or 'pass' " +
        "is skip_word; 'repeat' or 'what was my word' is repeat_word. Keep every reply to one " +
        "short sentence - the clock is the describer's.",
      timeout: { afterMs: GAME_SECONDS * 1000, send: "TIME_UP" },
      // A describer talks over the host's remark constantly, and should be able
      // to: the host's lines are one sentence and the clock is theirs.
      bargeIn: { minWords: 1 },
      on: { TIME_UP: "over", WORDS_DONE: "over" },
    },
    over: {
      instruction:
        "Time is up, or the words ran out. Call final_score, then announce the final score in " +
        "one sentence - the number of points, and their best if this beat it - and offer another " +
        "round. start_game starts one.",
      on: { STARTED: "playing" },
    },
  },
} as const;

/** The round's position, on its own slot key beside `gameSlot`. */
export const gameFlow = dialog("round", gameSpec);

/** What `agent({ dialogs })` is handed — the line that arms the clock. */
export const DIALOGS: readonly AnyDialog[] = [gameFlow];

/**
 * The round's whole event vocabulary, read off the spec rather than retyped:
 * `STARTED`, `TIME_UP`, `WORDS_DONE`.
 *
 * {@link DialogEvent} is what makes it one declaration instead of a union a
 * tool re-spells every time it names an event, and what makes a tool that
 * returns `next: "WORDS_DUNE"` a compile error where the RESULT is built rather
 * than only where `sendFrom` reads it.
 */
export type GameEvent = DialogEvent<typeof gameSpec>;

/**
 * The `sendFrom` the two tools that can END a round share.
 *
 * Both `relay_description` and `skip_word` decide the move inside their
 * `slot.update` window — they know whether that was the last word — and carry
 * it out as a `next` field. Nothing else in the result is the dialog's business,
 * and `undefined` there means STAY PUT, which is the property the clock rests
 * on: a move re-arms `playing`'s two minutes, so a tool that moved on every
 * guess would make the round endless.
 */
export function endsRound(result: {
  // `| undefined` and not just `?`: under `exactOptionalPropertyTypes` a result
  // that WRITES `next: undefined` — which both callers do, in the ternary that
  // decides whether that was the last word — is not an absent property.
  next?: GameEvent["type"] | undefined;
}): GameEvent | undefined {
  return result.next === undefined ? undefined : { type: result.next };
}

/** Where a round can be started from: before the first, and after any. */
export const BETWEEN_ROUNDS = ["lobby", "over"] as const;
