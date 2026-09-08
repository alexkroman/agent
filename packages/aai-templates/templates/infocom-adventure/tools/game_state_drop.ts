import { toolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { gameSlot, SCAVENGER_CHANCE, SCAVENGER_FLAG } from "../shared.ts";

export default gameSlot.updateTool({
  description:
    "Drop an item the player is carrying. Answers whether the hooded scavenger was waiting and made off with it.",
  inputSchema: z.object({
    value: z.string().describe("Item name to drop"),
  }),
  execute(args, game, ctx) {
    // A drop of something the player never took used to answer with the
    // unchanged inventory, leaving the narrator to notice the item was missing
    // from a list it had asked a different question of. A `ToolFailure` is the
    // SDK's way to say the sentence instead — recoverable, model-facing, and
    // nothing is written on this path.
    if (!game.inventory.includes(args.value)) {
      return toolFailure(`The player is not carrying ${args.value}, so there is nothing to drop.`);
    }
    game.inventory = game.inventory.filter((i) => i !== args.value);

    // `ctx.random` rather than `Math.random`: in production it IS the global,
    // and what it buys is a spec that can state which turns the scavenger took
    // something instead of asserting a range.
    const takenByScavenger = ctx.random() < SCAVENGER_CHANCE;
    if (takenByScavenger) game.flags[SCAVENGER_FLAG] = true;
    return { inventory: game.inventory, takenByScavenger };
  },
});
