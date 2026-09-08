import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { endsRound, gameFlow } from "../game.ts";
import { advanceWord, currentWord, gameSlot, score } from "../shared.ts";

/**
 * Their host's rule 6: "skip" or "pass" gets a new word, and the score does not
 * change. Unlimited, as on the phone (their web client capped it at three).
 */
export default gameFlow.tool({
  description:
    "The describer said skip, pass, or next: move to the next word without a point. The result " +
    "carries the new word to give them.",
  when: "playing",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    gameSlot.update(ctx, (game) => {
      const skipped = advanceWord(game, "skipped");
      if (skipped === null) return toolFailure("No word is in play - start_game starts a round.");
      game.lastRemark = null;
      const nextWord = currentWord(game);
      return {
        skipped,
        nextWord,
        score: score(game),
        next: nextWord === null ? ("WORDS_DONE" as const) : undefined,
        say: nextWord === null ? "That was the last word." : `The new word is ${nextWord}.`,
      };
    }),
  sendFrom: (result) => endsRound(result),
});
