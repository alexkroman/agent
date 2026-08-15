import { z } from "zod";
import { gameSlot } from "../shared.ts";

export default gameSlot.updateTool({
  description: "Set a game flag to true, used for tracking puzzle and event state.",
  inputSchema: z.object({
    value: z.string().describe("Flag name to set"),
  }),
  execute(args, game) {
    game.flags[args.value] = true;
    return { flags: game.flags };
  },
});
