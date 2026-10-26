import { toolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { gameSlot, SCAVENGER_CHANCE, SCAVENGER_FLAG } from "../shared.ts";

export default gameSlot.updateTool({
  description:
    "Drop an item the player is carrying. Answers whether the hooded scavenger was waiting and made off with it.",
  inputSchema: z.object({
    value: z.string().describe("Item name to drop"),
  }),
  // Dropping something the player never took is a sentence for the narrator,
  // not a silent no-op reporting the unchanged inventory.
  require: (game, { value }) =>
    game.inventory.includes(value)
      ? undefined
      : toolFailure(`The player is not carrying ${value}, so there is nothing to drop.`),
  execute(args, game, ctx) {
    game.inventory = game.inventory.filter((i) => i !== args.value);
    const takenByScavenger = ctx.random() < SCAVENGER_CHANCE;
    if (takenByScavenger) game.flags[SCAVENGER_FLAG] = true;
    return { inventory: game.inventory, takenByScavenger };
  },
});
