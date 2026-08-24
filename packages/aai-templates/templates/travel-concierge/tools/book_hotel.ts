import { z } from "zod";
import { requireDesk, stageAction, tripSlot } from "../shared.ts";

/** SENSITIVE — their `book_hotel`, staged rather than applied. */
export default tripSlot.updateTool({
  description:
    "The HOTEL DESK's booking tool: hold a hotel room. Only usable while the call is at " +
    "that desk. This does NOT book anything yet — it stages the booking so you can read " +
    "the total back and hear a yes.",
  inputSchema: z.object({
    hotelId: z.string().max(20).describe("The hotel id from search_hotels, e.g. 'H1'"),
    nights: z.number().int().min(1).max(30).describe("How many nights"),
  }),
  execute(args, trip, ctx) {
    const offDesk = requireDesk(trip, "hotel");
    if (offDesk) return offDesk;
    return stageAction(ctx, trip, {
      kind: "book_hotel",
      hotelId: args.hotelId.toUpperCase(),
      nights: args.nights,
    });
  },
});
