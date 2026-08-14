import { z } from "zod";
import { stageAction, tripSlot } from "../shared.ts";

/** SENSITIVE — their `book_car_rental`, staged rather than applied. */
export const bookCarRental = tripSlot.tool({
  description:
    "Reserve a rental car. This does NOT reserve anything yet — it stages the " +
    "reservation so you can read the total back and hear a yes.",
  inputSchema: z.object({
    carId: z.string().max(20).describe("The car id from search_car_rentals, e.g. 'C2'"),
    days: z.number().int().min(1).max(60).describe("How many days"),
  }),
  execute(args, trip) {
    return stageAction(trip, {
      kind: "book_car",
      carId: args.carId.toUpperCase(),
      days: args.days,
    });
  },
});
