import { armTimeUpLine, BETWEEN_ROUNDS, gameFlow } from "../game.ts";
import { currentWord, GAME_SECONDS, gameSlot, score, WORDS_PER_GAME } from "../shared.ts";
import { pickWords } from "../words.ts";

/**
 * Start a round — their `on_client_connected`, which pushed `INTRO_MESSAGE` and
 * started the `GameTimer`. The intro comes back as a string to read verbatim
 * (their host was told the exact sentence too), entering `playing` is what
 * arms the two-minute deadline, and `armTimeUpLine` is their timer's spoken
 * "Time's up".
 *
 * Legal between rounds only: a round in progress cannot be restarted from
 * under the describer, and a second call there is refused with `playing`'s
 * own instruction.
 */
export default gameSlot.updateTool({
  description:
    "Start a round of Word Wrangler: picks the words, starts the two-minute clock, and hands you " +
    "the exact introduction to read. Call it when the caller says they are ready, and again for " +
    "another round once the previous one is over.",
  dialog: gameFlow,
  when: BETWEEN_ROUNDS,
  send: { type: "STARTED" },
  execute: (_args, game, ctx) => {
    // Through the slot's own fresh default rather than a second list of
    // fields to zero: a field added to `GameState` was otherwise reset in one
    // place and left standing here, surviving into the next round.
    const best = Math.max(game.best, score(game));
    const startedAt = ctx.now();
    Object.assign(game, gameSlot.create(), {
      words: pickWords(WORDS_PER_GAME, ctx.random),
      startedAt,
      best,
    });
    armTimeUpLine(ctx, startedAt);
    const word = currentWord(game) ?? "";
    return {
      word,
      secondsOnTheClock: GAME_SECONDS,
      wordsInRound: game.words.length,
      intro:
        "Welcome to Word Wrangler! I'll give you words to describe, and the A.I. player will " +
        "try to guess them. Remember, don't say any part of the word itself. Here's your first " +
        `word: ${word}.`,
      next: "Read the intro word for word, then wait for the describer.",
    };
  },
});
