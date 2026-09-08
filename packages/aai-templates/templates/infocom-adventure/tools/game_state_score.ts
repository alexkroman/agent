import { z } from "zod";
import { gameSlot, rankFor } from "../shared.ts";

export default gameSlot.updateTool({
  description:
    "Add points to the player's score. Answers with the new total and the player's rank.",
  inputSchema: z.object({
    value: z.number().describe("Points to add"),
  }),
  execute(args, game) {
    game.score += args.value;
    // `rankFor(game.score)`, NOT `game.rank`: the slot's `after` hook has not
    // run yet — `update` calls the body first and the hook afterwards — so the
    // stored field still holds the rank the player had before this point
    // landed. That is exactly the turn a rank changes on, so reading the field
    // here would announce a promotion one scoring call late.
    return { score: game.score, rank: rankFor(game.score) };
  },
});
