import { z } from "zod";
import { BETWEEN_ROUNDS, gameFlow } from "../game.ts";
import { currentWord, GAME_SECONDS, gameSlot, WORDS_PER_GAME } from "../shared.ts";
import { pickWords } from "../words.ts";

/**
 * Start a round — their `on_client_connected`, which pushed `INTRO_MESSAGE` and
 * started the `GameTimer`. The intro comes back as a string to read verbatim
 * (their host was told the exact sentence too), and entering `playing` is what
 * arms the two-minute deadline.
 *
 * Legal between rounds only: a round in progress cannot be restarted from
 * under the describer, and a second call there is refused with `playing`'s
 * own instruction.
 */
export default gameFlow.tool({
  description:
    "Start a round of Word Wrangler: picks the words, starts the two-minute clock, and hands you " +
    "the exact introduction to read. Call it when the caller says they are ready, and again for " +
    "another round once the previous one is over.",
  when: BETWEEN_ROUNDS,
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    gameSlot.update(ctx, (game) => {
      const best = Math.max(game.best, game.score);
      game.words = pickWords(WORDS_PER_GAME);
      game.index = 0;
      game.score = 0;
      game.skips = 0;
      game.fouls = 0;
      game.startedAt = Date.now();
      game.endedAt = null;
      game.descriptions = [];
      game.wrongGuesses = [];
      game.rounds = [];
      game.best = best;
      game.lastRemark = null;
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
    }),
  send: { type: "STARTED" },
});
