import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { gameFlow } from "../game.ts";
import { currentWord, gameSlot, secondsLeft } from "../shared.ts";

/** Their host's rule 7: "repeat" or "what was that?" — the current word, nothing else. */
export default gameFlow.tool({
  description:
    "The describer asked to hear their word again. Returns the current word - say ONLY 'Your word " +
    "is X', nothing more. The score does not change.",
  when: "playing",
  inputSchema: z.object({}),
  execute: (_args, ctx) => {
    const game = gameSlot.get(ctx);
    const word = currentWord(game);
    if (word === null) return toolFailure("No word is in play - start_game starts a round.");
    return { word, secondsLeft: secondsLeft(game), say: `Your word is ${word}.` };
  },
});
