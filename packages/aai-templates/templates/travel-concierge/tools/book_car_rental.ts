import { z } from "zod";
import { requireDesk, stageAction, tripSlot } from "../shared.ts";

/** SENSITIVE — their `book_car_rental`, staged rather than applied. */
export default tripSlot.updateTool({
  description:
    "The CAR RENTAL DESK's booking tool: reserve a rental car. Only usable while the call " +
    "is at that desk. This does NOT reserve anything yet — it stages the reservation so " +
    "you can read the total back and hear a yes.",
  inputSchema: z.object({
    carId: z.string().max(20).describe("The car id from search_car_rentals, e.g. 'C2'"),
    days: z.number().int().min(1).max(60).describe("How many days"),
  }),
  execute(args, trip, ctx) {
    const offDesk = requireDesk(trip, "car_rental");
    if (offDesk) return offDesk;
    return stageAction(ctx, trip, {
      kind: "book_car",
      carId: args.carId.toUpperCase(),
      days: args.days,
    });
  },
});
