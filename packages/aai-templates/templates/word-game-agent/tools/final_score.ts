import { withInstruction } from "@alexkroman1/aai";
import { plural } from "@alexkroman1/aai/utils";
import { gameFlow } from "../game.ts";
import { gameSlot, score, tally } from "../shared.ts";

/**
 * Close the round and read the score — their `GameTimer`'s "Time's up! ... Your
 * final score is N points" line, from the number the tools kept rather than
 * from one the host was asked to remember.
 *
 * Legal only in `over`, which the clock (or the last word) reaches. Calling it
 * is also what stamps `endedAt`, so the scoreboard's phase and the dialog's
 * position agree.
 */
export default gameSlot.updateTool({
  description:
    "The round is over: close it and get the final score, the words solved, skipped and " +
    "forfeited, and the session's best. Announce the score in one sentence and offer another round.",
  dialog: gameFlow,
  when: "over",
  execute: (_args, game, ctx) => {
    game.endedAt ??= ctx.now();
    const points = score(game);
    game.best = Math.max(game.best, points);
    const solved = game.rounds.filter((r) => r.outcome === "solved").map((r) => r.word);
    return withInstruction(
      {
        score: points,
        best: game.best,
        newBest: points > 0 && points === game.best && game.rounds.length > 0,
        solved,
        skipped: tally(game, "skipped"),
        fouled: tally(game, "fouled"),
      },
      `Time's up! Thank you for playing Word Wrangler. Your final score is ${points} ${plural(points, "point")}. Great job!`,
    );
  },
});
