import { z } from "zod";
import { deskGate, gateFlow, stageAction, tripSlot } from "../shared.ts";

/** SENSITIVE — their `book_car_rental`, staged rather than applied. */
export default tripSlot.updateTool({
  description:
    "The CAR RENTAL DESK's booking tool: reserve a rental car. Only usable while the call " +
    "is at that desk. This does NOT reserve anything yet — it stages the reservation so " +
    "you can read the total back and hear a yes.",
  ui: { icon: "\u{1F511}", label: "Staging car" },
  dialog: gateFlow,
  send: { type: "STAGED" },
  require: deskGate("car_rental"),
  inputSchema: z.object({
    carId: z.string().max(20).describe("The car id from search_car_rentals, e.g. 'C2'"),
    days: z.number().int().min(1).max(60).describe("How many days"),
  }),
  execute: (args, trip) =>
    stageAction(trip, { kind: "book_car", carId: args.carId.toUpperCase(), days: args.days }),
});
