import { z } from "zod";
import { gameSlot } from "../shared.ts";

export default gameSlot.tool({
  description: "Add an item to the player's inventory.",
  inputSchema: z.object({
    value: z.string().describe("Item name to take"),
  }),
  execute(args, game) {
    if (!game.inventory.includes(args.value)) game.inventory.push(args.value);
    return { inventory: game.inventory };
  },
});
