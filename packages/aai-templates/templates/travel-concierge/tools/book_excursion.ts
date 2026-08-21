import { z } from "zod";
import { stageAction, tripSlot } from "../shared.ts";

/** SENSITIVE — their `book_excursion`, staged rather than applied. */
export default tripSlot.updateTool({
  description:
    "Book an excursion. This does NOT book anything yet — it stages the " +
    "booking so you can read it back and hear a yes.",
  inputSchema: z.object({
    excursionId: z.string().max(20).describe("The excursion id from search_excursions, e.g. 'E2'"),
  }),
  execute(args, trip) {
    return stageAction(trip, {
      kind: "book_excursion",
      excursionId: args.excursionId.toUpperCase(),
    });
  },
});
