import { z } from "zod";
import { gameSlot } from "../shared.ts";

export default gameSlot.updateTool({
  description: "Remove an item from the player's inventory.",
  inputSchema: z.object({
    value: z.string().describe("Item name to drop"),
  }),
  execute(args, game) {
    game.inventory = game.inventory.filter((i) => i !== args.value);
    return { inventory: game.inventory };
  },
});
