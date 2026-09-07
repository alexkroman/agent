import { plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { gameFlow } from "../game.ts";
import { gameSlot } from "../shared.ts";

/**
 * Close the round and read the score — their `GameTimer`'s "Time's up! ... Your
 * final score is N points" line, from the number the tools kept rather than
 * from one the host was asked to remember.
 *
 * Legal only in `over`, which the clock (or the last word) reaches. Calling it
 * is also what stamps `endedAt`, so the scoreboard's phase and the dialog's
 * position agree.
 */
export default gameFlow.tool({
  description:
    "The round is over: close it and get the final score, the words solved, skipped and " +
    "forfeited, and the session's best. Announce the score in one sentence and offer another round.",
  when: "over",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    gameSlot.update(ctx, (game) => {
      game.endedAt ??= Date.now();
      game.best = Math.max(game.best, game.score);
      const solved = game.rounds.filter((r) => r.outcome === "solved").map((r) => r.word);
      const points = game.score;
      return {
        score: points,
        best: game.best,
        newBest: points > 0 && points === game.best && game.rounds.length > 0,
        solved,
        skipped: game.skips,
        fouled: game.fouls,
        say: `Time's up! Thank you for playing Word Wrangler. Your final score is ${points} ${plural(points, "point")}. Great job!`,
      };
    }),
});
