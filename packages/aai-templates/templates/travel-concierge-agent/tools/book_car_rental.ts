import { z } from "zod";
import { deskUpdateTool, stageAction } from "../shared.ts";

/** SENSITIVE — their `book_car_rental`, staged rather than applied. */
export default deskUpdateTool("car_rental", {
  description:
    "The CAR RENTAL DESK's booking tool: reserve a rental car. Only usable while the call " +
    "is at that desk. This does NOT reserve anything yet — it stages the reservation so " +
    "you can read the total back and hear a yes.",
  inputSchema: z.object({
    carId: z.string().max(20).describe("The car id from search_car_rentals, e.g. 'C2'"),
    days: z.number().int().min(1).max(60).describe("How many days"),
  }),
  execute(args, trip, ctx) {
    return stageAction(ctx, trip, {
      kind: "book_car",
      carId: args.carId.toUpperCase(),
      days: args.days,
    });
  },
});
